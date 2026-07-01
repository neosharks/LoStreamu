import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { rescan, safePath, getMediaRoot, buildMeta } from '../services/library';
import { ytNetArgs, ytSpeedArgs, spawnDownload, fetchMeta, netHint, normalizeUrl } from '../services/ytdlp';
import { fetchCookiesViaBrowser } from '../services/browserCookies';
import type { DownloadJob } from '../types';

// Internal job extends public DownloadJob with private restart fields
type InternalJob = DownloadJob & {
  _url: string;
  _destAbs: string;
  _rawFilename: string;
};

const router = Router();

// ── Queue state ───────────────────────────────────────────────────────────────
const jobs = new Map<string, InternalJob>();
const jobSubs = new Map<string, Set<Response>>();
const jobQueue: string[] = [];   // ordered; active job stays at [0] while running
const jobProcs = new Map<string, ReturnType<typeof spawnDownload>>();
// Tracks why a process was intentionally killed: 'pause' or 'cancel'
const intentionalKill = new Map<string, 'pause' | 'cancel'>();
let activeJobId: string | null = null;

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function serializeJob(id: string, job: InternalJob): object {
  const qIdx = jobQueue.indexOf(id);
  return {
    id: job.id, title: job.title, uploader: job.uploader,
    status: job.status, progress: job.progress,
    speed: job.speed, eta: job.eta, folder: job.folder,
    thumbUrl: job.thumbUrl, error: job.error, startedAt: job.startedAt,
    queuePos: qIdx >= 0 ? qIdx : undefined,
  };
}

function broadcastJob(id: string): void {
  const job = jobs.get(id);
  const subs = jobSubs.get(id);
  if (!job || !subs?.size) return;
  const line = `event: status\ndata: ${JSON.stringify(serializeJob(id, job))}\n\n`;
  for (const res of subs) { try { res.write(line); } catch {} }
}

// Used when queue order changes so all watchers get fresh queuePos
function broadcastAll(): void {
  for (const id of jobs.keys()) broadcastJob(id);
}

// ── Queue management ──────────────────────────────────────────────────────────

function startNext(): void {
  if (activeJobId !== null) return;
  const nextId = jobQueue.find(id => jobs.get(id)?.status === 'queued');
  if (nextId) {
    const nextJob = jobs.get(nextId);
    if (nextJob) startJob(nextJob);
  }
}

// Call after a job leaves the active slot (done, error, or cancelled)
function finishJob(id: string): void {
  jobProcs.delete(id);
  const qIdx = jobQueue.indexOf(id);
  if (qIdx > -1) jobQueue.splice(qIdx, 1);
  if (activeJobId === id) activeJobId = null;
  broadcastAll();
  startNext();
}

// Accepts a guaranteed non-null job to avoid closure narrowing issues
function startJob(job: InternalJob): void {
  const id = job.id;

  activeJobId = id;
  job.status = 'starting';
  job.progress = 0;
  job.speed = undefined;
  job.eta = undefined;
  job.error = undefined;
  broadcastAll(); // update queuePos for all watchers

  let retried = false;

  function spawnProc(): void {
    const archivePath = path.join(job._destAbs, '.downloaded.txt');
    const outTpl = job._rawFilename
      ? path.join(job._destAbs, job._rawFilename + '.%(ext)s')
      : path.join(job._destAbs, '%(title).200B [%(id)s].%(ext)s');

    const args = [
      '--newline', '--no-mtime', '--no-warnings', '--continue',
      '--download-archive', archivePath,
      ...ytNetArgs(),
      ...ytSpeedArgs(),
      '--no-playlist',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '-o', outTpl,
      job._url,
    ];

    const proc = spawnDownload(args);
    jobProcs.set(id, proc);

    proc.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        const pctM = line.match(/(\d+\.?\d*)%/);
        if (pctM) job.progress = parseFloat(pctM[1]);
        const speedM = line.match(/at\s+([\d.]+\w+\/s)/);
        if (speedM) job.speed = speedM[1];
        const etaM = line.match(/ETA\s+(\S+)/);
        if (etaM) job.eta = etaM[1];
        if (line.includes('[Merger]') || line.includes('[ffmpeg]')) job.status = 'processing';
        broadcastJob(id); // progress-only, no need to broadcast all
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes('ERROR') || text.includes('error'))
        job.error = netHint(text.trim().split('\n')[0]);
    });

    proc.on('close', (code) => {
      const intent = intentionalKill.get(id);
      if (intent) {
        intentionalKill.delete(id);
        jobProcs.delete(id);
        if (activeJobId === id) activeJobId = null;
        if (intent === 'pause') {
          // job.status already set to 'paused' by the route handler
          broadcastAll();
          startNext();
        } else {
          // cancel: remove from queue and mark error
          const qIdx = jobQueue.indexOf(id);
          if (qIdx > -1) jobQueue.splice(qIdx, 1);
          job.status = 'error';
          job.error = 'Cancelled';
          broadcastAll();
          startNext();
          rescan();
        }
        return;
      }

      if (code === 0) {
        job.status = 'done';
        job.progress = 100;
        finishJob(id);
        rescan();
        buildMeta().catch(() => {});
      } else if (/410|403|age.?gate/i.test(job.error || '') && !retried) {
        retried = true;
        job.error = undefined;
        job.progress = 0;
        broadcastJob(id);
        fetchCookiesViaBrowser(job._url)
          .then(() => spawnProc())
          .catch(() => { job.status = 'error'; finishJob(id); });
      } else {
        job.status = 'error';
        job.error = job.error || `yt-dlp exited with code ${code}`;
        finishJob(id);
        rescan();
        buildMeta().catch(() => {});
      }
    });

    job.status = 'downloading';
    broadcastJob(id);
  }

  spawnProc();
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/downloads', requireAuth, (_req, res) => {
  res.json([...jobs.values()].map(j => serializeJob(j.id, j)));
});

