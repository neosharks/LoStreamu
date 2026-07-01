// ── Download queue domain types ──────────────────────────────────────────────
// Pure types + the engine contract. No I/O, no yt-dlp, no Express here — this is
// the seam that lets the queue be unit-tested with a fake engine.

export type QueueState =
  | 'queued'       // waiting for its turn
  | 'preparing'    // fetching metadata / resolving formats
  | 'downloading'  // transferring media
  | 'processing'   // post-processing (merge/remux)
  | 'paused'       // stopped by user, resumable (keeps partial file)
  | 'completed'    // finished, file written
  | 'failed'       // errored — isolated, does not stop the queue
  | 'cancelled';   // removed by user

// States where the engine is actively working on the item.
export const ACTIVE_STATES: readonly QueueState[] = ['preparing', 'downloading', 'processing'];
// States that are "done" — the queue will not touch these again.
export const TERMINAL_STATES: readonly QueueState[] = ['completed', 'failed', 'cancelled'];
// States eligible to be (re)started by the processor.
export const RUNNABLE_STATES: readonly QueueState[] = ['queued'];

export function isTerminal(s: QueueState): boolean { return TERMINAL_STATES.includes(s); }
export function isActive(s: QueueState): boolean { return ACTIVE_STATES.includes(s); }

// What the caller provides when enqueuing. The folder is snapshotted here so a
// later change to the "current folder" in the UI never moves already-queued items.
export interface EnqueueInput {
  url: string;
  folder: string;   // relative destination folder (for display)
  destAbs: string;   // absolute destination path, resolved & snapshotted at enqueue time
  filename?: string; // optional explicit output filename (no extension)
  groupId?: string;    // playlist grouping — items sharing a groupId belong together
  groupTitle?: string; // playlist title, for the group header
}

// A single unit of work. Carries enough metadata that a retry is just a re-run
// of the same item — no external state needed.
export interface QueueItem {
  id: string;
  // ── immutable task definition (snapshotted at enqueue) ──
  url: string;
  folder: string;
  destAbs: string;
  filename?: string;
  groupId?: string;
  groupTitle?: string;
  // ── metadata (filled during "preparing") ──
  title: string;
  uploader?: string;
  thumbUrl?: string;
  // ── live state ──
  state: QueueState;
  progress: number;   // 0–100
  speed?: string;
  eta?: string;
  error?: string;
  attempts: number;   // increments each run; supports retry accounting
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

// ── Engine contract ──────────────────────────────────────────────────────────
// The queue drives the engine through this interface only. Swap in a mock for
// tests, the yt-dlp engine in production.

export interface EngineHooks {
  onPrepared(meta: { title?: string; uploader?: string; thumbUrl?: string }): void;
  onProgress(p: { progress?: number; speed?: string; eta?: string }): void;
  onProcessing(): void;
}

export type EngineOutcome = 'completed' | 'failed' | 'cancelled' | 'paused';

export interface EngineResult {
  status: EngineOutcome;
  error?: string;
}

export interface EngineHandle {
  // Stop the running download. `kind` distinguishes user cancel from pause so the
  // result resolves to 'cancelled' vs 'paused'.
  stop(kind: 'cancel' | 'pause'): void;
  // Resolves exactly once when the run settles. Never rejects — the engine maps
  // all failures into { status: 'failed', error }.
  done: Promise<EngineResult>;
}

export interface DownloadEngine {
  run(item: QueueItem, hooks: EngineHooks): EngineHandle;
}

export class DuplicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateError';
  }
}
