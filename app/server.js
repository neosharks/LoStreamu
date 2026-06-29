import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { dirname, join, extname, basename, resolve, sep } from 'path';
import fs from 'fs';
import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import { ensureSecrets } from './secrets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config — edit config.json (auto-created on first run) to set login + paths.
// ---------------------------------------------------------------------------
const CONFIG_PATH = join(__dirname, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = {
      port: 8080,
      // No account yet — the first visitor creates one via the signup screen.
      email: '',
      passwordHash: '',
      mediaDir: join(__dirname, 'media'),
      // Optional yt-dlp proxy (or set the SV_PROXY env var) to bypass network
      // blocks — e.g. "http://host:port" or "socks5://127.0.0.1:1080". Empty = none.
      proxy: '',
      // Secrets are NOT stored here — see secrets.json (generated at deploy time).
      // Tarball the in-app "Update" button pulls from. Override per fork.
      updateUrl: 'https://raw.githubusercontent.com/thakursat/hosted-video-streamer/refs/heads/main/streamvault-app.tar.gz'
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    console.log('\n  Created config.json — open the app to create your account.\n');
    return cfg;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const config = loadConfig();
// Session signing key etc. — generated at deploy/first-run, kept out of git.
const secrets = ensureSecrets();
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }
function hasAccount() { return !!(config.email && config.passwordHash); }
// Lenient — allows local addresses like "you@local" on a private server.
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const THUMB_DIR = join(__dirname, 'thumbnails');
if (!fs.existsSync(config.mediaDir)) fs.mkdirSync(config.mediaDir, { recursive: true });
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// All file ops are confined to MEDIA_ROOT. safePath() maps a user-supplied
// relative path to an absolute one and refuses anything that escapes the root.
const MEDIA_ROOT = resolve(config.mediaDir);

// Optional cookies for yt-dlp — drop a Netscape cookies.txt next to server.js
// to reach playlists/age-restricted/members content (e.g. YouTube, which often
// 403s playlist pages without a login). Passed to every yt-dlp invocation.
const COOKIES_PATH = join(__dirname, 'cookies.txt');
// Optional proxy/VPN for yt-dlp — set SV_PROXY (or config.proxy) to bypass
// ISP/network blocks (e.g. a reset connection / [Errno 104] to some sites).
// Examples: http://user:pass@host:port, socks5://127.0.0.1:1080
const PROXY = process.env.SV_PROXY || config.proxy || '';
// Common network flags applied to every yt-dlp call: cookies, proxy, retries.
function ytNet() {
  const a = [];
  if (fs.existsSync(COOKIES_PATH)) a.push('--cookies', COOKIES_PATH);
  if (PROXY) a.push('--proxy', PROXY);
  a.push('--retries', '5', '--fragment-retries', '10', '--socket-timeout', '30');
  return a;
}
// Append a hint when an error looks like a network/ISP block (reset/refused/etc.).
function netHint(msg) {
  return /reset by peer|errno 104|connection refused|timed out|network is unreachable|getaddrinfo|failed to resolve/i.test(msg || '')
    ? msg + (PROXY ? ' — even via the configured proxy. Check the proxy can reach this site.'
                   : ' — this site looks blocked on the server’s network. Set SV_PROXY to a VPN/proxy and retry.')
    : msg;
}

function safePath(rel) {
  const abs = resolve(MEDIA_ROOT, String(rel || '').replace(/^[/\\]+/, ''));
  if (abs !== MEDIA_ROOT && !abs.startsWith(MEDIA_ROOT + sep)) return null;
  return abs;
}
// Remove now-empty directories from `dir` up to (but not including) MEDIA_ROOT.
function pruneEmptyDirs(dir) {
  let cur = resolve(dir);
  while (cur !== MEDIA_ROOT && cur.startsWith(MEDIA_ROOT + sep)) {
    let entries; try { entries = fs.readdirSync(cur); } catch { break; }
    if (entries.length) break;
    try { fs.rmdirSync(cur); } catch { break; }
    cur = dirname(cur);
  }
}

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
      const d = dirname(rel);
      out.push({ id: idFor(rel), rel, full, name: basename(entry.name, extname(entry.name)), dir: d === '.' ? '' : d });
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

// Folder tree under MEDIA_ROOT, with direct + total (recursive) video counts.
function buildTree() {
  const node = (abs, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch {}
    const children = [];
    let videoCount = 0;
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) children.push(node(join(abs, e.name), rel ? rel + '/' + e.name : e.name));
      else if (VIDEO_EXT.has(extname(e.name).toLowerCase())) videoCount++;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    const total = videoCount + children.reduce((s, c) => s + c.total, 0);
    return { name: rel ? basename(rel) : 'All videos', path: rel, videoCount, total, children };
  };
  return node(MEDIA_ROOT, '');
}

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
// Per-video metadata (ffprobe) — cached on disk, refreshed when files change.
// ---------------------------------------------------------------------------
const META_CACHE_PATH = join(__dirname, 'meta-cache.json');
let metaCache = {};
try { if (fs.existsSync(META_CACHE_PATH)) metaCache = JSON.parse(fs.readFileSync(META_CACHE_PATH, 'utf8')); } catch {}
let metaSaveTimer = null;
function saveMetaCache() {
  clearTimeout(metaSaveTimer);
  metaSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(META_CACHE_PATH, JSON.stringify(metaCache)); } catch {}
  }, 800);
  metaSaveTimer.unref?.();
}

