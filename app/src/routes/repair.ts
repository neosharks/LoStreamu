import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { findById, getLibrary } from '../services/library';
import { healthOf, resolveHealth } from '../services/health';
import {
  enqueueRepair, enqueueRepairs, enqueueFolderRepair, listRepairJobs, cancelRepair,
} from '../services/repair';

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

// `deleteIfUnfixable` destroys the original when the rebuild fails, so it is
// never inferred — the caller has to ask for it explicitly, every time.
const RepairOptionsSchema = z.object({
  plan: z.enum(['remux', 'transcode']).optional(),
  deleteIfUnfixable: z.boolean().optional(),
});

router.post('/videos/:id/repair', requireAuth, (req, res) => {
  const v = findById(req.params['id'] as string);
  if (!v) { res.status(404).json({ error: 'Not found' }); return; }
  const parsed = RepairOptionsSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid repair options.' }); return; }
  res.json(enqueueRepair(v, parsed.data));
});

// Repair a hand-picked set — what the library's bulk selection sends.
router.post('/repair/videos', requireAuth, (req, res) => {
  const schema = RepairOptionsSchema.extend({ ids: z.array(z.string()).min(1) });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'ids array required.' }); return; }
  const { ids, ...options } = parsed.data;
  const jobs = enqueueRepairs(ids, options);
  res.json({ ok: true, queued: jobs.length, jobs });
});

router.post('/repair/folder', requireAuth, (req, res) => {
  const parsed = RepairOptionsSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid repair options.' }); return; }
  const folder = String(req.body?.folder ?? '').replace(/^[/\\]+/, '');
  const deep = req.body?.deep !== false;
  const jobs = enqueueFolderRepair(folder, deep, parsed.data);
  res.json({ ok: true, queued: jobs.length, jobs });
});

router.get('/repair', requireAuth, (_req, res) => res.json(listRepairJobs()));

router.post('/repair/:jobId/cancel', requireAuth, (req, res) => {
  const ok = cancelRepair(req.params['jobId'] as string);
  if (!ok) { res.status(404).json({ error: 'No such repair is running.' }); return; }
  res.json({ ok: true });
});

export default router;
