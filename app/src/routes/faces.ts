import { Router } from 'express';
import fs from 'fs';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { getLibrary } from '../services/library';
import { listFavorites } from '../services/favorites';
import { projectVideo } from '../services/videoView';
import { startIndexing, stopIndexing, getIndexStatus } from '../services/faces';
import {
  listPeople, videosForPerson, peopleInVideo, renamePerson, mergePeople, deletePerson,
  faceThumbPath, resetFaces, indexedCount,
} from '../services/faces/store';
import { modelsPresent, modelSize } from '../services/faces/models';

const router = Router();

router.get('/faces/status', requireAuth, (_req, res) => {
  res.json({
    ...getIndexStatus(),
    indexed: indexedCount(),
    library: getLibrary().length,
    modelsReady: modelsPresent(),
    model: modelSize(),
  });
});

// Kick off a scan. Returns immediately — poll /faces/status for progress.
router.post('/faces/scan', requireAuth, (req, res) => {
  const folder = typeof req.body?.folder === 'string' ? req.body.folder.replace(/^[/\\]+/, '') : undefined;
  res.json(startIndexing({
    ...(folder !== undefined && { folder }),
    deep: req.body?.deep !== false,
    force: req.body?.force === true,
  }));
});

router.post('/faces/stop', requireAuth, (_req, res) => {
  stopIndexing();
  res.json({ ok: true });
});

// Throw the whole index away — what to do when clustering has gone sideways and
// starting over is easier than merging by hand.
router.delete('/faces', requireAuth, (_req, res) => {
  stopIndexing();
  resetFaces();
  res.json({ ok: true });
});

router.get('/faces/people', requireAuth, (_req, res) => res.json(listPeople()));

router.get('/faces/people/:id/videos', requireAuth, (req, res) => {
  const paths = new Set(videosForPerson(req.params['id'] as string));
  const starred = new Set(listFavorites(req.user!.id));
  const items = getLibrary().filter(v => paths.has(v.relPath));
  res.json(items.map(v => projectVideo(v, starred.has(v.relPath))));
});

// Who appears in one video — shown in the player so a face can be named from
// where you recognised it.
router.get('/videos/:id/faces', requireAuth, (req, res) => {
  const video = getLibrary().find(v => v.id === req.params['id']);
  if (!video) { res.status(404).json({ error: 'Not found' }); return; }
  const names = new Map(listPeople().map(p => [p.id, p]));
  res.json(peopleInVideo(video.relPath).map(ref => ({
    ...ref,
    name: names.get(ref.personId)?.name ?? '',
  })));
});

router.patch('/faces/people/:id', requireAuth, (req, res) => {
  const name = z.string().max(60).safeParse(req.body?.name);
  if (!name.success) { res.status(400).json({ error: 'A name is required.' }); return; }
  if (!renamePerson(req.params['id'] as string, name.data.trim())) {
    res.status(404).json({ error: 'No such person.' }); return;
  }
  res.json({ ok: true });
});

router.post('/faces/people/merge', requireAuth, (req, res) => {
  const target = z.string().safeParse(req.body?.target);
  const sources = z.array(z.string()).min(1).safeParse(req.body?.sources);
  if (!target.success || !sources.success) {
    res.status(400).json({ error: 'A target and at least one source are required.' }); return;
  }
  if (!mergePeople(target.data, sources.data)) {
    res.status(404).json({ error: 'No such person.' }); return;
  }
  res.json({ ok: true });
});

router.delete('/faces/people/:id', requireAuth, (req, res) => {
  if (!deletePerson(req.params['id'] as string)) {
    res.status(404).json({ error: 'No such person.' }); return;
  }
  res.json({ ok: true });
});

router.get('/faces/thumb/:faceId.jpg', requireAuth, (req, res) => {
  const faceId = req.params['faceId'] as string;
  // Ids are generated server-side; anything with a path separator in it is not one.
  if (!/^[a-f0-9]{8,32}$/.test(faceId)) { res.status(400).end(); return; }
  const file = faceThumbPath(faceId);
  if (!fs.existsSync(file)) { res.status(404).end(); return; }
  // Face crops never change once written, so let the browser keep them.
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=604800');
  fs.createReadStream(file).pipe(res);
});

export default router;
