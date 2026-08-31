import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import {
  loadConfig, loadSecrets, ensureDataDirs, migrateLegacyData,
  APP_DIR, DATA_DIR, YT_DLP_LOCAL,
} from './config';
import { rescan, buildMeta, findById } from './services/library';
import { ytDlpBin } from './services/ytdlp';
import { getThumbBuffer } from './services/media';
import { resolveRange } from './services/httpRange';
import { MIME } from './config';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import videosRouter from './routes/videos';
import downloadsRouter from './routes/downloads';
import batchRouter from './routes/batch';
import settingsRouter from './routes/settings';
import uploadRouter from './routes/upload';
import appUpdateRouter from './routes/appUpdate';
import previewRouter from './routes/preview';
import { initPreviews } from './services/preview';
import { requireAuth } from './middleware/auth';
import { migratePasswordEraConfig } from './services/users';
import { errorHandler } from './middleware/error';

declare module 'express-session' {
  interface SessionData { userId: string; }
}

// Data lives outside the app tree; pull anything left behind by a pre-split
// install across before the first read.
const migrated = migrateLegacyData();
ensureDataDirs();
const config = loadConfig();
const secrets = loadSecrets();
migratePasswordEraConfig();

const app = express();

// Signed cookies — the trusted-device token must not be forgeable.
app.use(cookieParser(secrets.sessionSecret));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: secrets.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

// ── Streaming routes at root level (not under /api) ──────────────────────────

app.get('/stream/:id', requireAuth, (req, res) => {
  const video = findById(req.params["id"] as string);
  if (!video) { res.status(404).json({ error: 'Not found' }); return; }
  let stat: fs.Stats;
  try { stat = fs.statSync(video.absPath); }
  catch { res.status(404).json({ error: 'File missing' }); return; }
  const total = stat.size;
  const mime = MIME[video.ext] || 'video/mp4';
  // Let the browser cache/revalidate the file so replays and back-seeks reuse
  // already-downloaded bytes instead of re-streaming from disk.
  const lastMod = stat.mtime.toUTCString();
  const HWM = 1 << 20;                 // 1 MiB read buffer — fewer syscalls
  const CHUNK = 8 * 1024 * 1024;       // cap for open-ended ranges → progressive streaming

  const r = resolveRange(req.headers.range, total, CHUNK);
  if (r.kind === 'unsatisfiable') {
    // 416 with the true size so the player can recover, instead of a broken 206
    // that stalls or scrambles playback.
    res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
    res.end();
    return;
  }

  let stream: fs.ReadStream;
  if (r.kind === 'range') {
    res.writeHead(206, {
      'Content-Range': `bytes ${r.start}-${r.end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': r.end - r.start + 1,
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=86400',
      'Last-Modified': lastMod,
    });
    stream = fs.createReadStream(video.absPath, { start: r.start, end: r.end, highWaterMark: HWM });
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=86400',
      'Last-Modified': lastMod,
    });
    stream = fs.createReadStream(video.absPath, { highWaterMark: HWM });
  }
  stream.pipe(res);
  // Free the file handle if the client seeks away / closes the tab mid-stream.
  res.on('close', () => stream.destroy());
});

app.get('/thumb/:id', requireAuth, async (req, res) => {
  const video = findById(req.params["id"] as string);
  if (!video) { res.status(404).json({ error: 'Not found' }); return; }
  // Strong ETag keyed by id — thumbnails are immutable for a given video, so the
  // browser can serve from its own cache and we answer repeats with 304.
  const etag = `"t-${video.id}"`;
  if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
  try {
    const buf = await getThumbBuffer(video.id, video.absPath, video.duration || 60);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=604800',
      'ETag': etag,
    });
    res.end(buf);
  } catch { res.status(500).json({ error: 'Thumbnail generation failed' }); }
});

// ── API routes ────────────────────────────────────────────────────────────────

app.use('/api', authRouter);
app.use('/api', usersRouter);
app.use('/api', videosRouter);
app.use('/api', downloadsRouter);
app.use('/api', batchRouter);
app.use('/api', settingsRouter);
app.use('/api', uploadRouter);
app.use('/api', appUpdateRouter);
app.use('/api', previewRouter);

// ── Serve React SPA ───────────────────────────────────────────────────────────

const clientDist = path.join(APP_DIR, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.json({
    status: 'LoStreamu API running — start the client: cd client && npm run dev',
  }));
}

app.use(errorHandler);

const PORT = Number(process.env.PORT || config.port || 8080);
app.listen(PORT, () => {
  console.log(`LoStreamu running on http://0.0.0.0:${PORT}`);
  console.log(`Data dir : ${DATA_DIR}`);
  console.log(`Media dir: ${config.mediaDir}`);
  if (migrated.length) console.log(`Migrated into the data dir: ${migrated.join(', ')}`);
  rescan();
  initPreviews(); // wipe any stale scrub-preview sprites + start the idle sweep
  // Defer CPU work so the server can answer requests immediately on boot instead
  // of racing ffprobe / yt-dlp against the first library load.
  setTimeout(() => buildMeta().catch(() => {}), 4000);
  setTimeout(scheduleYtDlpUpdate, 15000);
});

function scheduleYtDlpUpdate(): void {
  const run = () => {
    execFile(ytDlpBin(), ['-U'], { timeout: 120000 }, (err, stdout) => {
      const line = (stdout || '').trim().split('\n').filter(Boolean).pop();
      if (!err) { if (line) console.log(`yt-dlp: ${line}`); return; }
      // Fallback: download binary directly to app dir (writable by service user)
      const tmp = YT_DLP_LOCAL + '.tmp';
      execFile('curl', ['-fsSL',
        'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
        '-o', tmp,
      ], { timeout: 120000 }, (e2) => {
        if (e2) { console.warn('yt-dlp download failed:', e2.message.split('\n')[0]); return; }
        try {
          fs.renameSync(tmp, YT_DLP_LOCAL);
          fs.chmodSync(YT_DLP_LOCAL, 0o755);
        } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
      });
    });
  };
  run();
  setInterval(run, 12 * 60 * 60 * 1000);
}