function evalFps(r) { const [n, d] = String(r).split('/').map(Number); return d ? Math.round((n / d) * 100) / 100 : 0; }

function probe(item) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', item.full],
      { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(stdout);
          const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
          const a = (j.streams || []).find(s => s.codec_type === 'audio') || {};
          const fmt = j.format || {};
          resolve({
            duration: Math.round(parseFloat(fmt.duration) || parseFloat(v.duration) || 0),
            width: v.width || 0, height: v.height || 0,
            vcodec: v.codec_name || '', acodec: a.codec_name || '',
            bitrate: parseInt(fmt.bit_rate, 10) || 0,
            fps: v.r_frame_rate ? evalFps(v.r_frame_rate) : 0
          });
        } catch { resolve(null); }
      });
  });
}

// Full metadata via the cache; probes on a miss or when the file changed.
async function getMeta(item) {
  let st; try { st = fs.statSync(item.full); } catch { return null; }
  const base = { size: st.size, addedAt: st.mtimeMs };
  const c = metaCache[item.id];
  if (c && c.mtimeMs === st.mtimeMs && c.duration != null)
    return { ...base, duration: c.duration, width: c.width, height: c.height,
             vcodec: c.vcodec, acodec: c.acodec, bitrate: c.bitrate, fps: c.fps };
  const p = await probe(item);
  if (p) { metaCache[item.id] = { mtimeMs: st.mtimeMs, ...p }; saveMetaCache(); return { ...base, ...p }; }
  return base;
}

// Cheap fields for listings; includes probe data only if already cached.
function quickMeta(item) {
  let st; try { st = fs.statSync(item.full); } catch { return {}; }
  const c = (metaCache[item.id] && metaCache[item.id].mtimeMs === st.mtimeMs) ? metaCache[item.id] : null;
  return {
    size: st.size, addedAt: st.mtimeMs,
    duration: c ? c.duration : null, width: c ? c.width : null, height: c ? c.height : null
  };
}

// Fill in any missing metadata in the background after a scan (one at a time).
let metaBuilding = false;
async function buildMeta() {
  if (metaBuilding) return;
  metaBuilding = true;
  try {
    for (const item of library) {
      let st; try { st = fs.statSync(item.full); } catch { continue; }
      const c = metaCache[item.id];
      if (c && c.mtimeMs === st.mtimeMs && c.duration != null) continue;
      await getMeta(item);
    }
  } finally { metaBuilding = false; }
}
buildMeta().catch(() => {});

// Drop cached thumbnail / sprite / VTT / metadata for a video id (after a
// delete, rename, or move — its id is derived from the relative path).
function cleanupArtifacts(id) {
  for (const p of [thumbPath(id), join(THUMB_DIR, id + '.sprite.jpg'), join(THUMB_DIR, id + '.vtt')]) {
    try { fs.rmSync(p, { force: true }); } catch {}
  }
  if (metaCache[id]) { delete metaCache[id]; saveMetaCache(); }
}

