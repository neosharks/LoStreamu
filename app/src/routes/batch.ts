import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { rescan, safePath, getMediaRoot, buildMeta } from '../services/library';
import { ytNetArgs, ytSpeedArgs, spawnDownload, fetchPlaylistEntries, netHint, normalizeUrl } from '../services/ytdlp';
import type { BatchJob, BatchItem } from '../types';

const router = Router();
const batches = new Map<string, BatchJob>();

// One download at a time — keeps CPU/network load minimal on small hosts.
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 1;
// Stagger download starts to avoid triggering rate limits.
const STAGGER_MIN_MS = 2000;
const STAGGER_MAX_MS = 5000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function serializeBatch(b: BatchJob) {
  return {
    id: b.id, title: b.title, status: b.status, paused: b.paused,
    done: b.done, total: b.total, concurrency: b.concurrency,
    items: b.items.map(i => ({
      index: i.index, title: i.title, thumbnail: i.thumbnail,
      status: i.status, progress: i.progress,
      speed: i.speed, eta: i.eta, error: i.error,
    })),
  };
}

function broadcastBatch(b: BatchJob): void {
  const payload = JSON.stringify(serializeBatch(b));
  for (const res of b._subs || new Set<Response>()) {
    try { res.write(`event: update\ndata: ${payload}\n\n`); } catch {}
  }
}

function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

// ── Concurrent batch runner ───────────────────────────────────────────────────

async function runBatch(b: BatchJob): Promise<void> {
  b._procs = new Map();
  b._lastStartMs = 0;

  const destAbs = b.folder ? (safePath(b.folder) || getMediaRoot()) : getMediaRoot();
  fs.mkdirSync(destAbs, { recursive: true });

  async function worker(workerIdx: number): Promise<void> {
    // Stagger worker startups so downloads don't all begin at the same moment.
    if (workerIdx > 0) {
      await sleep(workerIdx * (STAGGER_MIN_MS + Math.random() * (STAGGER_MAX_MS - STAGGER_MIN_MS)));
    }

    while (!b._stopReq) {
      // Honour pause — let in-flight items finish, just don't start new ones.
      while (b.paused && !b._stopReq) await sleep(300);
      if (b._stopReq) break;

      // Claim the next pending item. JS is single-threaded: no races here.
      const item = b.items.find(i => i.status === 'pending');
      if (!item) break;
      item.status = 'downloading';
      item.progress = 0;
      delete item.speed; delete item.eta; delete item.error;

      // Inter-download jitter after the first item.
      if (b._lastStartMs! > 0) {
        const gap = STAGGER_MIN_MS + Math.random() * (STAGGER_MAX_MS - STAGGER_MIN_MS);
        const waited = Date.now() - b._lastStartMs!;
        if (waited < gap) await sleep(gap - waited);
      }
      if (b._stopReq) { item.status = 'pending'; break; }
      // Another worker or cancel endpoint may have flipped status while we slept.
      if ((item.status as string) === 'skipped') continue;

      b._lastStartMs = Date.now();
      broadcastBatch(b);

      const isDirectUrl = !!item.url;
      const randomBase = crypto.randomBytes(8).toString('hex');
      const outTpl = path.join(destAbs, randomBase + '.%(ext)s');

      const args = [
        '--newline', '--no-mtime', '--no-warnings', '--continue',
        '--ignore-errors',
        '--download-archive', b.archive,
        ...ytNetArgs(),
        ...ytSpeedArgs(),
        isDirectUrl ? '--no-playlist' : '--yes-playlist',
        ...(isDirectUrl ? [] : ['--playlist-items', String(item.index)]),
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
        '-o', outTpl,
        isDirectUrl ? item.url! : b.url,
      ];

      await new Promise<void>(resolve => {
        const proc = spawnDownload(args);
        b._procs!.set(item.index, proc);

        proc.stdout.on('data', (chunk: Buffer) => {
          for (const line of chunk.toString().split('\n')) {
            if (!line.trim()) continue;
            const pct = line.match(/(\d+\.?\d*)%/);
            if (pct) item.progress = parseFloat(pct[1]);
            const spd = line.match(/at\s+([\d.]+\s*\w+\/s)/);
            if (spd) item.speed = spd[1].trim();
            const eta = line.match(/ETA\s+(\S+)/);
            if (eta) item.eta = eta[1];
          }
          broadcastBatch(b);
        });

        proc.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          const errLine = text.trim().split('\n').find(l => /ERROR/i.test(l));
          if (errLine) item.error = netHint(errLine);
        });

        proc.on('close', (code) => {
          b._procs!.delete(item.index);
          if (item.status !== 'skipped') {
            const ok = code === 0 && !item.error;
            item.status = ok ? 'done' : 'error';
            if (!ok && !item.error) item.error = `yt-dlp exited with code ${code}`;
            if (ok) item.progress = 100;
          }
          delete item.speed; delete item.eta;
          b.done = b.items.filter(i => i.status === 'done').length;
          broadcastBatch(b);
          resolve();
        });
      });
    }
  }

  const concurrency = Math.min(b.concurrency, b.items.length, MAX_CONCURRENCY);
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

  if (b.status !== 'stopped') {
    b.status = b._stopReq ? 'stopped'
      : b.items.some(i => i.status === 'error') ? 'error'
      : 'done';
  }
  broadcastBatch(b);
  rescan();
  buildMeta().catch(() => {});
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post('/playlist/probe', requireAuth, async (req, res) => {
  const url = normalizeUrl(String(req.body?.url || '').trim());
  if (!url) { res.status(400).json({ error: 'url required' }); return; }
  try {
    res.json(await fetchPlaylistEntries(url));
  } catch (err: any) {
    res.status(500).json({ error: netHint(err.message || 'Probe failed') });
  }
});

