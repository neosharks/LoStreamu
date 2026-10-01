import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { findById, getLibrary } from '../services/library';
import { listFavorites, setFavorite, isFavorite } from '../services/favorites';
import { projectVideo } from '../services/videoView';

const router = Router();

// The starred videos for the signed-in profile, newest star last — the same
// shape as /api/videos so the library grid renders it without a special case.
router.get('/favorites', requireAuth, (req, res) => {
  const userId = req.user!.id;
  const starred = new Set(listFavorites(userId));
  const items = getLibrary().filter(v => starred.has(v.relPath));
  res.json(items.map(v => projectVideo(v, true)));
});

router.post('/videos/:id/favorite', requireAuth, (req, res) => {
  const v = findById(req.params['id'] as string);
  if (!v) { res.status(404).json({ error: 'Not found' }); return; }
  const userId = req.user!.id;
  // No body means "flip it" — what tapping the star does.
  const on = typeof req.body?.favorite === 'boolean'
    ? req.body.favorite as boolean
    : !isFavorite(userId, v.relPath);
  res.json({ ok: true, favorite: setFavorite(userId, v.relPath, on) });
});

export default router;
