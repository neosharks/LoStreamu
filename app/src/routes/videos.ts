import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import {
  getLibrary, buildTree, findById, rescan, safePath, pruneEmptyDirs, getMediaRoot, purgeMetaEntry,
} from '../services/library';
import { thumbPath, spritePath, vttPath, invalidateThumb } from '../services/media';

const router = Router();

// ── Library ───────────────────────────────────────────────────────────────────

router.get('/videos', requireAuth, (req, res) => {
  const folder = String(req.query.folder || '').replace(/^[/\\]+/, '');
  const all = req.query.all === '1';
  let items = getLibrary();
  if (!all) {
    items = items.filter(v =>
      v.folder === folder || v.folder.startsWith(folder ? folder + '/' : ''),
    );
  }
  res.json(items.map(v => ({
    id: v.id, name: v.name, ext: v.ext, folder: v.folder,
    size: v.size, addedAt: v.addedAt, duration: v.duration,
    width: v.width, height: v.height,
  })));
});

router.get('/tree', requireAuth, (_req, res) => res.json(buildTree()));

router.get('/videos/:id/info', requireAuth, (req, res) => {
  const v = findById(req.params["id"] as string);
  if (!v) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(v);
});

// Download original file to browser
router.get('/videos/:id/download', requireAuth, (req, res) => {
  const v = findById(req.params["id"] as string);
  if (!v) { res.status(404).json({ error: 'Not found' }); return; }
  res.download(v.absPath, `${v.name}${v.ext}`);
});

// ── CRUD ──────────────────────────────────────────────────────────────────────

