import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { dirname, join, extname, basename } from 'path';
import fs from 'fs';
import { execFile, spawn } from 'child_process';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config — edit config.json (auto-created on first run) to set login + paths.
// ---------------------------------------------------------------------------
const CONFIG_PATH = join(__dirname, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultPassword = 'changeme';
    const cfg = {
      port: 8080,
      email: 'admin@local',
      // bcrypt hash of "changeme" — change this by running: npm run set-password
      passwordHash: bcrypt.hashSync(defaultPassword, 10),
      mediaDir: join(__dirname, 'media'),
      sessionSecret: crypto.randomBytes(32).toString('hex'),
      // Tarball the in-app "Update" button pulls from. Override per fork.
      updateUrl: 'https://raw.githubusercontent.com/thakursat/hosted-video-streamer/main/streamvault-app.tar.gz'
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    console.log('\n  Created config.json with default login:');
    console.log('    email:    admin@local');
    console.log('    password: changeme');
    console.log('  Change these before exposing the server.\n');
    return cfg;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const config = loadConfig();
const THUMB_DIR = join(__dirname, 'thumbnails');
if (!fs.existsSync(config.mediaDir)) fs.mkdirSync(config.mediaDir, { recursive: true });
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg', '.ts', '.m2ts', '.3gp', '.ogv']);

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg', '.ts': 'video/mp2t', '.3gp': 'video/3gpp'
};

// ---------------------------------------------------------------------------
// Media library — scans mediaDir recursively, builds stable ids.
// ---------------------------------------------------------------------------
function idFor(relPath) {
  return crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 16);
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (VIDEO_EXT.has(extname(entry.name).toLowerCase())) {
      const rel = full.slice(base.length + 1);
      out.push({ id: idFor(rel), rel, full, name: basename(entry.name, extname(entry.name)) });
    }
  }
  return out;
}

let library = [];
function rescan() {
  library = walk(config.mediaDir).sort((a, b) => a.name.localeCompare(b.name));
  return library;
}
rescan();

function thumbPath(id) { return join(THUMB_DIR, id + '.jpg'); }

function ensureThumb(item) {
  return new Promise((resolve) => {
    const out = thumbPath(item.id);
    if (fs.existsSync(out)) return resolve(out);
    // Grab a frame ~10% in, scaled to 480px wide.
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', item.full], (err, stdout) => {
      const dur = parseFloat(stdout) || 0;
      const seek = dur > 0 ? Math.min(dur * 0.1, dur - 0.5).toFixed(2) : '1';
      execFile('ffmpeg', ['-y', '-ss', seek, '-i', item.full,
        '-frames:v', '1', '-vf', 'scale=480:-1', '-q:v', '4', out],
        (e) => resolve(fs.existsSync(out) ? out : null));
    });
  });
}

// ---------------------------------------------------------------------------
// Downloads — yt-dlp, each into its own random folder with a random filename.
// The real video title never touches disk and is never shown in the UI.
// ---------------------------------------------------------------------------
function randToken(n = 12) {
  return crypto.randomBytes(n).toString('hex').slice(0, n);
}

function humanSize(bytes) {
  if (!bytes || bytes < 0) return '';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
function fmtEta(sec) {
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m >= 60) { const h = Math.floor(m / 60); return h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0'); }
  return m + ':' + String(s).padStart(2, '0');
}

// jobId -> { id, status, percent, speed, eta, message, folder, proc, title, ... }
const downloads = new Map();
// SSE subscribers: jobId -> Set(res)
const subscribers = new Map();

// Public, serialisable view of a job (no proc / buffers).
function jobView(job) {
  return {
    id: job.id, status: job.status, percent: job.percent,
    speed: job.speed, eta: job.eta, message: job.message,
    title: job.title || '', uploader: job.uploader || '',
    duration: job.duration || 0,
    downloadedBytes: job.downloadedBytes || 0,
    totalBytes: job.totalBytes || 0,
    hasThumb: !!job.thumbUrl
  };
}

function emit(jobId) {
  const job = downloads.get(jobId);
  if (!job) return;
  const payload = JSON.stringify(jobView(job));
  const subs = subscribers.get(jobId);
  if (subs) for (const res of subs) res.write(`data: ${payload}\n\n`);
}

// Lightweight metadata probe (title, thumbnail, duration) — no download.
function fetchMeta(url) {
  return new Promise((resolve) => {
    execFile('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '--no-progress', url],
      { maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(stdout);
          let thumb = j.thumbnail || '';
          if (Array.isArray(j.thumbnails) && j.thumbnails.length) {
            const sorted = j.thumbnails.filter(t => t.url).sort((a, b) => (a.width || 0) - (b.width || 0));
            const pick = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.6))];
            if (pick) thumb = pick.url;
          }
          resolve({
            title: j.title || j.fulltitle || '',
            uploader: j.uploader || j.channel || j.extractor_key || '',
            duration: Math.round(j.duration || 0),
            thumbUrl: thumb,
            totalBytes: j.filesize || j.filesize_approx || 0
          });
        } catch { resolve(null); }
      });
  });
}