router.get('/download/:id/events', requireAuth, (req, res) => {
  const id = req.params['id'] as string;
  sseHeaders(res);
  if (!jobSubs.has(id)) jobSubs.set(id, new Set());
  jobSubs.get(id)!.add(res);
  const job = jobs.get(id);
  if (job) res.write(`event: status\ndata: ${JSON.stringify(serializeJob(id, job))}\n\n`);
  req.on('close', () => { jobSubs.get(id)?.delete(res); });
});

// Add to queue — starts immediately only if queue is empty
router.post('/download', requireAuth, async (req, res) => {
  const rawUrl = String(req.body?.url || '').trim();
  const url = normalizeUrl(rawUrl);
  const folder = String(req.body?.folder || '').replace(/^[/\\]+/, '');
  if (!url) { res.status(400).json({ error: 'url required' }); return; }

  const id = crypto.randomBytes(8).toString('hex');
  const destAbs = folder ? (safePath(folder) || getMediaRoot()) : getMediaRoot();
  fs.mkdirSync(destAbs, { recursive: true });

  const rawFilename = String(req.body?.filename || '').trim()
    .replace(/[<>:"|?*\\/\x00-\x1f]/g, '').trim().slice(0, 200);

  const job: InternalJob = {
    id, url, _url: url,
    title: 'Fetching info…', status: 'queued',
    progress: 0, folder, startedAt: Date.now(),
    _destAbs: destAbs, _rawFilename: rawFilename,
  };
  jobs.set(id, job);
  jobQueue.push(id);
  res.json({ id });

  broadcastAll(); // let existing watchers see the new queued item

  fetchMeta(url).then(m => {
    job.title = m.title || url;
    job.uploader = m.uploader;
    job.thumbUrl = m.thumbUrl;
    broadcastJob(id);
  }).catch(() => {});

  startNext(); // no-op if something is already running
});

router.post('/download/:id/pause', requireAuth, (req, res) => {
  const id = req.params['id'] as string;
  const job = jobs.get(id);
  if (!job) { res.status(404).json({ error: 'Not found' }); return; }
  if (!['starting', 'downloading', 'processing'].includes(job.status)) {
    res.status(400).json({ error: 'Cannot pause this job' }); return;
  }
  intentionalKill.set(id, 'pause');
  job.status = 'paused';
  broadcastJob(id); // immediate visual feedback before process dies
  jobProcs.get(id)?.kill('SIGTERM');
  // close handler fires async and calls startNext()
  res.json({ ok: true });
});

router.post('/download/:id/resume', requireAuth, (req, res) => {
  const id = req.params['id'] as string;
  const job = jobs.get(id);
  if (!job) { res.status(404).json({ error: 'Not found' }); return; }
  if (job.status !== 'paused') { res.status(400).json({ error: 'Job not paused' }); return; }

  if (activeJobId === null) {
    startJob(job);
  } else {
    // Re-queue right after the currently active job
    job.status = 'queued';
    const idx = jobQueue.indexOf(id);
    if (idx > -1) jobQueue.splice(idx, 1);
    const activeIdx = jobQueue.indexOf(activeJobId);
    jobQueue.splice(activeIdx >= 0 ? activeIdx + 1 : 0, 0, id);
    broadcastAll();
  }
  res.json({ ok: true });
});

router.post('/download/:id/cancel', requireAuth, (req, res) => {
  const id = req.params['id'] as string;
  const job = jobs.get(id);
  if (!job) { res.status(404).json({ error: 'Not found' }); return; }

  const proc = jobProcs.get(id);
  if (proc) {
    intentionalKill.set(id, 'cancel');
    proc.kill('SIGTERM'); // close handler does cleanup
  } else {
    // Not running (queued/paused) — clean up synchronously
    const qIdx = jobQueue.indexOf(id);
    if (qIdx > -1) jobQueue.splice(qIdx, 1);
    if (activeJobId === id) activeJobId = null;
    job.status = 'error';
    job.error = 'Cancelled';
    broadcastAll();
    startNext();
  }
  res.json({ ok: true });
});

router.post('/download/:id/dismiss', requireAuth, (req, res) => {
  jobs.delete(req.params['id'] as string);
  jobSubs.delete(req.params['id'] as string);
  res.json({ ok: true });
});

router.get('/download/:id/thumb', requireAuth, async (req, res) => {
  const job = jobs.get(req.params['id'] as string);
  if (!job?.thumbUrl) { res.status(404).json({ error: 'No thumbnail' }); return; }
  try {
    const r = await fetch(job.thumbUrl);
    if (!r.ok) { res.status(502).end(); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.send(buf);
  } catch { res.status(502).end(); }
});

export default router;