// ---------------------------------------------------------------------------
// Scrub-preview sprites — a tiled JPEG of frames + a WebVTT mapping time →
// sprite region, consumed by the player's preview-thumbnails (peek) feature.
// ---------------------------------------------------------------------------
const SPRITE_COLS = 10, SPRITE_W = 160, SPRITE_H = 90;
const spriteJobs = new Map(); // id -> Promise
function spritePaths(id) { return { jpg: join(THUMB_DIR, id + '.sprite.jpg'), vtt: join(THUMB_DIR, id + '.vtt') }; }
function vttStamp(t) {
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000`;
}
function ensureSprite(item) {
  if (spriteJobs.has(item.id)) return spriteJobs.get(item.id);
  const job = (async () => {
    const { jpg, vtt } = spritePaths(item.id);
    if (fs.existsSync(jpg) && fs.existsSync(vtt)) return { jpg, vtt };
    const meta = await getMeta(item);
    const dur = meta && meta.duration ? meta.duration : 0;
    if (!dur) return null;
    const target = Math.min(120, Math.max(20, Math.floor(dur / 10)));
    const interval = Math.max(1, Math.floor(dur / target));
    const count = Math.max(1, Math.floor(dur / interval));
    const rows = Math.ceil(count / SPRITE_COLS);
    await new Promise((resolve) => {
      execFile('ffmpeg', ['-y', '-i', item.full,
        '-vf', `fps=1/${interval},scale=${SPRITE_W}:${SPRITE_H},tile=${SPRITE_COLS}x${rows}`,
        '-frames:v', '1', '-q:v', '4', jpg], { timeout: 120000 }, () => resolve());
    });
    if (!fs.existsSync(jpg)) return null;
    let out = 'WEBVTT\n\n';
    for (let i = 0; i < count; i++) {
      const start = i * interval, end = Math.min(dur, (i + 1) * interval);
      const x = (i % SPRITE_COLS) * SPRITE_W, y = Math.floor(i / SPRITE_COLS) * SPRITE_H;
      out += `${vttStamp(start)} --> ${vttStamp(end)}\n/api/videos/${item.id}/sprite.jpg#xywh=${x},${y},${SPRITE_W},${SPRITE_H}\n\n`;
    }
    fs.writeFileSync(vtt, out);
    return { jpg, vtt };
  })().finally(() => spriteJobs.delete(item.id));
  spriteJobs.set(item.id, job);
  return job;
}

// ---------------------------------------------------------------------------
// Server usage stats (cached briefly — these calls hit the filesystem).
// ---------------------------------------------------------------------------
let statsCache = null, statsCacheAt = 0;
function diskInfo(p) {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, free, used: total - free };
  } catch { return null; }
}
function libraryBytes() {
  let total = 0;
  for (const item of library) { try { total += fs.statSync(item.full).size; } catch {} }
  return total;
}
function buildStats() {
  const now = Date.now();
  if (statsCache && now - statsCacheAt < 5000) return statsCache;
  const mem = { total: os.totalmem(), free: os.freemem() }; mem.used = mem.total - mem.free;
  const active = [...downloads.values()].filter(j => ['starting', 'downloading', 'processing'].includes(j.status)).length;
  statsCache = {
    videos: library.length,
    libraryBytes: libraryBytes(),
    disk: diskInfo(config.mediaDir),
    mem,
    cpu: { count: os.cpus().length, load: os.loadavg() },
    uptime: { process: process.uptime(), system: os.uptime() },
    activeDownloads: active,
    node: process.version,
    platform: os.platform() + ' ' + os.release()
  };
  statsCacheAt = now;
  return statsCache;
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
    hasThumb: !!job.thumbUrl,
    folder: job.folderRel || '',
    playlist: !!job.playlist,
    playlistIndex: job.playlistIndex || 0,
    playlistCount: job.playlistCount || 0
  };
}

// Flat playlist probe — title + entry count, no per-video metadata.
function fetchPlaylistMeta(url) {
  return new Promise((resolve) => {
    execFile('yt-dlp', ['-J', '--flat-playlist', '--yes-playlist', '--no-warnings', '--no-progress', ...ytNet(), url],
      { maxBuffer: 64 * 1024 * 1024, timeout: 45000 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(stdout);
          resolve({ title: j.title || j.playlist_title || 'Playlist', count: Array.isArray(j.entries) ? j.entries.length : 0 });
        } catch { resolve(null); }
      });
  });
}