function startDownload(url) {
  const id = randToken(8);
  // Random folder + random filename. yt-dlp keeps the source extension via %(ext)s.
  const folderName = randToken(16);
  const folder = join(config.mediaDir, folderName);
  fs.mkdirSync(folder, { recursive: true });
  const fileBase = randToken(20);
  const outTemplate = join(folder, `${fileBase}.%(ext)s`);

  const job = {
    id, status: 'starting', percent: 0, speed: '', eta: '',
    message: 'Preparing download…', folder, url,
    title: '', uploader: '', duration: 0,
    downloadedBytes: 0, totalBytes: 0,
    thumbUrl: '', thumbBuf: null, thumbType: ''
  };
  downloads.set(id, job);

  // Probe title / thumbnail / duration in the background and stream it to the UI.
  fetchMeta(url).then(meta => {
    if (!meta || job.status === 'cancelled' || job.status === 'done' || job.status === 'error') return;
    job.title = meta.title; job.uploader = meta.uploader;
    job.duration = meta.duration; job.thumbUrl = meta.thumbUrl;
    if (!job.totalBytes && meta.totalBytes) job.totalBytes = meta.totalBytes;
    emit(id);
  });

  // --newline gives one progress line per update; --no-playlist keeps it to the
  // single item unless the URL is explicitly a playlist (yt-dlp handles m3u8 too).
  // --progress-template emits machine-readable byte/speed/eta fields.
  const args = [
    '--newline',
    '--no-mtime',
    '--no-part',
    '--no-warnings',
    '-o', outTemplate,
    // Merge HLS/segmented streams into a single mp4 when possible.
    '--merge-output-format', 'mp4',
    '--progress-template',
    'PROG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    url
  ];

  let proc;
  try {
    proc = spawn('yt-dlp', args);
  } catch (e) {
    job.status = 'error';
    job.message = 'yt-dlp is not installed on the server.';
    emit(id);
    return job;
  }
  job.proc = proc;
  job.status = 'downloading';
  emit(id);

  const handleLine = (line) => {
    // Machine-readable progress from --progress-template (fields may be "NA").
    if (line.startsWith('PROG|')) {
      const [, , dlb, tb, tbe, sp, eta] = line.split('|');
      const downloaded = parseInt(dlb, 10) || 0;
      const total = parseInt(tb, 10) || parseInt(tbe, 10) || 0;
      const speed = parseFloat(sp) || 0;
      const etaN = parseInt(eta, 10);
      job.downloadedBytes = downloaded;
      if (total) job.totalBytes = total;
      if (total) job.percent = Math.min(100, (downloaded / total) * 100);
      job.speed = speed ? humanSize(speed) + '/s' : '';
      job.eta = (isFinite(etaN) && etaN >= 0) ? fmtEta(etaN) : '';
      job.message = `Downloading ${job.percent.toFixed(1)}%`;
      job.status = 'downloading';
      emit(id);
      return;
    }
    // Fallback progress line:  [download]  42.3% of 120.00MiB at 3.20MiB/s ETA 00:21
    const dl = /\[download\]\s+([\d.]+)%(?:.*?at\s+([\d.]+\s*\w+\/s))?(?:.*?ETA\s+([\d:]+))?/.exec(line);
    if (dl) {
      job.percent = parseFloat(dl[1]);
      if (dl[2]) job.speed = dl[2].replace(/\s+/g, '');
      if (dl[3]) job.eta = dl[3];
      job.message = `Downloading ${job.percent.toFixed(1)}%`;
      job.status = 'downloading';
      emit(id);
    } else if (/\[Merger\]|Merging formats/.test(line)) {
      job.message = 'Merging…'; job.status = 'processing'; emit(id);
    } else if (/\[ffmpeg\]/i.test(line)) {
      job.message = 'Processing…'; job.status = 'processing'; emit(id);
    } else if (/\[ExtractAudio\]|Extracting/.test(line)) {
      job.message = 'Extracting…'; job.status = 'processing'; emit(id);
    }
  };

  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    // yt-dlp uses \r for in-place progress updates too
    const cr = buf.lastIndexOf('\r');
    if (cr >= 0) { handleLine(buf.slice(0, cr)); buf = buf.slice(cr + 1); }
  };
  proc.stdout.on('data', onData);
  let errTail = '';
  proc.stderr.on('data', (c) => { errTail = (errTail + c.toString()).slice(-500); });

  proc.on('close', (code) => {
    job.proc = null;
    if (job.status === 'cancelled') {
      // already handled; clean partial folder
      try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
      emit(id);
    } else if (code === 0) {
      job.status = 'done'; job.percent = 100; job.message = 'Saved to your library';
      rescan();
      emit(id);
    } else {
      job.status = 'error';
      job.message = (errTail.trim().split('\n').pop() || 'Download failed').slice(0, 200);
      // remove empty folder on failure
      try { if (fs.readdirSync(folder).length === 0) fs.rmSync(folder, { recursive: true, force: true }); } catch {}
      emit(id);
    }
  });
  proc.on('error', () => {
    job.status = 'error';
    job.message = 'Could not start yt-dlp. Is it installed?';
    emit(id);
  });

  return job;
}

