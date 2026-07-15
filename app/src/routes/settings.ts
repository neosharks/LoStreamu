import { Router } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../middleware/auth';
import { getConfig, saveConfig, APP_DIR } from '../config';
import { getYtDlpVersion, updateYtDlp } from '../services/ytdlp';
import { cleanJunk, regenerateThumbnails } from '../services/maintenance';

const router = Router();

router.get('/settings', requireAuth, (_req, res) => {
  res.json({ proxy: getConfig().proxy || '' });
});

router.post('/settings', requireAuth, (req, res) => {
  const schema = z.object({
    proxy: z.string().refine(
      v => !v || /^https?:\/\/|^socks[45]?:\/\//i.test(v),
      'Proxy must be http://, https://, or socks5:// URL, or leave blank.',
    ),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message }); return;
  }
  saveConfig({ proxy: parsed.data.proxy });
  res.json({ ok: true, proxy: parsed.data.proxy });
});

let _appLatestCache: { version: string | null; at: number } = { version: null, at: 0 };
const APP_VERSION_TTL = 6 * 60 * 60 * 1000;

router.get('/app/version', requireAuth, async (_req, res) => {
  let current: string | null = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
    current = pkg.version ?? null;
  } catch {}

  const now = Date.now();
  if (!_appLatestCache.version || now - _appLatestCache.at > APP_VERSION_TTL) {
    try {
      const r = await fetch(
        'https://raw.githubusercontent.com/neosharks/LoStreamu/main/app/package.json',
        { headers: { 'User-Agent': 'streamvault/2' } },
      );
      const data = await r.json() as { version?: string };
      _appLatestCache = { version: data.version ?? null, at: now };
    } catch {}
  }

  const latest = _appLatestCache.version;
  res.json({ current, latest, updateAvailable: !!(current && latest && current !== latest) });
});

router.get('/ytdlp/version', requireAuth, async (_req, res) => {
  try {
    const info = await getYtDlpVersion();
    res.json(info);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ytdlp/update', requireAuth, async (_req, res) => {
  try {
    await updateYtDlp();
    const info = await getYtDlpVersion();
    res.json({ ok: true, version: info.current });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Maintenance ────────────────────────────────────────────────────────────
// Delete orphaned thumbnails, yt-dlp temp/partial leftovers, stale meta-cache
// entries and empty folders. Real videos are never touched.
router.post('/maintenance/clean', requireAuth, (_req, res) => {
  try {
    res.json({ ok: true, ...cleanJunk() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Re-run thumbnail generation for videos missing a valid thumbnail (or all when
// ?force=1). Can take a while on large libraries; ffmpeg fan-out is bounded.
router.post('/maintenance/thumbnails', requireAuth, async (req, res) => {
  try {
    const force = req.query.force === '1';
    res.json({ ok: true, ...(await regenerateThumbnails(force)) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
