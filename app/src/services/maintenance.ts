import fs from 'fs';
import path from 'path';
import {
  getLibrary, getMediaRoot, rescan, buildMeta, pruneOrphanMeta, pruneEmptyDirs,
} from './library';
import { cleanThumbnails, generateThumb } from './media';

// ── Junk cleanup ─────────────────────────────────────────────────────────────
// "Junk" is anything on the server that isn't a real video and isn't needed:
//   • orphaned / legacy thumbnail files (video deleted, or old sprite/vtt)
//   • yt-dlp temp & partial-download leftovers from cancelled/failed downloads
//   • meta-cache entries for videos that no longer exist
//   • empty folders left behind after files are removed
// The yt-dlp download archive (.downloaded.txt) is intentional and preserved.

const JUNK_EXTS = new Set(['.part', '.ytdl', '.temp', '.tmp', '.download']);

export function isJunkFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (JUNK_EXTS.has(path.extname(lower))) return true;
  if (lower.includes('.part-frag')) return true; // yt-dlp DASH fragment leftovers
  return false;
}

export interface CleanupResult {
  removedFiles: number;
  freedBytes: number;
  thumbnails: { removedFiles: number; freedBytes: number };
  tempFiles: { removedFiles: number; freedBytes: number };
  metaEntries: number;
}

export function cleanJunk(): CleanupResult {
  // Rescan first so the live filesystem — not stale in-memory state — decides
  // what's an orphan.
  rescan();
  const validIds = new Set(getLibrary().map(v => v.id));

  // 1. Orphaned + legacy thumbnails.
  const thumbnails = cleanThumbnails(validIds);

  // 2. Temp / partial-download leftovers anywhere under the media root.
  const root = getMediaRoot();
  let tRemoved = 0;
  let tBytes = 0;
  const touchedDirs = new Set<string>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile() || !isJunkFile(e.name)) continue;
      try {
        tBytes += fs.statSync(abs).size;
        fs.rmSync(abs, { force: true });
        tRemoved++;
        touchedDirs.add(dir);
      } catch { /* already gone */ }
    }
  };
  walk(root);

  // 3. Stale meta-cache entries.
  const metaEntries = pruneOrphanMeta(validIds);

  // 4. Empty folders left behind by removed junk.
  for (const d of touchedDirs) pruneEmptyDirs(d);

  return {
    removedFiles: thumbnails.removedFiles + tRemoved,
    freedBytes: thumbnails.freedBytes + tBytes,
    thumbnails,
    tempFiles: { removedFiles: tRemoved, freedBytes: tBytes },
    metaEntries,
  };
}

// ── Thumbnail regeneration ─────────────────────────────────────────────────────
// Re-trigger generation for every video that lacks a valid thumbnail (missing or
// zero-byte from a prior failed ffmpeg run). Pass force=true to rebuild all.
// ffmpeg fan-out is bounded by runMedia's concurrency cap, so firing them all at
// once uses every core without oversubscribing.

export interface RegenResult {
  total: number;
  generated: number;
  skipped: number;
  failed: number;
}

export async function regenerateThumbnails(force = false): Promise<RegenResult> {
  rescan();
  await buildMeta(); // ensure durations exist so the midpoint seek is correct
  const lib = getLibrary();

  const outcomes = await Promise.all(
    lib.map(v => generateThumb(v.id, v.absPath, v.duration || 60, force)),
  );

  const result: RegenResult = { total: lib.length, generated: 0, skipped: 0, failed: 0 };
  for (const o of outcomes) result[o]++;
  return result;
}
