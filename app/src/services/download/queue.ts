import { EventEmitter } from 'events';
import crypto from 'crypto';
import type {
  DownloadEngine, EngineHandle, EngineResult, EnqueueInput, QueueItem, QueueState,
} from './types';
import { DuplicateError, isTerminal } from './types';
import { saveQueue, saveQueueSync, loadQueue } from './persistence';

export interface QueueOptions {
  engine: DownloadEngine;
  persist?: boolean;                    // load/save to disk (default true)
  autoStart?: boolean;                  // begin processing restored items (default true)
  concurrency?: number;                 // active downloads at once (default 1)
  blockCompletedDuplicates?: boolean;   // reject a URL that already completed (default true)
  idFactory?: () => string;             // injectable for deterministic tests
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

// Centralized, race-safe download queue. Owns ALL queue business logic; the HTTP
// layer and UI only issue commands and observe 'change' events. The engine is
// injected, so this class is fully unit-testable without yt-dlp.
export class DownloadQueue extends EventEmitter {
  private items = new Map<string, QueueItem>();
  private order: string[] = [];
  private handles = new Map<string, EngineHandle>();
  private activeIds = new Set<string>();

  // Processor guards. `pumping` ensures a single processor loop; `pumpRequested`
  // captures wake-ups that arrive while the loop is mid-await (no lost wake-ups).
  private pumping = false;
  private pumpRequested = false;

  // Progress emits are coalesced to a few per second so a downloading item's
  // frequent progress lines don't flood SSE subscribers / churn the event loop
  // while a video is streaming.
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly EMIT_INTERVAL_MS = 250;

  private readonly engine: DownloadEngine;
  private readonly persist: boolean;
  private readonly concurrency: number;
  private readonly blockCompletedDuplicates: boolean;
  private readonly newId: () => string;

  constructor(opts: QueueOptions) {
    super();
    this.engine = opts.engine;
    this.persist = opts.persist ?? true;
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.blockCompletedDuplicates = opts.blockCompletedDuplicates ?? true;
    this.newId = opts.idFactory ?? (() => crypto.randomBytes(8).toString('hex'));

    if (this.persist) {
      const { order, items } = loadQueue();
      this.order = order;
      for (const it of items) this.items.set(it.id, it);
    }
    if ((opts.autoStart ?? true)) this.pump();
  }

  // ── Reads ────────────────────────────────────────────────────────────────
  list(): QueueItem[] {
    return this.order.map(id => this.items.get(id)).filter((i): i is QueueItem => !!i);
  }
  get(id: string): QueueItem | undefined { return this.items.get(id); }

  // Synchronously persist current state — call on process exit so the last
  // mutation survives an abrupt restart (bypasses the debounce).
  flush(): void { if (this.persist) saveQueueSync(this.order, this.list()); }

  // ── Enqueue (atomic, with duplicate detection) ─────────────────────────────
  // Synchronous end-to-end: the dup check and the mutation happen in one tick, so
  // rapid repeated calls can never interleave and create inconsistent state.
  enqueue(input: EnqueueInput): QueueItem {
    const dup = this.findDuplicate(input.url);
    if (dup) throw new DuplicateError(this.duplicateMessage(dup.state));

    const now = Date.now();
    const item: QueueItem = {
      id: this.newId(),
      url: input.url.trim(),
      folder: input.folder,
      destAbs: input.destAbs,
      filename: input.filename,
      title: 'Fetching info…',
      state: 'queued',
      progress: 0,
      attempts: 0,
      createdAt: now,
    };
    this.items.set(item.id, item);
    this.order.push(item.id);
    this.commit();
    this.pump();
    return item;
  }

  // Bulk add (e.g. a playlist). Duplicates are skipped, not fatal.
  enqueueMany(inputs: EnqueueInput[]): { added: QueueItem[]; duplicates: number } {
    const added: QueueItem[] = [];
    let duplicates = 0;
    for (const input of inputs) {
      try { added.push(this.enqueue(input)); }
      catch (e) { if (e instanceof DuplicateError) duplicates++; else throw e; }
    }
    return { added, duplicates };
  }

  private findDuplicate(url: string): QueueItem | undefined {
    const norm = normalizeUrl(url);
    return this.list().find(it => {
      if (normalizeUrl(it.url) !== norm) return false;
      if (!isTerminal(it.state)) return true;                          // queued/active/paused
      if (it.state === 'completed') return this.blockCompletedDuplicates;
      return false;                                                    // failed/cancelled → allow re-add
    });
  }

  private duplicateMessage(state: QueueState): string {
    if (state === 'downloading' || state === 'preparing' || state === 'processing')
      return 'This URL is already downloading.';
    if (state === 'completed') return 'This URL has already been downloaded.';
    if (state === 'paused') return 'This URL is already in the queue (paused).';
    return 'This URL is already in the queue.';
  }

  // ── Commands ───────────────────────────────────────────────────────────────
  cancel(id: string): boolean {
    const item = this.items.get(id);
    if (!item || isTerminal(item.state)) return false;
    if (this.activeIds.has(id)) {
      this.handles.get(id)?.stop('cancel'); // engine settles → 'cancelled' → pumps next
    } else {
      this.finish(item, { status: 'cancelled', error: 'Cancelled' });
      this.pump();
    }
    return true;
  }

