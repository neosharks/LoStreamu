import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { loadConfig, loadSecrets, APP_DIR, YT_DLP_LOCAL } from './config';
import { rescan, buildMeta, findById } from './services/library';
import { ytDlpBin } from './services/ytdlp';
import { generateThumb } from './services/media';
import { MIME } from './config';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import videosRouter from './routes/videos';
import downloadsRouter from './routes/downloads';
import batchRouter from './routes/batch';
import settingsRouter from './routes/settings';
import uploadRouter from './routes/upload';
import appUpdateRouter from './routes/appUpdate';
import { requireAuth } from './middleware/auth';
import { errorHandler } from './middleware/error';

declare module 'express-session' {
  interface SessionData { userId: string; }
}

const config = loadConfig();
const secrets = loadSecrets();

const app = express();

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: secrets.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: false, sameSite: false, secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ── Streaming routes at root level (not under /api) ──────────────────────────

app.get('/stream/:id', requireAuth, (req, res) => {
  const video = findById(req.params["id"] as string);
  if (!video) { res.status(404).json({ error: 'Not found' }); return; }
  const stat = fs.statSync(video.absPath);
  const total = stat.size;
  const mime = MIME[video.ext] || 'video/mp4';
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : total - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    fs.createReadStream(video.absPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(video.absPath).pipe(res);
  }
});

app.get('/thumb/:id', requireAuth, async (req, res) => {
  const video = findById(req.params["id"] as string);
  if (!video) { res.status(404).json({ error: 'Not found' }); return; }
  try {
    const p = await generateThumb(video.id, video.absPath, video.duration || 60);
    res.sendFile(p);
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

// ── Serve React SPA ───────────────────────────────────────────────────────────

const clientDist = path.join(APP_DIR, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.json({
    status: 'StreamVault API running — start the client: cd client && npm run dev',
  }));
}

app.use(errorHandler);

const PORT = Number(process.env.PORT || config.port || 8080);
app.listen(PORT, () => {
  console.log(`StreamVault running on http://0.0.0.0:${PORT}`);
  console.log(`Media dir: ${config.mediaDir}`);
  rescan();
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
