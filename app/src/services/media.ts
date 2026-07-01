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
  if (!fs.existsSync(out)) {
    ensureThumbDir();
    // One frame from the middle of the video — most representative, and a single
    // fast keyframe seek is cheap even for long files.
    const seek = Math.max(1, durationSec * 0.5).toFixed(2);
    await runMedia('ffmpeg', [
      '-nostdin', '-threads', '1',
      '-ss', seek, '-i', absPath,
      '-frames:v', '1', '-an', '-vf', 'scale=480:-2',
      '-q:v', '5', '-y', out,
    ], { timeout: 20000 });
  }

  const buf = fs.readFileSync(out);
  thumbCache.set(id, buf);
  if (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value as string | undefined;
    if (oldest !== undefined) thumbCache.delete(oldest);
  }
  return buf;
}