// ---------------------------------------------------------------------------
// Keep yt-dlp current — stale binaries fail with "HTTP Error 410: Gone".
// Self-updates the standalone binary on boot, then every 12h.
// ---------------------------------------------------------------------------
function updateYtDlp() {
  execFile('yt-dlp', ['-U'], { timeout: 120000 }, (err, stdout) => {
    const line = (stdout || '').trim().split('\n').filter(Boolean).pop();
    if (err) console.warn('  yt-dlp self-update skipped:', (err.message || '').split('\n')[0]);
    else if (line) console.log(`  yt-dlp: ${line}`);
  });
}
updateYtDlp();
setInterval(updateYtDlp, 12 * 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/stream') || req.path.startsWith('/thumb'))
    return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login');
}

app.get('/login', (req, res) => res.sendFile(join(__dirname, 'public', 'login.html')));

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const ok = email === config.email && bcrypt.compareSync(password || '', config.passwordHash);
  if (!ok) return res.status(401).json({ error: 'That email and password don’t match.' });
  req.session.user = email;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', (req, res) =>
  res.json({ user: req.session?.user || null }));

// Library listing
app.get('/api/videos', requireAuth, (req, res) => {
  res.json(library.map(v => ({ id: v.id, name: v.name })));
});

app.post('/api/rescan', requireAuth, (req, res) => res.json({ count: rescan().length }));

// Thumbnails (generated on demand, cached)
app.get('/thumb/:id', requireAuth, async (req, res) => {
  const item = library.find(v => v.id === req.params.id);
  if (!item) return res.status(404).end();
  const p = await ensureThumb(item);
  if (!p) return res.status(404).end();
  res.sendFile(p);
});

// Ranged streaming — full-resolution direct play, supports seeking.
app.get('/stream/:id', requireAuth, (req, res) => {
  const item = library.find(v => v.id === req.params.id);
  if (!item) return res.status(404).end();
  const stat = fs.statSync(item.full);
  const total = stat.size;
  const type = MIME[extname(item.full).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || start >= total) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type
    });
    fs.createReadStream(item.full, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(item.full).pipe(res);
  }
});

// ---- Downloads ----
app.post('/api/download', requireAuth, (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url))
    return res.status(400).json({ error: 'Paste a valid http(s) link.' });
  const job = startDownload(url);
  res.json({ id: job.id, status: job.status });
});

app.get('/api/downloads', requireAuth, (req, res) => {
  res.json([...downloads.values()].map(jobView));
});

