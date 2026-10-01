import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FACES_PATH, FACE_THUMB_DIR } from '../../config';
import { cosine, mergeCentroid } from './geometry';
import { modelSize, type ModelSize } from './models';
import type { Person } from '../../types';

// ── The people index ──────────────────────────────────────────────────────────
// One JSON file holding who the scanner has found and which videos they appear
// in. Videos are keyed by RELATIVE PATH for the same reason favourites are: an id
// is a hash of the path, so a rename would otherwise orphan the whole scan.
//
// Only one embedding per person is kept — a running centroid of the faces
// assigned to them. Keeping every face vector would grow the file without
// bounds and buy nothing: matching a new face against the centroid is what
// decides the grouping either way.
//
// Clustering is deliberately cautious. Setting the bar high splits one person
// into two entries now and then, which the Merge button fixes in a click;
// setting it low fuses two people into one, which nothing in the UI can undo.

/** Cosine similarity needed to call two faces the same person, across videos. */
const MATCH_THRESHOLD = Number(process.env.SV_FACE_THRESHOLD) || 0.45;
/** Same video, same lighting — the bar for folding repeat appearances together. */
export const TRACK_THRESHOLD = 0.55;

interface StoredPerson {
  id: string;
  name: string;
  cover: string;
  centroid: number[];
  samples: number;
}

export interface VideoPersonRef {
  personId: string;
  /** Thumbnail of this person as they appear in THIS video. */
  faceId: string;
  score: number;
  /** Seconds into the video where that thumbnail came from. */
  at: number;
}

interface StoredVideo {
  indexedAt: number;
  size: number;
  mtimeMs: number;
  people: VideoPersonRef[];
}

interface FacesFile {
  version: 1;
  model: ModelSize;
  people: StoredPerson[];
  videos: Record<string, StoredVideo>;
}

let _file: FacesFile | null = null;

function empty(): FacesFile {
  return { version: 1, model: modelSize(), people: [], videos: {} };
}

function load(): FacesFile {
  if (_file) return _file;
  try {
    const raw = JSON.parse(fs.readFileSync(FACES_PATH, 'utf8')) as FacesFile;
    if (raw && Array.isArray(raw.people) && raw.videos) {
      // Embeddings from one model mean nothing to another, so a model switch
      // starts over rather than clustering two incompatible vector spaces.
      _file = raw.model === modelSize() ? raw : empty();
      return _file;
    }
  } catch { /* first run, or an unreadable file */ }
  _file = empty();
  return _file;
}

function save(): void {
  try { fs.writeFileSync(FACES_PATH, JSON.stringify(load())); } catch { /* best-effort */ }
}

export function faceThumbPath(faceId: string): string {
  return path.join(FACE_THUMB_DIR, `${faceId}.jpg`);
}

export function newFaceId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** Centroids are stored short — 5 decimals is well past what matching needs. */
function round(v: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) out.push(Math.round(v[i]! * 1e5) / 1e5);
  return out;
}

// ── Matching ──────────────────────────────────────────────────────────────────

export interface Match { personId: string; isNew: boolean; similarity: number; }

/**
 * Find the person this face belongs to, creating one when nobody is close
 * enough, and fold the face into their centroid.
 */
export function assignPerson(embedding: Float32Array, faceId: string): Match {
  const data = load();
  let best: StoredPerson | null = null;
  let bestSimilarity = -1;
  for (const person of data.people) {
    const similarity = cosine(embedding, person.centroid);
    if (similarity > bestSimilarity) { bestSimilarity = similarity; best = person; }
  }

  if (best && bestSimilarity >= MATCH_THRESHOLD) {
    best.centroid = round(mergeCentroid(best.centroid, best.samples, embedding));
    best.samples++;
    return { personId: best.id, isNew: false, similarity: bestSimilarity };
  }

  const person: StoredPerson = {
    id: crypto.randomBytes(6).toString('hex'),
    name: '',
    cover: faceId,
    centroid: round(embedding),
    samples: 1,
  };
  data.people.push(person);
  return { personId: person.id, isNew: true, similarity: bestSimilarity };
}

/** Replace what is known about one video and flush the file. */
export function recordVideo(
  relPath: string, stat: { size: number; mtimeMs: number }, people: VideoPersonRef[],
): void {
  const data = load();
  discardThumbs(data.videos[relPath]);
  data.videos[relPath] = {
    indexedAt: Date.now(),
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
    people,
  };
  save();
}

/** True when this exact file has already been scanned. */
export function isIndexed(relPath: string, stat: { size: number; mtimeMs: number }): boolean {
  const entry = load().videos[relPath];
  // A repaired or re-downloaded file keeps its path but changes size, so compare
  // the file itself rather than trusting the name.
  return !!entry && entry.size === stat.size && entry.mtimeMs === Math.floor(stat.mtimeMs);
}

// ── Reading ───────────────────────────────────────────────────────────────────

export function listPeople(): Person[] {
  const data = load();
  const videoCounts = new Map<string, number>();
  const faceCounts = new Map<string, number>();
  for (const entry of Object.values(data.videos)) {
    for (const ref of entry.people) {
      videoCounts.set(ref.personId, (videoCounts.get(ref.personId) ?? 0) + 1);
      faceCounts.set(ref.personId, (faceCounts.get(ref.personId) ?? 0) + 1);
    }
  }
  return data.people
    .map(p => ({
      id: p.id,
      name: p.name,
      cover: p.cover,
      videoCount: videoCounts.get(p.id) ?? 0,
      faceCount: faceCounts.get(p.id) ?? 0,
    }))
    // Nobody wants to scroll past people who turned up in a single frame of one
    // video; most appearances first is also roughly "most important" first.
    .filter(p => p.videoCount > 0)
    .sort((a, b) => b.videoCount - a.videoCount);
}

