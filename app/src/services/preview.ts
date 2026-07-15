import fs from 'fs';
import path from 'path';
import { APP_DIR } from '../config';
import { runMedia } from './exec';
import type { VideoItem } from '../types';

// ── Ephemeral scrub-preview sprites ───────────────────────────────────────────
// When a video is opened in the player, the client asks for a sprite sheet: a
// grid of small thumbnails sampled at a fixed interval. On hover over the seek
// bar the client shows the tile for that timestamp. Sprites are generated on the
// fly (one ffmpeg pass) into a temp dir, and are DELETED when the player closes.
// Nothing survives: the dir is wiped on boot and an idle sweep reaps orphans left
// by a crashed/closed browser, so previews never pile up on disk.

const PREVIEW_DIR = path.join(APP_DIR, 'previews');
const MAX_TILES = 100;   // cap sprite size regardless of video length
const TILE_W = 160;      // px per tile; height derived from the video's aspect
const COLS = 10;
const IDLE_MS = 15 * 60 * 1000; // reap sprites untouched for 15 min

export interface PreviewMeta {
  cols: number;
  rows: number;
  count: number;
  interval: number; // seconds between sampled frames
  tileW: number;
  tileH: number;
}

// De-dupe concurrent generation for the same video; track access for the sweep.
const inFlight = new Map<string, Promise<PreviewMeta>>();
const lastAccess = new Map<string, number>();

const spriteFile = (id: string) => path.join(PREVIEW_DIR, `${id}.jpg`);
const metaFile = (id: string) => path.join(PREVIEW_DIR, `${id}.json`);

export function previewSpriteFile(id: string): string {
  return spriteFile(id);
}

export function touchPreview(id: string): void {
  lastAccess.set(id, Date.now());
}

// Pure layout math: pick a sampling interval that keeps the grid under MAX_TILES,
// then derive the grid shape and tile height from the video's aspect ratio.
export function computePreviewLayout(durationSec: number, width?: number, height?: number): PreviewMeta {
  const duration = Math.max(1, durationSec || 60);
  const interval = Math.max(2, Math.ceil(duration / MAX_TILES));
  const count = Math.max(1, Math.ceil(duration / interval));
  const cols = Math.min(COLS, count);
  const rows = Math.ceil(count / cols);
  const aspect = width && height ? height / width : 9 / 16;
  let tileH = Math.round(TILE_W * aspect);
  if (tileH % 2) tileH += 1; // even dimension required by yuv420p
  return { cols, rows, count, interval, tileW: TILE_W, tileH };
}

function computeParams(v: VideoItem): PreviewMeta {
  return computePreviewLayout(v.duration || 60, v.width, v.height);
}

// Generate (or reuse) the sprite for a video and return its layout metadata.
export async function ensurePreview(v: VideoItem): Promise<PreviewMeta> {
  const id = v.id;
  lastAccess.set(id, Date.now());

  // Already on disk from earlier in this session?
  try {
    if (fs.statSync(spriteFile(id)).size > 0) {
      return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')) as PreviewMeta;
    }
  } catch { /* not generated yet */ }

  const existing = inFlight.get(id);
  if (existing) return existing;

  const job = (async () => {
    const meta = computeParams(v);
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    // One pass: sample a frame every `interval`s, scale to a tile, pack into a grid.
    const vf = `fps=1/${meta.interval},scale=${meta.tileW}:${meta.tileH},tile=${meta.cols}x${meta.rows}`;
    await runMedia('ffmpeg', [
      '-nostdin', '-threads', '1',
      '-i', v.absPath,
      '-vf', vf,
      '-frames:v', '1', '-q:v', '5', '-y', spriteFile(id),
    ], { timeout: 120000 });
    fs.writeFileSync(metaFile(id), JSON.stringify(meta));
    return meta;
  })();

  inFlight.set(id, job);
  try {
    return await job;
  } finally {
    inFlight.delete(id);
  }
}

export function deletePreview(id: string): void {
  lastAccess.delete(id);
  for (const p of [spriteFile(id), metaFile(id)]) {
    try { fs.rmSync(p, { force: true }); } catch { /* already gone */ }
  }
}

// Wipe the dir on boot (previews are session-scoped) and start the idle sweep.
export function initPreviews(): void {
  try { fs.rmSync(PREVIEW_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });

  const timer = setInterval(() => {
    let entries: string[];
    try { entries = fs.readdirSync(PREVIEW_DIR); } catch { return; }
    const ids = new Set(entries.map(f => f.replace(/\.(jpg|json)$/, '')));
    const now = Date.now();
    for (const id of ids) {
      if (now - (lastAccess.get(id) ?? 0) > IDLE_MS) deletePreview(id);
    }
  }, 5 * 60 * 1000);
  timer.unref?.();
}