router.patch('/videos/:id', requireAuth, (req, res) => {
  const v = findById(req.params["id"] as string);
  if (!v) { res.status(404).json({ error: 'Not found' }); return; }
  const name = String(req.body?.name || '').trim();
  if (!name || /[/\\<>:"|?*]/.test(name)) { res.status(400).json({ error: 'Invalid name.' }); return; }
  const newAbs = path.join(path.dirname(v.absPath), name + v.ext);
  if (fs.existsSync(newAbs)) { res.status(409).json({ error: 'Name already exists.' }); return; }
  fs.renameSync(v.absPath, newAbs);
  rescan();
  res.json({ ok: true });
});

router.delete('/videos', requireAuth, (req, res) => {
  const ids = z.array(z.string()).safeParse(req.body?.ids);
  if (!ids.success) { res.status(400).json({ error: 'ids array required.' }); return; }
  for (const id of ids.data) {
    const v = findById(id);
    if (!v) continue;
    try { fs.rmSync(v.absPath, { force: true }); pruneEmptyDirs(path.dirname(v.absPath)); } catch {}
    for (const p of [thumbPath(id), spritePath(id), vttPath(id)]) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }
    invalidateThumb(id);
    purgeMetaEntry(id);
  }
  rescan();
  res.json({ ok: true });
});

router.post('/videos/move', requireAuth, (req, res) => {
  const ids = z.array(z.string()).safeParse(req.body?.ids);
  const dest = String(req.body?.folder ?? '');
  if (!ids.success) { res.status(400).json({ error: 'ids array required.' }); return; }
  const destAbs = dest ? safePath(dest) : getMediaRoot();
  if (!destAbs) { res.status(400).json({ error: 'Invalid destination.' }); return; }
  fs.mkdirSync(destAbs, { recursive: true });
  for (const id of ids.data) {
    const v = findById(id);
    if (!v) continue;
    try { fs.renameSync(v.absPath, path.join(destAbs, v.name + v.ext)); pruneEmptyDirs(path.dirname(v.absPath)); } catch {}
  }
  rescan();
  res.json({ ok: true });
});

// ── Folders ───────────────────────────────────────────────────────────────────

router.post('/folders', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const parent = String(req.body?.parent || '');
  if (!name || /[<>:"|?*\\]/.test(name)) { res.status(400).json({ error: 'Invalid folder name.' }); return; }
  const parentAbs = parent ? safePath(parent) : getMediaRoot();
  if (!parentAbs) { res.status(400).json({ error: 'Invalid parent.' }); return; }
  fs.mkdirSync(path.join(parentAbs, name), { recursive: true });
  res.json({ ok: true });
});

router.patch('/folders', requireAuth, (req, res) => {
  const folder = String(req.body?.folder || '');
  const name = String(req.body?.name || '').trim();
  if (!name || /[<>:"|?*\\]/.test(name)) { res.status(400).json({ error: 'Invalid name.' }); return; }
  const abs = safePath(folder);
  if (!abs || !fs.existsSync(abs)) { res.status(404).json({ error: 'Folder not found.' }); return; }
  const newAbs = path.join(path.dirname(abs), name);
  if (fs.existsSync(newAbs)) { res.status(409).json({ error: 'Name already in use.' }); return; }
  fs.renameSync(abs, newAbs);
  rescan();
  res.json({ ok: true });
});

router.delete('/folders', requireAuth, (req, res) => {
  const folder = String(req.body?.folder || '');
  const abs = safePath(folder);
  if (!abs || !fs.existsSync(abs)) { res.status(404).json({ error: 'Folder not found.' }); return; }
  for (const v of getLibrary()) {
    if (!v.absPath.startsWith(abs + path.sep) && v.absPath !== abs) continue;
    for (const p of [thumbPath(v.id), spritePath(v.id), vttPath(v.id)]) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }
    purgeMetaEntry(v.id);
  }
  fs.rmSync(abs, { recursive: true, force: true });
  rescan();
  res.json({ ok: true });
});

router.post('/folders/move', requireAuth, (req, res) => {
  const folder = String(req.body?.folder || '');
  const dest = String(req.body?.dest ?? '');
  const abs = safePath(folder);
  if (!abs || !fs.existsSync(abs)) { res.status(404).json({ error: 'Folder not found.' }); return; }
  const destAbs = dest ? (safePath(dest) || getMediaRoot()) : getMediaRoot();
  const newAbs = path.join(destAbs, path.basename(abs));
  if (abs === newAbs) { res.json({ ok: true }); return; }
  if (newAbs.startsWith(abs + path.sep)) { res.status(400).json({ error: 'Cannot move a folder into itself.' }); return; }
  if (fs.existsSync(newAbs)) { res.status(409).json({ error: 'A folder with that name already exists there.' }); return; }
  fs.mkdirSync(destAbs, { recursive: true });
  fs.renameSync(abs, newAbs);
  rescan();
  res.json({ ok: true });
});

// Returns relative paths of folders that contain a yt-dlp download archive (.downloaded.txt)
router.get('/folders/archives', requireAuth, (_req, res) => {
  const root = getMediaRoot();
  const result: string[] = [];
  function scan(dir: string, rel: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (entries.some(e => e.isFile() && e.name === '.downloaded.txt')) result.push(rel);
      for (const e of entries) if (e.isDirectory()) scan(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
    } catch {}
  }
  scan(root, '');
  res.json(result);
});

// ── Rescan + Stats ────────────────────────────────────────────────────────────

router.post('/rescan', requireAuth, (_req, res) => {
  rescan();
  res.json({ ok: true, count: getLibrary().length });
});

router.get('/stats', requireAuth, (_req, res) => {
  const lib = getLibrary();
  const root = getMediaRoot();

  let disk: { used: number; total: number } | undefined;
  try {
    const out = execSync(`df -k "${root}"`, { timeout: 3000 }).toString();
    const parts = out.trim().split('\n')[1]?.split(/\s+/) || [];
    if (parts.length >= 4) {
      const total = Number(parts[1]) * 1024;
      const avail = Number(parts[3]) * 1024;
      disk = { total, used: total - avail };
    }
  } catch {}

  const totalMem = os.totalmem();
  res.json({
    videos: lib.length,
    libraryBytes: lib.reduce((s, v) => s + v.size, 0),
    disk,
    mem: { total: totalMem, used: totalMem - os.freemem() },
    cpu: { count: os.cpus().length, load: os.loadavg() },
    uptime: { process: process.uptime(), system: os.uptime() },
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    activeDownloads: 0,
  });
});

export default router;