/** Relative paths of every video this person appears in. */
export function videosForPerson(personId: string): string[] {
  const data = load();
  return Object.entries(data.videos)
    .filter(([, entry]) => entry.people.some(r => r.personId === personId))
    .map(([relPath]) => relPath);
}

/** Everyone the scanner found in one video, best appearance first. */
export function peopleInVideo(relPath: string): VideoPersonRef[] {
  return (load().videos[relPath]?.people ?? []).slice().sort((a, b) => b.score - a.score);
}

export function indexedCount(): number {
  return Object.keys(load().videos).length;
}

// ── Editing ───────────────────────────────────────────────────────────────────

export function renamePerson(personId: string, name: string): boolean {
  const person = load().people.find(p => p.id === personId);
  if (!person) return false;
  person.name = name.slice(0, 60);
  save();
  return true;
}

/** Fold `sourceIds` into `targetId`. Used when one person was split in two. */
export function mergePeople(targetId: string, sourceIds: string[]): boolean {
  const data = load();
  const target = data.people.find(p => p.id === targetId);
  const sources = data.people.filter(p => p.id !== targetId && sourceIds.includes(p.id));
  if (!target || !sources.length) return false;

  for (const source of sources) {
    // Weight by how many faces each side was built from, so merging a one-frame
    // stray does not drag an established centroid across the vector space.
    let centroid: Float32Array | number[] = target.centroid;
    for (let i = 0; i < source.samples; i++) {
      centroid = mergeCentroid(centroid, target.samples + i, source.centroid);
    }
    target.centroid = round(centroid);
    target.samples += source.samples;
  }

  const gone = new Set(sources.map(p => p.id));
  data.people = data.people.filter(p => !gone.has(p.id));
  for (const entry of Object.values(data.videos)) {
    const kept: VideoPersonRef[] = [];
    for (const ref of entry.people) {
      if (!gone.has(ref.personId)) { kept.push(ref); continue; }
      // One reference per person per video: keep whichever face scored best.
      const existing = kept.find(r => r.personId === targetId);
      if (!existing) { kept.push({ ...ref, personId: targetId }); continue; }
      if (ref.score > existing.score) {
        discardThumb(existing.faceId);
        existing.faceId = ref.faceId;
        existing.score = ref.score;
        existing.at = ref.at;
      } else {
        discardThumb(ref.faceId);
      }
    }
    entry.people = kept;
  }
  save();
  return true;
}

export function deletePerson(personId: string): boolean {
  const data = load();
  const before = data.people.length;
  data.people = data.people.filter(p => p.id !== personId);
  if (data.people.length === before) return false;
  for (const entry of Object.values(data.videos)) {
    for (const ref of entry.people) {
      if (ref.personId === personId) discardThumb(ref.faceId);
    }
    entry.people = entry.people.filter(r => r.personId !== personId);
  }
  save();
  return true;
}

// ── Keeping up with the library ───────────────────────────────────────────────

export function rekeyFaces(oldRelPath: string, newRelPath: string): void {
  if (oldRelPath === newRelPath) return;
  const data = load();
  const entry = data.videos[oldRelPath];
  if (!entry) return;
  discardThumbs(data.videos[newRelPath]);
  delete data.videos[oldRelPath];
  data.videos[newRelPath] = entry;
  save();
}

export function forgetFaces(relPath: string): void {
  const data = load();
  if (!data.videos[relPath]) return;
  discardThumbs(data.videos[relPath]);
  delete data.videos[relPath];
  save();
}

/** Drop videos that are no longer on disk. Returns how many entries went. */
export function pruneFaces(validPaths: Set<string>): number {
  const data = load();
  let removed = 0;
  for (const relPath of Object.keys(data.videos)) {
    if (validPaths.has(relPath)) continue;
    discardThumbs(data.videos[relPath]);
    delete data.videos[relPath];
    removed++;
  }
  // A person whose every appearance has gone is no longer a person.
  const live = new Set<string>();
  for (const entry of Object.values(data.videos)) for (const ref of entry.people) live.add(ref.personId);
  data.people = data.people.filter(p => live.has(p.id));
  sweepFaceThumbs();
  if (removed) save();
  return removed;
}

/**
 * Delete face crops nothing refers to any more. Re-scanning a video replaces its
 * references, and a person can lose their last appearance, so the only reliable
 * rule is "keep what is referenced, drop the rest".
 */
export function sweepFaceThumbs(): number {
  const data = load();
  const keep = new Set<string>(data.people.map(p => p.cover));
  for (const entry of Object.values(data.videos)) for (const ref of entry.people) keep.add(ref.faceId);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(FACE_THUMB_DIR, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jpg')) continue;
    if (keep.has(e.name.slice(0, -4))) continue;
    try { fs.rmSync(path.join(FACE_THUMB_DIR, e.name), { force: true }); removed++; }
    catch { /* already gone */ }
  }
  return removed;
}

/** Wipe the whole index — the "scan again from scratch" button. */
export function resetFaces(): void {
  _file = empty();
  try { fs.rmSync(FACE_THUMB_DIR, { recursive: true, force: true }); } catch { /* already gone */ }
  fs.mkdirSync(FACE_THUMB_DIR, { recursive: true });
  save();
}

function discardThumb(faceId: string): void {
  try { fs.rmSync(faceThumbPath(faceId), { force: true }); } catch { /* already gone */ }
}

function discardThumbs(entry: StoredVideo | undefined): void {
  if (!entry) return;
  const covers = new Set(load().people.map(p => p.cover));
  // A face that represents a person on the People page has to outlive the video
  // entry that produced it, or the page loses its picture.
  for (const ref of entry.people) if (!covers.has(ref.faceId)) discardThumb(ref.faceId);
}