// Proxy the source thumbnail for an in-progress download (cached in memory).
app.get('/api/download/:id/thumb', requireAuth, async (req, res) => {
  const job = downloads.get(req.params.id);
  if (!job || !job.thumbUrl) return res.status(404).end();
  try {
    if (!job.thumbBuf) {
      const r = await fetch(job.thumbUrl);
      if (!r.ok) return res.status(404).end();
      job.thumbBuf = Buffer.from(await r.arrayBuffer());
      job.thumbType = r.headers.get('content-type') || 'image/jpeg';
    }
    res.setHeader('Content-Type', job.thumbType || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(job.thumbBuf);
  } catch { res.status(404).end(); }
});

// Server-Sent Events stream of progress for one job.
app.get('/api/download/:id/events', requireAuth, (req, res) => {
  const job = downloads.get(req.params.id);
  if (!job) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(`data: ${JSON.stringify(jobView(job))}\n\n`);
  if (!subscribers.has(job.id)) subscribers.set(job.id, new Set());
  subscribers.get(job.id).add(res);
  req.on('close', () => { subscribers.get(job.id)?.delete(res); });
});

app.post('/api/download/:id/cancel', requireAuth, (req, res) => {
  const job = downloads.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such download.' });
  if (job.proc) {
    job.status = 'cancelled';
    job.message = 'Cancelled';
    job.proc.kill('SIGKILL');
  }
  res.json({ ok: true });
});

// Dismiss a finished/failed job from the list.
app.post('/api/download/:id/dismiss', requireAuth, (req, res) => {
  const job = downloads.get(req.params.id);
  if (job && !job.proc) downloads.delete(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Self-update — pull the latest app tarball from GitHub, reinstall deps, refresh
// yt-dlp, and restart. Runs as the unprivileged service user, so it can't call
// systemctl; it exits non-zero and relies on the unit's `Restart=on-failure`.
// ---------------------------------------------------------------------------
const UPDATE_URL = process.env.SV_UPDATE_URL || config.updateUrl ||
  'https://raw.githubusercontent.com/thakursat/hosted-video-streamer/main/streamvault-app.tar.gz';

const update = { status: 'idle', log: [] };
function ulog(line) {
  const s = String(line).replace(/\s+$/, '');
  if (s) { update.log.push(s); if (update.log.length > 200) update.log.shift(); }
}

function runUpdate() {
  if (update.status === 'running' || update.status === 'restarting') return;
  update.status = 'running'; update.log = [];
  ulog('Source: ' + UPDATE_URL);

  // HOME/npm cache point at a writable temp dir — the service user has no home.
  const script = `
set -e
APP_DIR=${JSON.stringify(__dirname)}
URL=${JSON.stringify(UPDATE_URL)}
export HOME="$(mktemp -d)"
export npm_config_cache="$HOME/.npm"
echo "Downloading latest app…"
TMP="$(mktemp "\${TMPDIR:-/tmp}/sv.XXXXXX.tar.gz")"
curl -fsSL "$URL" -o "$TMP"
echo "Unpacking…"
tar -xzf "$TMP" -C "$APP_DIR"
rm -f "$TMP"
test -f "$APP_DIR/package.json"
echo "Installing dependencies…"
cd "$APP_DIR"
npm install --omit=dev --no-fund --no-audit
echo "Refreshing yt-dlp…"
yt-dlp -U || echo "yt-dlp self-update skipped (handled by the daily timer)"
echo "Update staged."
`;
  let proc;
  try {
    proc = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    update.status = 'error'; ulog('Could not start update: ' + e.message); return;
  }
  const onOut = (c) => c.toString().split('\n').forEach(ulog);
  proc.stdout.on('data', onOut);
  proc.stderr.on('data', onOut);
  proc.on('error', (e) => { update.status = 'error'; ulog('Update process error: ' + e.message); });
  proc.on('close', (code) => {
    if (code === 0) {
      update.status = 'restarting';
      ulog('Restarting service…');
      // Exit non-zero so systemd (Restart=on-failure) brings us back on new code.
      setTimeout(() => process.exit(1), 1200);
    } else {
      update.status = 'error';
      ulog(`Update failed (exit ${code}).`);
    }
  });
}

app.post('/api/update', requireAuth, (req, res) => {
  if (update.status === 'running' || update.status === 'restarting')
    return res.status(409).json({ error: 'An update is already in progress.' });
  runUpdate();
  res.json({ ok: true, status: update.status });
});

app.get('/api/update/status', requireAuth, (req, res) => {
  res.json({ status: update.status, log: update.log });
});

app.use(requireAuth, express.static(join(__dirname, 'public')));
app.get('/', requireAuth, (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.listen(config.port, () => {
  console.log(`\n  StreamVault running → http://localhost:${config.port}`);
  console.log(`  Media folder: ${config.mediaDir}`);
  console.log(`  ${library.length} video(s) found. Drop files in the media folder and hit Rescan.\n`);
});
