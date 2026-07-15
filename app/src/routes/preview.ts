import { Router } from 'express';
import fs from 'fs';
import { requireAuth } from '../middleware/auth';
import { findById } from '../services/library';
import { ensurePreview, deletePreview, previewSpriteFile, touchPreview } from '../services/preview';

const router = Router();

// Generate (if needed) and return the scrub-preview sprite layout for a video.
router.get('/preview/:id', requireAuth, async (req, res) => {
  const v = findById(req.params['id'] as string);
  if (!v) { res.status(404).json({ error: 'Not found' }); return; }
  try {
    const meta = await ensurePreview(v);
    res.json({ ...meta, spriteUrl: `/api/preview/${v.id}/sprite.jpg` });
  } catch {
    res.status(500).json({ error: 'Preview generation failed' });
  }
});

// Serve the sprite image. Not cached — it's a throwaway file for this session.
router.get('/preview/:id/sprite.jpg', requireAuth, (req, res) => {
  const id = req.params['id'] as string;
  const file = previewSpriteFile(id);
  if (!fs.existsSync(file)) { res.status(404).end(); return; }
  touchPreview(id);
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
});

// Delete the sprite when the player closes — keeps disk usage at zero when idle.
router.delete('/preview/:id', requireAuth, (req, res) => {
  deletePreview(req.params['id'] as string);
  res.json({ ok: true });
});

export default router;
