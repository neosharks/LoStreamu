import fs from 'fs';
import { FAVORITES_PATH } from '../config';

// ── Favourites ────────────────────────────────────────────────────────────────
// A star per profile: every PIN profile keeps its own list, the same way the
// profile picker implies. One JSON file in DATA_DIR, so stars survive an app
// reinstall along with the library.
//
// Entries are stored as RELATIVE PATHS, not video ids. An id is a hash of the
// path, so renaming or moving a video mints a new id and would silently drop the
// star; paths are also what a human can read if they ever open the file. Rename,
// move, repair and delete all call through here to keep the list in step.

interface FavoritesFile {
  version: 1;
  /** userId → relative paths, most recently starred last. */
  byUser: Record<string, string[]>;
}

let _file: FavoritesFile | null = null;

function load(): FavoritesFile {
  if (_file) return _file;
  let data: FavoritesFile = { version: 1, byUser: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(FAVORITES_PATH, 'utf8'));
    if (raw && typeof raw === 'object' && raw.byUser) {
      data = { version: 1, byUser: {} };
      for (const [userId, paths] of Object.entries(raw.byUser as Record<string, unknown>)) {
        if (Array.isArray(paths)) data.byUser[userId] = paths.filter(p => typeof p === 'string');
      }
    }
  } catch { /* first run, or an unreadable file — start clean */ }
  _file = data;
  return data;
}

function save(): void {
  try { fs.writeFileSync(FAVORITES_PATH, JSON.stringify(load())); } catch { /* best-effort */ }
}

/** Every relative path this profile has starred. */
export function listFavorites(userId: string): string[] {
  return load().byUser[userId] ?? [];
}

export function isFavorite(userId: string, relPath: string): boolean {
  return listFavorites(userId).includes(relPath);
}

/** Returns the resulting state, so the caller can report it without a re-read. */
export function setFavorite(userId: string, relPath: string, on: boolean): boolean {
  const data = load();
  const current = data.byUser[userId] ?? [];
  const has = current.includes(relPath);
  if (on === has) return on;
  data.byUser[userId] = on ? [...current, relPath] : current.filter(p => p !== relPath);
  save();
  return on;
}

/** Follow a video that was renamed, moved or repaired into a new extension. */
export function rekeyFavorite(oldRelPath: string, newRelPath: string): void {
  if (oldRelPath === newRelPath) return;
  const data = load();
  let changed = false;
  for (const [userId, paths] of Object.entries(data.byUser)) {
    if (!paths.includes(oldRelPath)) continue;
    // Guard against the target already being starred (a move onto a path this
    // profile had starred before), which would leave a duplicate entry.
    data.byUser[userId] = [...paths.filter(p => p !== oldRelPath && p !== newRelPath), newRelPath];
    changed = true;
  }
  if (changed) save();
}

/** Drop a deleted video from every profile's list. */
export function forgetFavorite(relPath: string): void {
  const data = load();
  let changed = false;
  for (const [userId, paths] of Object.entries(data.byUser)) {
    if (!paths.includes(relPath)) continue;
    data.byUser[userId] = paths.filter(p => p !== relPath);
    changed = true;
  }
  if (changed) save();
}

/** Drop stars whose video is no longer on disk. Returns how many went. */
export function pruneFavorites(validPaths: Set<string>): number {
  const data = load();
  let removed = 0;
  for (const [userId, paths] of Object.entries(data.byUser)) {
    const kept = paths.filter(p => validPaths.has(p));
    removed += paths.length - kept.length;
    data.byUser[userId] = kept;
  }
  if (removed) save();
  return removed;
}

/** Tests only — drops the cached file so the next read hits disk again. */
export function resetFavoritesCache(): void {
  _file = null;
}
