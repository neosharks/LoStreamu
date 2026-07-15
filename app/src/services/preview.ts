import fs from 'fs';
import path from 'path';
import { APP_DIR } from '../config';
import { runMedia } from './exec';
import type { VideoItem } from '../types';

// ── Ephemeral scrub-preview frames ────────────────────────────────────────────
// When a video opens, the client asks for scrub previews and we generate a set
// of small thumbnails — one per time bucket — into a temp previews/<id>/ dir.
// On hover the client shows the frame for that timestamp.
//
// Speed: frames are extracted with INPUT SEEK (`-ss` before `-i`), which jumps
// to a keyframe near the target in ~O(1) regardless of file size. The old
// `fps=1/n` approach decoded the ENTIRE file (minutes on a 1 GB+ video); this
// decodes ~one frame per bucket and runs them in parallel (bounded by the media
// concurrency cap), so even a 47-min file finishes in seconds.
//
// Generation is async with progress so the client can show a loading indicator.
// Cleanup is guaranteed: the dir is deleted when the player closes, wiped on
// boot, and swept when idle — nothing accumulates on disk.

const PREVIEW_DIR = path.join(APP_DIR, 'previews');
const MAX_FRAMES = 60;   // cap frames regardless of length (bounds ffmpeg spawns)
const TILE_W = 160;      // px per frame; height derived from the video's aspect
const IDLE_MS = 15 * 60 * 1000;

export interface PreviewMeta {
  count: number;
  interval: number; // seconds per bucket
  tileW: number;
  tileH: number;
}

export type PreviewState =
  | { status: 'generating'; progress: number }
  | { status: 'ready'; meta: PreviewMeta }
  | { status: 'error' };

interface Job { status: 'generating' | 'ready' | 'error'; meta: PreviewMeta; done: number; }

const jobs = new Map<string, Job>();
const lastAccess = new Map<string, number>();

const dirFor = (id: string) => path.join(PREVIEW_DIR, id);
const frameFile = (id: string, i: number) => path.join(dirFor(id), `${String(i).padStart(4, '0')}.jpg`);
const metaFileFor = (id: string) => path.join(dirFor(id), 'meta.json');

export function previewFrameFile(id: string, i: number): string {
  return frameFile(id, i);
}
export function touchPreview(id: string): void {
  lastAccess.set(id, Date.now());
}

// Pure layout math: pick a bucket interval that keeps the frame count under the
// cap, and derive tile height from the video's aspect ratio.
export function computePreviewLayout(durationSec: number, width?: number, height?: number): PreviewMeta {
  const duration = Math.max(1, durationSec || 60);
  const interval = Math.max(2, Math.ceil(duration / MAX_FRAMES));
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(duration / interval)));
  const aspect = width && height ? height / width : 9 / 16;
  let tileH = Math.round(TILE_W * aspect);
  if (tileH % 2) tileH += 1; // even dimension required by the JPEG encoder
  return { count, interval, tileW: TILE_W, tileH };
}

async function runJob(v: VideoItem, job: Job): Promise<void> {
  const id = v.id;
  fs.mkdirSync(dirFor(id), { recursive: true });
  const { interval, count, tileW, tileH } = job.meta;
  const duration = v.duration || count * interval;

  await Promise.all(Array.from({ length: count }, (_, i) => (async () => {
    // Sample the middle of the bucket — avoids the black frame at t=0 and gives a
    // more representative thumbnail. Clamp inside the file.
    const t = Math.min(duration - 0.1, (i + 0.5) * interval);
    try {
      await runMedia('ffmpeg', [
        '-nostdin', '-threads', '1',
        '-ss', t.toFixed(2), '-i', v.absPath,
        '-frames:v', '1', '-an', '-vf', `scale=${tileW}:${tileH}`,
        '-q:v', '5', '-y', frameFile(id, i),
      ], { timeout: 30000 });
    } catch { /* leave a gap; the client falls back to a neighbouring frame */ }
    job.done++;
  })()));

  try { fs.writeFileSync(metaFileFor(id), JSON.stringify(job.meta)); } catch { /* ignore */ }
  job.status = 'ready';
}

// Return the current preview state, kicking off generation on first request.
export function requestPreview(v: VideoItem): PreviewState {
  const id = v.id;
  lastAccess.set(id, Date.now());

  const existing = jobs.get(id);
  if (existing?.status === 'ready') return { status: 'ready', meta: existing.meta };
  if (existing?.status === 'generating') {
    return { status: 'generating', progress: existing.meta.count ? existing.done / existing.meta.count : 0 };
  }
  // A finished job may still be on disk from earlier this session.
  try {
    if (fs.existsSync(metaFileFor(id))) {
      const meta = JSON.parse(fs.readFileSync(metaFileFor(id), 'utf8')) as PreviewMeta;
      jobs.set(id, { status: 'ready', meta, done: meta.count });
      return { status: 'ready', meta };
    }
  } catch { /* regenerate below */ }

  const meta = computePreviewLayout(v.duration || 60, v.width, v.height);
  const job: Job = { status: 'generating', meta, done: 0 };
  jobs.set(id, job);
  runJob(v, job).catch(() => { job.status = 'error'; });
  return { status: 'generating', progress: 0 };
}

export function deletePreview(id: string): void {
  lastAccess.delete(id);
  jobs.delete(id);
  try { fs.rmSync(dirFor(id), { recursive: true, force: true }); } catch { /* already gone */ }
}

// Wipe on boot (previews are session-scoped) and start the idle sweep.
export function initPreviews(): void {
  try { fs.rmSync(PREVIEW_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });

  const timer = setInterval(() => {
    let ids: string[];
    try { ids = fs.readdirSync(PREVIEW_DIR); } catch { return; }
    const now = Date.now();
    for (const id of ids) {
      if (now - (lastAccess.get(id) ?? 0) > IDLE_MS) deletePreview(id);
    }
  }, 5 * 60 * 1000);
  timer.unref?.();
}
