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
      sessionSecret: crypto.randomBytes(32).toString('hex')
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

// jobId -> { id, status, percent, speed, eta, message, folder, proc }
const downloads = new Map();
// SSE subscribers: jobId -> Set(res)
const subscribers = new Map();

function emit(jobId) {
  const job = downloads.get(jobId);
  if (!job) return;
  const payload = JSON.stringify({
    id: job.id, status: job.status, percent: job.percent,
    speed: job.speed, eta: job.eta, message: job.message
  });
  const subs = subscribers.get(jobId);
  if (subs) for (const res of subs) res.write(`data: ${payload}\n\n`);
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
    message: 'Preparing download…', folder, url
  };
  downloads.set(id, job);

  // --newline gives one progress line per update; --no-playlist keeps it to the
  // single item unless the URL is explicitly a playlist (yt-dlp handles m3u8 too).
  const args = [
    '--newline',
    '--no-mtime',
    '--no-part',
    '-o', outTemplate,
    // Merge HLS/segmented streams into a single mp4 when possible.
    '--merge-output-format', 'mp4',
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
    // Progress lines look like:  [download]  42.3% of 120.00MiB at 3.20MiB/s ETA 00:21
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
  res.json([...downloads.values()].map(j => ({
    id: j.id, status: j.status, percent: j.percent,
    speed: j.speed, eta: j.eta, message: j.message
  })));
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
  res.write(`data: ${JSON.stringify({ id: job.id, status: job.status, percent: job.percent, speed: job.speed, eta: job.eta, message: job.message })}\n\n`);
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

app.use(requireAuth, express.static(join(__dirname, 'public')));
app.get('/', requireAuth, (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.listen(config.port, () => {
  console.log(`\n  StreamVault running → http://localhost:${config.port}`);
  console.log(`  Media folder: ${config.mediaDir}`);
  console.log(`  ${library.length} video(s) found. Drop files in the media folder and hit Rescan.\n`);
});
