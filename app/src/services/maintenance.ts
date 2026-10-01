import fs from 'fs';
import path from 'path';
import {
  getLibrary, getMediaRoot, rescan, buildMeta, pruneOrphanMeta,
} from './library';
import { cleanThumbnails, generateThumb } from './media';
import { pruneFavorites } from './favorites';
import { pruneFaces } from './faces/store';

// ── Junk cleanup ─────────────────────────────────────────────────────────────
// "Junk" is anything on the server that isn't a real video and isn't needed:
//   • orphaned / legacy thumbnail files (video deleted, or old sprite/vtt)
//   • yt-dlp temp & partial-download leftovers from cancelled/failed downloads
//   • meta-cache entries for videos that no longer exist
//   • empty folders — moves and deletes deliberately leave them behind so that
//     organising never makes a folder vanish under you; this is where they go
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
  emptyFolders: number;
  /** Stars and face-index entries pointing at videos that no longer exist. */
  staleFavorites: number;
  staleFaceEntries: number;
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
      } catch { /* already gone */ }
    }
  };
  walk(root);

  // 3. Stale meta-cache entries, stars and face-index entries.
  const metaEntries = pruneOrphanMeta(validIds);
  const validPaths = new Set(getLibrary().map(v => v.relPath));
  const staleFavorites = pruneFavorites(validPaths);
  const staleFaceEntries = pruneFaces(validPaths);

  // 4. Every empty folder under the media root, deepest first.
  const emptyFolders = sweepEmptyDirs(root);

  return {
    removedFiles: thumbnails.removedFiles + tRemoved,
    freedBytes: thumbnails.freedBytes + tBytes,
    thumbnails,
    tempFiles: { removedFiles: tRemoved, freedBytes: tBytes },
    metaEntries,
    emptyFolders,
    staleFavorites,
    staleFaceEntries,
  };
}

// Depth-first so a folder whose only content was empty folders goes too. The
// media root itself is always kept.
function sweepEmptyDirs(root: string): number {
  let removed = 0;
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) visit(path.join(dir, e.name));
    if (dir === root) return;
    try {
      if (fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); removed++; }
    } catch {}
  };
  visit(root);
  return removed;
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
