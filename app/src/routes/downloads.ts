import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { rescan, safePath, getMediaRoot } from '../services/library';
import { ytNetArgs, spawnDownload, fetchMeta, netHint, normalizeUrl } from '../services/ytdlp';
import { fetchCookiesViaBrowser } from '../services/browserCookies';
import { buildMeta } from '../services/library';
import type { DownloadJob } from '../types';

const router = Router();

const jobs = new Map<string, DownloadJob>();
const jobSubs = new Map<string, Set<Response>>();

function broadcast(id: string, event: string, data: unknown): void {
  const subs = jobSubs.get(id);
  if (!subs?.size) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subs) {
    try { res.write(line); } catch {}
  }
}

function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

router.get('/downloads', requireAuth, (_req, res) => {
  res.json([...jobs.values()].map(j => ({
    id: j.id, title: j.title, uploader: j.uploader, status: j.status,
    progress: j.progress, speed: j.speed, eta: j.eta, folder: j.folder,
    thumbUrl: j.thumbUrl, error: j.error, startedAt: j.startedAt,
  })));
});

router.get('/download/:id/events', requireAuth, (req, res) => {
  const id = req.params["id"] as string;
  sseHeaders(res);
  if (!jobSubs.has(id)) jobSubs.set(id, new Set());
  jobSubs.get(id)!.add(res);

  const job = jobs.get(id);
  if (job) res.write(`event: status\ndata: ${JSON.stringify(job)}\n\n`);

  req.on('close', () => { jobSubs.get(id)?.delete(res); });
});

router.post('/download', requireAuth, async (req, res) => {
  const rawUrl = String(req.body?.url || '').trim();
  const url = normalizeUrl(rawUrl);
  const folder = String(req.body?.folder || '').replace(/^[/\\]+/, '');
  if (!url) { res.status(400).json({ error: 'url required' }); return; }

  const id = crypto.randomBytes(8).toString('hex');
  const destAbs = folder ? (safePath(folder) || getMediaRoot()) : getMediaRoot();
  fs.mkdirSync(destAbs, { recursive: true });

  const archivePath = path.join(destAbs, '.downloaded.txt');
  const outTpl = path.join(destAbs, '%(title).200B [%(id)s].%(ext)s');

  const job: DownloadJob = {
    id, url, title: 'Fetching info…', status: 'starting',
    progress: 0, folder, startedAt: Date.now(),
  };
  jobs.set(id, job);
  res.json({ id });

  // Fetch meta asynchronously
  fetchMeta(url).then(m => {
    job.title = m.title || url;
    job.uploader = m.uploader;
    job.thumbUrl = m.thumbUrl;
    broadcast(id, 'status', job);
  }).catch(() => {});

  function buildArgs() {
    return [
      '--newline', '--no-mtime', '--no-warnings', '--continue',
      '--download-archive', archivePath,
      ...ytNetArgs(),
      '--no-playlist',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '-o', outTpl,
      url,
    ];
  }

  function startProc(args: string[], onAgeGate: () => void) {
    const proc = spawnDownload(args);

    proc.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const pctM = line.match(/(\d+\.?\d*)%/);
        if (pctM) job.progress = parseFloat(pctM[1]);
        const speedM = line.match(/at\s+([\d.]+\w+\/s)/);
        if (speedM) job.speed = speedM[1];
        const etaM = line.match(/ETA\s+(\S+)/);
        if (etaM) job.eta = etaM[1];
        if (line.includes('[Merger]') || line.includes('[ffmpeg]')) job.status = 'processing';
        broadcast(id, 'progress', { progress: job.progress, speed: job.speed, eta: job.eta, status: job.status });
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes('ERROR') || text.includes('error')) {
        job.error = netHint(text.trim().split('\n')[0]);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        job.status = 'done';
        job.progress = 100;
        broadcast(id, 'status', job);
        rescan();
        buildMeta().catch(() => {});
      } else if (/410|403|age.?gate/i.test(job.error || '')) {
        onAgeGate();
      } else {
        job.status = 'error';
        job.error = job.error || `yt-dlp exited with code ${code}`;
        broadcast(id, 'status', job);
        rescan();
        buildMeta().catch(() => {});
      }
    });

    return proc;
  }

  let retried = false;
  function onAgeGate() {
    if (retried) {
      job.status = 'error';
      broadcast(id, 'status', job);
      return;
    }
    retried = true;
    job.error = undefined;
    job.progress = 0;
    broadcast(id, 'status', job);
    fetchCookiesViaBrowser(url)
      .then(() => startProc(buildArgs(), onAgeGate))
      .catch(() => { job.status = 'error'; broadcast(id, 'status', job); });
  }

  const proc = startProc(buildArgs(), onAgeGate);
  job.status = 'downloading';
  broadcast(id, 'status', job);
  void proc;
});

router.post('/download/:id/cancel', requireAuth, (req, res) => {
  const job = jobs.get(req.params["id"] as string);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  job.status = 'error';
  job.error = 'Cancelled';
  broadcast(req.params["id"] as string, 'status', job);
  res.json({ ok: true });
});

router.post('/download/:id/dismiss', requireAuth, (req, res) => {
  jobs.delete(req.params["id"] as string);
  jobSubs.delete(req.params["id"] as string);
  res.json({ ok: true });
});

router.get('/download/:id/thumb', requireAuth, async (req, res) => {
  const job = jobs.get(req.params["id"] as string);
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
