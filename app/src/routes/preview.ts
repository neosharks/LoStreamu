import { Router } from 'express';
import fs from 'fs';
import { requireAuth } from '../middleware/auth';
import { findById } from '../services/library';
import { requestPreview, deletePreview, previewFrameFile, touchPreview } from '../services/preview';

const router = Router();

// Kick off (or report) scrub-preview generation. Returns immediately: either
// { status:'generating', progress } or { status:'ready', count, interval, ... }.
router.get('/preview/:id', requireAuth, (req, res) => {
  const v = findById(req.params['id'] as string);
  if (!v) { res.status(404).json({ error: 'Not found' }); return; }
  const st = requestPreview(v);
  if (st.status === 'ready') {
    res.json({ status: 'ready', ...st.meta, frameBase: `/api/preview/${v.id}/frame/` });
  } else if (st.status === 'generating') {
    res.json({ status: 'generating', progress: st.progress });
  } else {
    res.status(500).json({ status: 'error' });
  }
});

// Serve one preview frame. Throwaway file — never cached.
router.get('/preview/:id/frame/:n.jpg', requireAuth, (req, res) => {
  const id = req.params['id'] as string;
  const n = Number(req.params['n']);
  if (!Number.isInteger(n) || n < 0) { res.status(400).end(); return; }
  const file = previewFrameFile(id, n);
  if (!fs.existsSync(file)) { res.status(404).end(); return; }
  touchPreview(id);
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
});

// Delete all frames when the player closes — keeps disk at zero when idle.
router.delete('/preview/:id', requireAuth, (req, res) => {
  deletePreview(req.params['id'] as string);
  res.json({ ok: true });
});

export default router;