  pause(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    if (this.activeIds.has(id)) { this.handles.get(id)?.stop('pause'); return true; }
    if (item.state === 'queued') { item.state = 'paused'; this.commit(); return true; }
    return false;
  }

  resume(id: string): boolean {
    const item = this.items.get(id);
    if (!item || item.state !== 'paused') return false;
    item.state = 'queued';
    this.commit();
    this.pump();
    return true;
  }

  // Retry re-runs the SAME item — all task metadata is already stored on it.
  retry(id: string): boolean {
    const item = this.items.get(id);
    if (!item || (item.state !== 'failed' && item.state !== 'cancelled')) return false;
    item.state = 'queued';
    item.progress = 0;
    item.error = undefined;
    item.finishedAt = undefined;
    this.commit();
    this.pump();
    return true;
  }

  remove(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    if (this.activeIds.has(id)) this.handles.get(id)?.stop('cancel');
    this.items.delete(id);
    this.order = this.order.filter(x => x !== id);
    this.activeIds.delete(id);
    this.handles.delete(id);
    this.commit();
    this.pump();
    return true;
  }

  clearFinished(): number {
    const before = this.order.length;
    for (const item of this.list()) {
      if (isTerminal(item.state)) { this.items.delete(item.id); }
    }
    this.order = this.order.filter(id => this.items.has(id));
    this.commit();
    return before - this.order.length;
  }

  // Reorder a queued item (drag-and-drop / manual ordering).
  reorder(id: string, toIndex: number): boolean {
    const from = this.order.indexOf(id);
    if (from === -1) return false;
    const clamped = Math.max(0, Math.min(this.order.length - 1, toIndex));
    this.order.splice(from, 1);
    this.order.splice(clamped, 0, id);
    this.commit();
    this.pump();
    return true;
  }

  // Bump an item to the front of the waiting section (priority).
  prioritize(id: string): boolean {
    if (!this.items.has(id)) return false;
    return this.reorder(id, 0);
  }

  // ── Processor ────────────────────────────────────────────────────────────
  // Synchronous and re-entrant. The `pumping` guard prevents two processors from
  // starting the same item; each finished run calls pump() again from its
  // finally, so the next queued item starts automatically. `pumpRequested`
  // captures a pump() that arrives while the start-loop is running.
  private pump(): void {
    if (this.pumping) { this.pumpRequested = true; return; }
    this.pumping = true;
    try {
      while (this.activeIds.size < this.concurrency) {
        const next = this.list().find(i => i.state === 'queued');
        if (!next) break;
        void this.process(next); // async; registers itself in activeIds synchronously
      }
    } finally {
      this.pumping = false;
    }
    if (this.pumpRequested) { this.pumpRequested = false; this.pump(); }
  }

  private async process(item: QueueItem): Promise<void> {
    this.activeIds.add(item.id);
    item.state = 'preparing';
    item.startedAt = Date.now();
    item.attempts++;
    item.error = undefined;
    this.commit();

    try {
      const handle = this.engine.run(item, {
        onPrepared: m => {
          if (m.title) item.title = m.title;
          if (m.uploader) item.uploader = m.uploader;
          if (m.thumbUrl) item.thumbUrl = m.thumbUrl;
          this.touch();
        },
        onProgress: p => {
          if (item.state === 'preparing') item.state = 'downloading';
          if (p.progress != null) item.progress = p.progress;
          if (p.speed !== undefined) item.speed = p.speed;
          if (p.eta !== undefined) item.eta = p.eta;
          this.touch();
        },
        onProcessing: () => { item.state = 'processing'; this.touch(); },
      });
      this.handles.set(item.id, handle);
      const result = await handle.done;
      this.finish(item, result);
    } catch (err) {
      // The engine contract says it never rejects, but isolate any surprise so a
      // single broken item can never take down the processor.
      this.finish(item, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.handles.delete(item.id);
      this.activeIds.delete(item.id);
      this.pump();                 // start the next queued item
    }
  }

  private finish(item: QueueItem, result: EngineResult): void {
    item.speed = undefined;
    item.eta = undefined;
    switch (result.status) {
      case 'completed':
        item.state = 'completed'; item.progress = 100; item.error = undefined;
        item.finishedAt = Date.now();
        break;
      case 'cancelled':
        item.state = 'cancelled'; item.error = 'Cancelled'; item.finishedAt = Date.now();
        break;
      case 'paused':
        item.state = 'paused'; // resumable, not terminal
        break;
      case 'failed':
      default:
        item.state = 'failed'; item.error = result.error || 'Download failed';
        item.finishedAt = Date.now();
        break;
    }
    this.commit();
    if (result.status === 'completed') this.emit('completed', item);
  }

  // ── Emit / persist helpers ─────────────────────────────────────────────────
  // touch: progress-only change — notify observers, throttled to a few per second.
  private touch(): void {
    const now = Date.now();
    if (now - this.lastEmit >= DownloadQueue.EMIT_INTERVAL_MS) {
      this.lastEmit = now;
      this.emit('change');
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.lastEmit = Date.now();
        this.emit('change');
      }, DownloadQueue.EMIT_INTERVAL_MS);
    }
  }
  // commit: structural/state change — persist and notify immediately.
  private commit(): void {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    this.lastEmit = Date.now();
    if (this.persist) saveQueue(this.order, this.list());
    this.emit('change');
  }
}
