import fs from 'fs';
import path from 'path';
import { APP_DIR } from '../config';
import { runMedia } from './exec';

const THUMB_DIR = path.join(APP_DIR, 'thumbnails');

export function thumbPath(id: string): string {
  return path.join(THUMB_DIR, `${id}.jpg`);
}

// Legacy sprite/vtt paths kept only so old cached files get cleaned up on
// delete. Sprite scrub-previews were removed in favour of a single thumbnail.
export function spritePath(id: string): string {
  return path.join(THUMB_DIR, `${id}.sprite.jpg`);
}
export function vttPath(id: string): string {
  return path.join(THUMB_DIR, `${id}.vtt`);
}

function ensureThumbDir(): void {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
}

// ── In-memory thumbnail cache ──────────────────────────────────────────────
// Thumbnails are tiny (~10KB) and read on every grid render/scroll. Keeping the
// hot set in RAM avoids disk I/O and lets the HTTP layer answer instantly.
// Simple LRU: Map preserves insertion order, so re-inserting on hit = recency.
const thumbCache = new Map<string, Buffer>();
const THUMB_CACHE_MAX = Math.max(50, Number(process.env.SV_THUMB_CACHE_MAX) || 2000);

export function invalidateThumb(id: string): void {
  thumbCache.delete(id);
}

// Render a single mid-video frame to `out` via ffmpeg. One fast keyframe seek to
// the midpoint — cheap even for long files, and the most representative frame.
async function renderThumb(absPath: string, durationSec: number, out: string): Promise<void> {
  ensureThumbDir();
  const seek = Math.max(1, durationSec * 0.5).toFixed(2);
  await runMedia('ffmpeg', [
    '-nostdin', '-threads', '1',
    '-ss', seek, '-i', absPath,
    '-frames:v', '1', '-an', '-vf', 'scale=480:-2',
    '-q:v', '5', '-y', out,
  ], { timeout: 20000 });
}

// True when a non-empty thumbnail file already exists on disk. A zero-byte file
// means a previous ffmpeg run failed partway, so it counts as missing.
export function thumbIsValid(id: string): boolean {
  try { return fs.statSync(thumbPath(id)).size > 0; } catch { return false; }
}

// Returns the JPEG bytes for a video's thumbnail, generating a single mid-video
// frame on first request, then serving from RAM on subsequent requests.
export async function getThumbBuffer(id: string, absPath: string, durationSec: number): Promise<Buffer> {
  const hit = thumbCache.get(id);
  if (hit) {
    thumbCache.delete(id);
    thumbCache.set(id, hit); // mark most-recently-used
    return hit;
  }

  const out = thumbPath(id);
  if (!fs.existsSync(out)) await renderThumb(absPath, durationSec, out);

  const buf = fs.readFileSync(out);
  thumbCache.set(id, buf);
  if (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value as string | undefined;
    if (oldest !== undefined) thumbCache.delete(oldest);
  }
  return buf;
}

// (Re)generate the on-disk thumbnail for one video without touching the RAM
// read-cache. Skips videos that already have a valid thumbnail unless `force`.
// Returns the outcome so a batch caller can tally generated/skipped/failed.
export async function generateThumb(
  id: string, absPath: string, durationSec: number, force = false,
): Promise<'generated' | 'skipped' | 'failed'> {
  if (!force && thumbIsValid(id)) return 'skipped';
  try {
    await renderThumb(absPath, durationSec, thumbPath(id));
    if (!thumbIsValid(id)) return 'failed';
    invalidateThumb(id); // drop any stale cached bytes so the next serve re-reads
    return 'generated';
  } catch {
    return 'failed';
  }
}

// Delete thumbnail-dir files that are no longer needed: orphans (the video was
// removed) and legacy sprite/vtt scrub-preview files (that feature is gone).
// A current video's own "<id>.jpg" is always kept. Returns freed counts.
export function cleanThumbnails(validIds: Set<string>): { removedFiles: number; freedBytes: number } {
  let removedFiles = 0;
  let freedBytes = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(THUMB_DIR, { withFileTypes: true }); }
  catch { return { removedFiles, freedBytes }; }

  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;   // skip .gitkeep, .DS_Store, etc.
    const id = e.name.split('.')[0] as string;            // "<id>.jpg" / "<id>.sprite.jpg" / "<id>.vtt"
    const isLegacy = e.name.endsWith('.sprite.jpg') || e.name.endsWith('.vtt');
    if (!isLegacy && validIds.has(id)) continue;           // live thumbnail — keep

    const abs = path.join(THUMB_DIR, e.name);
    try {
      freedBytes += fs.statSync(abs).size;
      fs.rmSync(abs, { force: true });
      removedFiles++;
      invalidateThumb(id);
    } catch { /* already gone */ }
  }
  return { removedFiles, freedBytes };
}
