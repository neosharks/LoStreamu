import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { findById, getLibrary } from '../services/library';
import { healthOf, resolveHealth } from '../services/health';
import { enqueueRepair, enqueueFolderRepair, listRepairJobs, cancelRepair } from '../services/repair';

const router = Router();

// What is wrong with one video, and what fixing it would involve.
router.get('/videos/:id/health', requireAuth, async (req, res) => {
  const v = findById(req.params['id'] as string);
  if (!v) { res.status(404).json({ error: 'Not found' }); return; }
  // Probes on the spot when the background pass has not reached this file — the
  // player asks this question only after playback has already failed.
  res.json(await resolveHealth(v));
});

// How many videos in a folder need attention — drives the "Fix N videos" button.
router.get('/folders/health', requireAuth, (req, res) => {
  const folder = String(req.query['folder'] || '').replace(/^[/\\]+/, '');
  const deep = req.query['deep'] !== '0';
  const prefix = folder ? folder + '/' : '';
  let broken = 0;
  let warn = 0;
  for (const v of getLibrary()) {
    if (folder && v.folder !== folder && !(deep && v.folder.startsWith(prefix))) continue;
    const health = healthOf(v);
    if (!health) continue;   // not probed yet — unknown is not the same as broken
    if (health.level === 'broken') broken++;
    else if (health.level === 'warn') warn++;
  }
  res.json({ broken, warn, total: broken + warn });
});

router.post('/videos/:id/repair', requireAuth, (req, res) => {
  const v = findById(req.params['id'] as string);
  if (!v) { res.status(404).json({ error: 'Not found' }); return; }
  const plan = z.enum(['remux', 'transcode']).safeParse(req.body?.plan);
  res.json(enqueueRepair(v, plan.success ? plan.data : undefined));
});

router.post('/repair/folder', requireAuth, (req, res) => {
  const folder = String(req.body?.folder ?? '').replace(/^[/\\]+/, '');
  const deep = req.body?.deep !== false;
  const jobs = enqueueFolderRepair(folder, deep);
  res.json({ ok: true, queued: jobs.length, jobs });
});

router.get('/repair', requireAuth, (_req, res) => res.json(listRepairJobs()));

router.post('/repair/:jobId/cancel', requireAuth, (req, res) => {
  const ok = cancelRepair(req.params['jobId'] as string);
  if (!ok) { res.status(404).json({ error: 'No such repair is running.' }); return; }
  res.json({ ok: true });
});

export default router;
