import { Router } from 'express';
import fs from 'fs';
import type { Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { safePath, getMediaRoot } from '../services/library';
import { normalizeUrl } from '../services/ytdlp';
import { downloadQueue } from '../services/download';
import { DuplicateError, type QueueItem, type QueueState } from '../services/download';
import type { DownloadStatus } from '../types';

// ── Thin HTTP adapter over the centralized DownloadQueue ──────────────────────
// No business logic here: routes translate requests into queue commands and
// stream queue-state changes back to the UI. All state lives in the queue.

const router = Router();

// Map the queue's rich state to the status strings the existing UI consumes.
function mapStatus(s: QueueState): DownloadStatus {
  switch (s) {
    case 'preparing': return 'starting';
    case 'completed': return 'done';
    case 'failed':
    case 'cancelled': return 'error';
    default: return s; // queued | downloading | processing | paused
  }
}

function queuePos(item: QueueItem): number | undefined {
  if (['completed', 'failed', 'cancelled'].includes(item.state)) return undefined;
  const waiting = downloadQueue.list().filter(i =>
    ['preparing', 'downloading', 'processing', 'queued', 'paused'].includes(i.state));
  const idx = waiting.findIndex(i => i.id === item.id);
  return idx >= 0 ? idx : undefined;
}

function serialize(item: QueueItem): object {
  return {
    id: item.id,
    url: item.url,
    title: item.title,
    uploader: item.uploader,
    status: mapStatus(item.state),
    progress: item.progress,
    speed: item.speed,
    eta: item.eta,
    folder: item.folder,
    thumbUrl: item.thumbUrl,
    error: item.error,
    startedAt: item.createdAt,
    queuePos: queuePos(item),
    groupId: item.groupId,
    groupTitle: item.groupTitle,
  };
}

function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

// ── Reads ──────────────────────────────────────────────────────────────────
router.get('/downloads', requireAuth, (_req, res) => {
  res.json(downloadQueue.list().map(serialize));
});

// Whole-queue stream — one connection observes every item (efficient for 100+).
router.get('/downloads/events', requireAuth, (req, res) => {
  sseHeaders(res);
  const send = () => {
    try { res.write(`event: queue\ndata: ${JSON.stringify(downloadQueue.list().map(serialize))}\n\n`); }
    catch { /* client gone */ }
  };
  send();
  downloadQueue.on('change', send);
  req.on('close', () => downloadQueue.off('change', send));
});

// Per-item stream — kept for the existing tray which watches single jobs.
router.get('/download/:id/events', requireAuth, (req, res) => {
  const id = req.params['id'] as string;
  sseHeaders(res);
  const send = () => {
    const item = downloadQueue.get(id);
    if (!item) return;
    try { res.write(`event: status\ndata: ${JSON.stringify(serialize(item))}\n\n`); }
    catch { /* client gone */ }
  };
  send();
  downloadQueue.on('change', send);
  req.on('close', () => downloadQueue.off('change', send));
});

// ── Commands ─────────────────────────────────────────────────────────────────
router.post('/download', requireAuth, (req, res) => {
  const url = normalizeUrl(String(req.body?.url || '').trim());
  const folder = String(req.body?.folder || '').replace(/^[/\\]+/, '');
  if (!url) { res.status(400).json({ error: 'url required' }); return; }

  // Snapshot the destination now, so a later folder change never moves this item.
  const destAbs = folder ? (safePath(folder) || getMediaRoot()) : getMediaRoot();
  fs.mkdirSync(destAbs, { recursive: true });

  const filename = String(req.body?.filename || '').trim()
    .replace(/[<>:"|?*\\/\x00-\x1f]/g, '').trim().slice(0, 200) || undefined;

  try {
    const item = downloadQueue.enqueue({ url, folder, destAbs, filename });
    res.json({ id: item.id });
  } catch (err) {
    if (err instanceof DuplicateError) { res.status(409).json({ error: err.message, duplicate: true }); return; }
    res.status(500).json({ error: (err as Error).message });
  }
});

const cmd = (fn: (id: string) => boolean) => (req: any, res: any) => {
  const ok = fn(req.params.id as string);
  if (!ok) { res.status(404).json({ error: 'Not found or not allowed in current state' }); return; }
  res.json({ ok: true });
};

router.post('/download/:id/cancel', requireAuth, cmd(id => downloadQueue.cancel(id)));
router.post('/download/:id/pause', requireAuth, cmd(id => downloadQueue.pause(id)));
router.post('/download/:id/resume', requireAuth, cmd(id => downloadQueue.resume(id)));
router.post('/download/:id/retry', requireAuth, cmd(id => downloadQueue.retry(id)));
router.post('/download/:id/dismiss', requireAuth, cmd(id => downloadQueue.remove(id)));

router.post('/download/:id/reorder', requireAuth, (req, res) => {
  const to = Number(req.body?.index);
  const ok = Number.isFinite(to) && downloadQueue.reorder(req.params['id'] as string, to);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Not found' });
});

router.post('/downloads/clear', requireAuth, (_req, res) => {
  res.json({ ok: true, removed: downloadQueue.clearFinished() });
});

// Bulk pause/resume/cancel/retry/remove — applied atomically in the queue.
router.post('/downloads/bulk', requireAuth, (req, res) => {
  const action = String(req.body?.action || '');
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!['pause', 'resume', 'cancel', 'retry', 'remove'].includes(action)) {
    res.status(400).json({ error: 'Invalid action' }); return;
  }
  downloadQueue.bulk(action as 'pause' | 'resume' | 'cancel' | 'retry' | 'remove', ids);
  res.json({ ok: true, count: ids.length });
});

// Proxy the (external) source thumbnail so the tray can show it pre-download.
router.get('/download/:id/thumb', requireAuth, async (req, res) => {
  const item = downloadQueue.get(req.params['id'] as string);
  if (!item?.thumbUrl) { res.status(404).json({ error: 'No thumbnail' }); return; }
  try {
    const r = await fetch(item.thumbUrl);
    if (!r.ok) { res.status(502).end(); return; }
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

export default router;