// Full flat playlist listing — every entry (index, title, duration, thumbnail)
// so the UI can show what's in a playlist before downloading.
function fetchPlaylistEntries(url) {
  return new Promise((resolve) => {
    execFile('yt-dlp', ['-J', '--flat-playlist', '--yes-playlist', '--no-warnings', '--no-progress', ...ytNet(), url],
      { maxBuffer: 192 * 1024 * 1024, timeout: 90000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = ((stderr || err.message || '').split('\n').filter(Boolean).pop() || 'Could not read playlist.')
            .replace(/^ERROR:\s*/, '').slice(0, 300);
          return resolve({ error: netHint(msg) });
        }
        try {
          const j = JSON.parse(stdout);
          const arr = Array.isArray(j.entries) ? j.entries : [];
          const entries = arr.slice(0, 1000).map((e, i) => {
            let thumb = e.thumbnail || '';
            if (!thumb && Array.isArray(e.thumbnails) && e.thumbnails.length) thumb = e.thumbnails[e.thumbnails.length - 1].url || '';
            return {
              index: e.playlist_index || (i + 1),
              id: e.id || '',
              title: e.title || e.url || ('Item ' + (i + 1)),
              duration: Math.round(e.duration || 0),
              thumb
            };
          });
          resolve({ title: j.title || j.playlist_title || 'Playlist', count: entries.length, entries });
        } catch { resolve({ error: 'Could not parse the playlist response.' }); }
      });
  });
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
    execFile('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '--no-progress', ...ytNet(), url],
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

function startDownload(url, { folder = '', playlist = false, items = null } = {}) {
  const id = randToken(8);
  const selItems = Array.isArray(items) ? items.filter(n => Number.isInteger(n) && n > 0) : null;
  // Resolve the destination folder (created if missing); default = media root.
  const destAbs = safePath(folder) || MEDIA_ROOT;
  fs.mkdirSync(destAbs, { recursive: true });
  // A per-folder archive lets re-pasting a link skip already-downloaded items.
  const archive = join(destAbs, '.downloaded.txt');
  // yt-dlp builds folders from the template; forward slashes work cross-platform.
  const outTemplate = playlist
    ? `${destAbs}/%(playlist_title,playlist_id|Playlist)s/%(playlist_index)03d - %(title).180B [%(id)s].%(ext)s`
    : `${destAbs}/%(title).200B [%(id)s].%(ext)s`;

  const job = {
    id, status: 'starting', percent: 0, speed: '', eta: '',
    message: playlist ? 'Reading playlist…' : 'Preparing download…',
    url, folderRel: folder, destAbs, playlist,
    playlistIndex: 0, playlistCount: 0, itemPercent: 0,
    title: '', uploader: '', duration: 0,
    downloadedBytes: 0, totalBytes: 0,
    thumbUrl: '', thumbBuf: null, thumbType: ''
  };
  downloads.set(id, job);

  if (selItems && selItems.length) job.playlistCount = selItems.length;

  // Probe metadata in the background and stream it to the UI.
  if (playlist) {
    fetchPlaylistMeta(url).then(meta => {
      if (!meta || ['cancelled', 'done', 'error'].includes(job.status)) return;
      job.title = meta.title;
      if (!selItems) job.playlistCount = meta.count || 0;
      emit(id);
    });
  } else {
    fetchMeta(url).then(meta => {
      if (!meta || ['cancelled', 'done', 'error'].includes(job.status)) return;
      job.title = meta.title; job.uploader = meta.uploader;
      job.duration = meta.duration; job.thumbUrl = meta.thumbUrl;
      if (!job.totalBytes && meta.totalBytes) job.totalBytes = meta.totalBytes;
      emit(id);
    });
  }

  // --progress-template emits machine-readable byte/speed/eta fields.
  const args = [
    '--newline', '--no-mtime', '--no-warnings',
    '--ignore-errors',                  // one bad playlist item shouldn't abort the rest
    '--download-archive', archive,      // skip items already pulled into this folder
    ...ytNet(),
    playlist ? '--yes-playlist' : '--no-playlist',
    '-o', outTemplate,
    '--merge-output-format', 'mp4',
    '--progress-template',
    'PROG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    url
  ];
  // Download only the chosen playlist items (one by one), in order.
  if (playlist && selItems && selItems.length) {
    args.splice(args.length - 1, 0, '--playlist-items', selItems.join(','));
  }

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
    // Playlist progress: "Downloading item N of M".
    const pitem = /Downloading (?:item|video) (\d+) of (\d+)/.exec(line);
    if (pitem) {
      job.playlistIndex = parseInt(pitem[1], 10);
      job.playlistCount = Math.max(job.playlistCount, parseInt(pitem[2], 10));
      job.itemPercent = 0; job.status = 'downloading';
      job.message = `Item ${job.playlistIndex} of ${job.playlistCount}`;
      emit(id);
      return;
    }
    // Machine-readable progress from --progress-template (fields may be "NA").
    if (line.startsWith('PROG|')) {
      const [, , dlb, tb, tbe, sp, eta] = line.split('|');
      const downloaded = parseInt(dlb, 10) || 0;
      const total = parseInt(tb, 10) || parseInt(tbe, 10) || 0;
      const speed = parseFloat(sp) || 0;
      const etaN = parseInt(eta, 10);
      job.downloadedBytes = downloaded;
      if (total) job.totalBytes = total;
      const itemFrac = total ? Math.min(1, downloaded / total) : 0;
      job.itemPercent = itemFrac * 100;
      if (job.playlist && job.playlistCount)
        job.percent = Math.min(100, ((Math.max(1, job.playlistIndex) - 1) + itemFrac) / job.playlistCount * 100);
      else if (total) job.percent = itemFrac * 100;
      job.speed = speed ? humanSize(speed) + '/s' : '';
      job.eta = (isFinite(etaN) && etaN >= 0) ? fmtEta(etaN) : '';
      job.message = job.playlist
        ? `Item ${job.playlistIndex || 1}${job.playlistCount ? '/' + job.playlistCount : ''} · ${job.itemPercent.toFixed(0)}%`
        : `Downloading ${job.percent.toFixed(1)}%`;
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
      job.message = 'Cancelled';
      rescan(); buildMeta().catch(() => {}); pruneEmptyDirs(destAbs);
      emit(id);
    } else if (code === 0) {
      job.status = 'done'; job.percent = 100;
      job.message = job.playlist ? 'Playlist saved to your library' : 'Saved to your library';
      rescan(); buildMeta().catch(() => {}); pruneEmptyDirs(destAbs);
      emit(id);
    } else {
      job.status = 'error';
      job.message = netHint((errTail.trim().split('\n').pop() || 'Download failed').slice(0, 200));
      rescan(); buildMeta().catch(() => {}); pruneEmptyDirs(destAbs);
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
  secret: secrets.sessionSecret,
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

// Tells the login page whether to show sign-in or first-run signup.
app.get('/api/setup-state', (req, res) => res.json({ hasAccount: hasAccount() }));

// First-run signup — allowed only while no account exists.
app.post('/api/signup', (req, res) => {
  if (hasAccount()) return res.status(403).json({ error: 'An account already exists. Please sign in.' });
  const email = (req.body?.email || '').trim();
  const password = req.body?.password || '';
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  config.email = email;
  config.passwordHash = bcrypt.hashSync(password, 10);
  saveConfig();
  req.session.user = email;
  res.json({ ok: true });
});

// Change email / password for the signed-in account.
app.post('/api/change-password', requireAuth, (req, res) => {
  const current = req.body?.currentPassword || '';
  const newPassword = req.body?.newPassword || '';
  const newEmail = (req.body?.email || '').trim();
  if (!bcrypt.compareSync(current, config.passwordHash))
    return res.status(401).json({ error: 'Current password is incorrect.' });
  if (newPassword && newPassword.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  if (newEmail && !EMAIL_RE.test(newEmail))
    return res.status(400).json({ error: 'Enter a valid email address.' });
  if (newEmail) config.email = newEmail;
  if (newPassword) config.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveConfig();
  req.session.user = config.email;
  res.json({ ok: true });
});

// Library listing — scoped to a folder (default root), optionally recursive.
app.get('/api/videos', requireAuth, (req, res) => {
  const folder = String(req.query.folder || '').replace(/^[/\\]+/, '');
  const recursive = req.query.recursive === '1';
  const all = req.query.all === '1';
  let list = library;
  if (!all) list = library.filter(v => recursive ? (v.dir === folder || v.dir.startsWith(folder + (folder ? '/' : ''))) : v.dir === folder);
  res.json(list.map(v => ({ id: v.id, name: v.name, dir: v.dir, ...quickMeta(v) })));
});

// Folder tree (for the sidebar).
app.get('/api/tree', requireAuth, (req, res) => res.json(buildTree()));

// Create a folder under `parent`.
app.post('/api/folders', requireAuth, (req, res) => {
  const parent = String(req.body?.parent || '').replace(/^[/\\]+/, '');
  const name = String(req.body?.name || '').trim();
  if (!name || /[/\\]/.test(name) || name.startsWith('.')) return res.status(400).json({ error: 'Invalid folder name.' });
  const abs = safePath((parent ? parent + '/' : '') + name);
  if (!abs || abs === MEDIA_ROOT) return res.status(400).json({ error: 'Invalid path.' });
  if (fs.existsSync(abs)) return res.status(409).json({ error: 'A folder with that name already exists.' });
  try { fs.mkdirSync(abs, { recursive: true }); } catch { return res.status(500).json({ error: 'Could not create folder.' }); }
  res.json({ ok: true });
});

// Rename a folder (within its parent).
app.patch('/api/folders', requireAuth, (req, res) => {
  const p = String(req.body?.path || '').replace(/^[/\\]+/, '');
  const name = String(req.body?.name || '').trim();
  if (!p) return res.status(400).json({ error: 'Cannot rename the root.' });
  if (!name || /[/\\]/.test(name) || name.startsWith('.')) return res.status(400).json({ error: 'Invalid folder name.' });
  const abs = safePath(p);
  if (!abs || abs === MEDIA_ROOT) return res.status(400).json({ error: 'Invalid path.' });
  const dest = join(dirname(abs), name);
  if (dest !== MEDIA_ROOT && !dest.startsWith(MEDIA_ROOT + sep)) return res.status(400).json({ error: 'Invalid path.' });
  if (fs.existsSync(dest)) return res.status(409).json({ error: 'A folder with that name already exists.' });
  try { fs.renameSync(abs, dest); } catch { return res.status(500).json({ error: 'Rename failed.' }); }
  rescan(); buildMeta().catch(() => {});
  res.json({ ok: true });
});

// Delete a folder and everything inside it.
app.delete('/api/folders', requireAuth, (req, res) => {
  const p = String(req.body?.path || '').replace(/^[/\\]+/, '');
  const abs = safePath(p);
  if (!abs || abs === MEDIA_ROOT) return res.status(400).json({ error: 'Cannot delete the root folder.' });
  try { fs.rmSync(abs, { recursive: true, force: true }); } catch { return res.status(500).json({ error: 'Delete failed.' }); }
  rescan(); buildMeta().catch(() => {});
  res.json({ ok: true });
});

// Bulk delete videos by id.
app.delete('/api/videos', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  let deleted = 0;
  for (const id of ids) {
    const item = library.find(v => v.id === id);
    if (!item) continue;
    try { fs.rmSync(item.full, { force: true }); cleanupArtifacts(id); pruneEmptyDirs(dirname(item.full)); deleted++; } catch {}
  }
  rescan();
  res.json({ deleted });
});

// Rename one video (keeps its folder + extension).
app.patch('/api/videos/:id', requireAuth, (req, res) => {
  const item = library.find(v => v.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  const name = String(req.body?.name || '').trim();
  if (!name || /[/\\]/.test(name)) return res.status(400).json({ error: 'Invalid name.' });
  const ext = extname(item.full);
  const dest = join(dirname(item.full), name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext);
  if (!dest.startsWith(MEDIA_ROOT + sep)) return res.status(400).json({ error: 'Invalid path.' });
  if (dest !== item.full && fs.existsSync(dest)) return res.status(409).json({ error: 'A file with that name already exists.' });
  try { fs.renameSync(item.full, dest); cleanupArtifacts(item.id); } catch { return res.status(500).json({ error: 'Rename failed.' }); }
  rescan(); buildMeta().catch(() => {});
  res.json({ ok: true });
});

// Bulk move videos to a destination folder.
app.post('/api/videos/move', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const dest = safePath(String(req.body?.folder || '').replace(/^[/\\]+/, ''));
  if (!dest) return res.status(400).json({ error: 'Invalid destination.' });
  try { fs.mkdirSync(dest, { recursive: true }); } catch {}
  let moved = 0;
  for (const id of ids) {
    const item = library.find(v => v.id === id);
    if (!item) continue;
    const target = join(dest, basename(item.full));
    if (target === item.full || fs.existsSync(target)) continue;
    try { fs.renameSync(item.full, target); cleanupArtifacts(id); pruneEmptyDirs(dirname(item.full)); moved++; } catch {}
  }
  rescan(); buildMeta().catch(() => {});
  res.json({ moved });
});

// Full metadata for one video (resolution, codecs, bitrate, fps, size…).
app.get('/api/videos/:id/info', requireAuth, async (req, res) => {
  const item = library.find(v => v.id === req.params.id);
  if (!item) return res.status(404).end();
  const meta = await getMeta(item);
  res.json({ id: item.id, name: item.name, ext: extname(item.full).slice(1).toLowerCase(), ...meta });
});

// Scrub-preview sprite sheet + its WebVTT index (peek thumbnails).
app.get('/api/videos/:id/sprite.jpg', requireAuth, async (req, res) => {
  const item = library.find(v => v.id === req.params.id);
  if (!item) return res.status(404).end();
  const sp = await ensureSprite(item);
  if (!sp) return res.status(404).end();
  res.sendFile(sp.jpg);
});
app.get('/api/videos/:id/thumbs.vtt', requireAuth, async (req, res) => {
  const item = library.find(v => v.id === req.params.id);
  if (!item) return res.status(404).end();
  const sp = await ensureSprite(item);
  if (!sp) return res.status(404).end();
  res.type('text/vtt').sendFile(sp.vtt);
});

// Download the original file to the client.
app.get('/api/videos/:id/download', requireAuth, (req, res) => {
  const item = library.find(v => v.id === req.params.id);
  if (!item) return res.status(404).end();
  res.download(item.full, item.name + extname(item.full));
});

// Overall server usage.
app.get('/api/stats', requireAuth, (req, res) => res.json(buildStats()));

app.post('/api/rescan', requireAuth, (req, res) => {
  const count = rescan().length;
  buildMeta().catch(() => {});
  res.json({ count });
});

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
  const folder = String(req.body?.folder || '').replace(/^[/\\]+/, '');
  if (folder && !safePath(folder)) return res.status(400).json({ error: 'Invalid destination folder.' });
  const playlist = !!req.body?.playlist;
  const items = Array.isArray(req.body?.items) ? req.body.items.map(Number) : null;
  const job = startDownload(url, { folder, playlist, items });
  res.json({ id: job.id, status: job.status });
});

// Preview a playlist's contents (flat) before downloading.
app.post('/api/playlist/probe', requireAuth, async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Paste a valid http(s) link.' });
  res.json(await fetchPlaylistEntries(url));
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
// GitHub's CDN now 400s the short raw form (raw.githubusercontent.com/o/r/main/…);
// the canonical refs/heads/<branch> form works. Rewrite branch refs (leave SHAs).
function normalizeUpdateUrl(u) {
  try {
    return String(u).replace(
      /(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)(?!refs\/)([^/]+)(\/)/,
      (m, pre, ref, post) => /^[0-9a-f]{40}$/i.test(ref) ? m : `${pre}refs/heads/${ref}${post}`
    );
  } catch { return u; }
}
const UPDATE_URL = normalizeUpdateUrl(process.env.SV_UPDATE_URL || config.updateUrl ||
  'https://raw.githubusercontent.com/thakursat/hosted-video-streamer/refs/heads/main/streamvault-app.tar.gz');

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