router.post('/playlist/download', requireAuth, (req, res) => {
  const url = normalizeUrl(String(req.body?.url || '').trim());
  const folder = String(req.body?.folder || '').replace(/^[/\\]+/, '');
  const title = String(req.body?.title || 'Playlist');
  const concurrency = Math.min(
    Math.max(1, parseInt(String(req.body?.concurrency ?? DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY),
    MAX_CONCURRENCY,
  );
  const rawItems: { index: number; title: string; url?: string; thumbnail?: string }[] =
    req.body?.items || [];

  if (!url || !rawItems.length) {
    res.status(400).json({ error: 'url and items required' }); return;
  }

  const destAbs = folder ? (safePath(folder) || getMediaRoot()) : getMediaRoot();
  fs.mkdirSync(destAbs, { recursive: true });

  const id = crypto.randomBytes(8).toString('hex');
  const archive = path.join(destAbs, '.downloaded.txt');

  const items: BatchItem[] = rawItems.map(i => ({
    index: i.index, title: i.title,
    url: i.url, thumbnail: i.thumbnail,
    status: 'pending', progress: 0,
  }));

  const batch: BatchJob = {
    id, url, title, folder, items,
    done: 0, total: items.length,
    status: 'running', paused: false,
    concurrency, startedAt: Date.now(), archive,
    _subs: new Set(),
  };
  batches.set(id, batch);
  res.json({ id });
  runBatch(batch);
});

router.get('/batch/:id/events', requireAuth, (req, res) => {
  const b = batches.get(req.params['id'] as string);
  sseHeaders(res);
  if (!b) { res.write('event: error\ndata: {"error":"Not found"}\n\n'); res.end(); return; }
  b._subs?.add(res);
  res.write(`event: update\ndata: ${JSON.stringify(serializeBatch(b))}\n\n`);
  req.on('close', () => b._subs?.delete(res));
});

// Returns full batch state (including items) for rehydrating after a page reload.
router.get('/batches', requireAuth, (_req, res) => {
  res.json([...batches.values()].map(serializeBatch));
});

router.post('/batch/:id/pause', requireAuth, (req, res) => {
  const b = batches.get(req.params['id'] as string);
  if (!b) { res.status(404).json({ error: 'Not found' }); return; }
  b.paused = true;
  broadcastBatch(b);
  res.json({ ok: true });
});

router.post('/batch/:id/resume', requireAuth, (req, res) => {
  const b = batches.get(req.params['id'] as string);
  if (!b) { res.status(404).json({ error: 'Not found' }); return; }
  b.paused = false;
  if (b.status !== 'running') { b.status = 'running'; runBatch(b); }
  broadcastBatch(b);
  res.json({ ok: true });
});

router.post('/batch/:id/stop', requireAuth, (req, res) => {
  const b = batches.get(req.params['id'] as string);
  if (!b) { res.status(404).json({ error: 'Not found' }); return; }
  b._stopReq = true;
  b.status = 'stopped';
  b._procs?.forEach(proc => {
    try { proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
  });
  broadcastBatch(b);
  res.json({ ok: true });
});

// Cancel a single item and let the worker move to the next one.
router.post('/batch/:id/cancel/:index', requireAuth, (req, res) => {
  const b = batches.get(req.params['id'] as string);
  if (!b) { res.status(404).json({ error: 'Not found' }); return; }
  const idx = parseInt(req.params['index'] as string, 10);
  const item = b.items.find(i => i.index === idx);
  if (!item) { res.status(404).json({ error: 'Item not found' }); return; }
  if (!['pending', 'downloading'].includes(item.status)) {
    res.status(400).json({ error: 'Item already finished' }); return;
  }
  item.status = 'skipped';
  delete item.speed; delete item.eta;
  const proc = b._procs?.get(idx);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
  }
  b.done = b.items.filter(i => i.status === 'done').length;
  broadcastBatch(b);
  res.json({ ok: true });
});

router.post('/batch/:id/dismiss', requireAuth, (req, res) => {
  batches.delete(req.params['id'] as string);
  res.json({ ok: true });
});

export default router;
