import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FACES_PATH, FACE_THUMB_DIR } from '../../config';
import { packEmbedding, unpackEmbedding } from './geometry';
import { clusterFaces, DEFAULT_CLUSTER_OPTIONS, type ClusterOptions, type FaceVector } from './cluster';
import { recognitionSize, type ModelSize } from './models';
import type { Person } from '../../types';

// ── The people index ──────────────────────────────────────────────────────────
// One JSON file holding every face the scanner has found, which video it came
// from, and which person it currently belongs to. Videos are keyed by RELATIVE
// PATH for the same reason favourites are: an id is a hash of the path, so a
// rename would otherwise orphan the whole scan.
//
// EVERY face embedding is kept here (packed to one byte per dimension). The
// first version stored only a per-person average, which is why the same person
// came out as several entries and why nothing could be put right afterwards:
// with the vectors thrown away, the only repair was a full re-scan. Keeping them
// means grouping is a pure function of stored data, so changing a setting — or
// correcting a mistake — re-groups the whole library in seconds.

interface StoredFace {
  id: string;
  /** Null until grouping runs, or when a face is too isolated to be a person. */
  personId: string | null;
  score: number;
  /** Seconds into the video. */
  at: number;
  /** Packed 512-d unit vector. */
  emb: string;
  /**
   * True when a crop was saved for this face. Only the clearest frame of each
   * track gets one; the rest are embeddings alone. Anything shown to a viewer —
   * a person's tile, a face in the player — must come from one of these.
   */
  thumb?: boolean;
  /** Set when a person was deleted by hand — grouping skips these for good. */
  ignored?: boolean;
}

interface StoredVideo {
  indexedAt: number;
  size: number;
  mtimeMs: number;
  faces: StoredFace[];
}

interface StoredPerson {
  id: string;
  name: string;
  cover: string;
}

interface FacesFile {
  version: 2;
  model: ModelSize;
  people: StoredPerson[];
  videos: Record<string, StoredVideo>;
  /** Face pairs a human put together; grouping must always honour them. */
  links: Array<[string, string]>;
  settings: ClusterOptions;
}

let _file: FacesFile | null = null;

function empty(): FacesFile {
  return {
    version: 2,
    model: recognitionSize(),
    people: [],
    videos: {},
    links: [],
    settings: { ...DEFAULT_CLUSTER_OPTIONS },
  };
}

function load(): FacesFile {
  if (_file) return _file;
  try {
    const raw = JSON.parse(fs.readFileSync(FACES_PATH, 'utf8')) as Partial<FacesFile>;
    // Version 1 kept no embeddings, and embeddings from one model mean nothing
    // to another. Either way there is nothing to carry over: start clean and let
    // the UI say a re-scan is needed.
    if (raw?.version === 2 && raw.model === recognitionSize() && raw.videos && Array.isArray(raw.people)) {
      _file = {
        version: 2,
        model: raw.model,
        people: raw.people,
        videos: raw.videos,
        links: Array.isArray(raw.links) ? raw.links : [],
        settings: { ...DEFAULT_CLUSTER_OPTIONS, ...(raw.settings ?? {}) },
      };
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

export function getClusterSettings(): ClusterOptions {
  return { ...load().settings };
}

export function setClusterSettings(options: Partial<ClusterOptions>): ClusterOptions {
  const data = load();
  data.settings = {
    threshold: Math.max(0, Math.min(0.95, options.threshold ?? data.settings.threshold)),
    minFaces: Math.max(1, Math.min(10, Math.floor(options.minFaces ?? data.settings.minFaces))),
  };
  save();
  return { ...data.settings };
}

// ── Writing a scan ────────────────────────────────────────────────────────────

export interface NewFace {
  id: string;
  score: number;
  at: number;
  embedding: Float32Array;
  /** Whether a crop was written for this face. */
  thumb?: boolean;
}

/** Replace everything known about one video. Grouping is a separate pass. */
export function recordVideo(
  relPath: string, stat: { size: number; mtimeMs: number }, faces: NewFace[],
): void {
  const data = load();
  discardThumbs(data.videos[relPath]);
  data.videos[relPath] = {
    indexedAt: Date.now(),
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
    faces: faces.map(f => ({
      id: f.id,
      personId: null,
      score: f.score,
      at: f.at,
      emb: packEmbedding(f.embedding),
      ...(f.thumb && { thumb: true }),
    })),
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

// ── Grouping ──────────────────────────────────────────────────────────────────

function everyFace(): Array<{ face: StoredFace; relPath: string }> {
  const out: Array<{ face: StoredFace; relPath: string }> = [];
  for (const [relPath, entry] of Object.entries(load().videos)) {
    for (const face of entry.faces) out.push({ face, relPath });
  }
  return out;
}

export interface RegroupResult {
  people: number;
  grouped: number;
  ungrouped: number;
  faces: number;
}

/**
 * Re-derive every person from the stored embeddings.
 *
 * Names survive: each new group keeps the id of whichever existing person most
 * of its faces already belonged to, so renaming someone and then re-grouping
 * does not lose the name. A group that matches no previous person is new.
 */
export function regroupPeople(
  options?: Partial<ClusterOptions>,
  onProgress?: (done: number, total: number) => void,
): RegroupResult {
  const data = load();
  if (options) setClusterSettings(options);

  const live = everyFace().filter(f => !f.face.ignored);
  const vectors: FaceVector[] = live.map(({ face }) => ({
    id: face.id,
    embedding: unpackEmbedding(face.emb),
  }));
  const { groups } = clusterFaces(vectors, data.settings, data.links, onProgress);

  // Which existing person does each new group inherit? Majority of the previous
  // assignments, so an established person keeps their id, name and cover.
  const byGroup = new Map<number, StoredFace[]>();
  for (const { face } of live) {
    const g = groups.get(face.id);
    if (g === undefined) continue;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(face);
  }

  const previous = new Map(data.people.map(p => [p.id, p]));
  const claimed = new Set<string>();
  const people: StoredPerson[] = [];

  // Biggest groups choose their inherited identity first, so the main cluster of
  // a person keeps the name rather than a stray offshoot taking it.
  const ordered = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [, faces] of ordered) {
    const tally = new Map<string, number>();
    for (const face of faces) {
      if (!face.personId || claimed.has(face.personId)) continue;
      tally.set(face.personId, (tally.get(face.personId) ?? 0) + 1);
    }
    let inherited: string | undefined;
    let best = 0;
    for (const [id, n] of tally) if (n > best) { best = n; inherited = id; }

    const existing = inherited ? previous.get(inherited) : undefined;
    const id = existing?.id ?? crypto.randomBytes(6).toString('hex');
    if (existing) claimed.add(existing.id);

    // Only a face with a saved crop can represent anyone — the rest are
    // embeddings with no picture behind them.
    const shown = faces.filter(f => f.thumb);
    const cover = shown.length ? shown.reduce((a, b) => (b.score > a.score ? b : a)) : undefined;
    if (!cover) continue; // nothing to show for this group; its faces stay unassigned
    // Keep the old picture when it is still one of this person's faces, so a
    // familiar tile does not change every time the library is re-grouped.
    const keepCover = existing && shown.some(f => f.id === existing.cover);
    people.push({
      id,
      name: existing?.name ?? '',
      cover: keepCover ? existing!.cover : cover.id,
    });
    for (const face of faces) face.personId = id;
  }

  for (const { face } of live) if (groups.get(face.id) === undefined) face.personId = null;

  data.people = people;
  sweepFaceThumbs();
  save();

  const grouped = live.filter(f => f.face.personId).length;
  return {
    people: people.length,
    grouped,
    ungrouped: live.length - grouped,
    faces: live.length,
  };
}

// ── Reading ───────────────────────────────────────────────────────────────────

export function listPeople(): Person[] {
  const data = load();
  const videos = new Map<string, Set<string>>();
  const faces = new Map<string, number>();
  for (const [relPath, entry] of Object.entries(data.videos)) {
    for (const face of entry.faces) {
      if (!face.personId) continue;
      if (!videos.has(face.personId)) videos.set(face.personId, new Set());
      videos.get(face.personId)!.add(relPath);
      faces.set(face.personId, (faces.get(face.personId) ?? 0) + 1);
    }
  }
  return data.people
    .map(p => ({
      id: p.id,
      name: p.name,
      cover: p.cover,
      videoCount: videos.get(p.id)?.size ?? 0,
      faceCount: faces.get(p.id) ?? 0,
    }))
    .filter(p => p.videoCount > 0)
    .sort((a, b) => b.videoCount - a.videoCount || b.faceCount - a.faceCount);
}

/** Relative paths of every video this person appears in. */
export function videosForPerson(personId: string): string[] {
  return Object.entries(load().videos)
    .filter(([, entry]) => entry.faces.some(f => f.personId === personId))
    .map(([relPath]) => relPath);
}

export interface VideoPersonRef {
  personId: string;
  faceId: string;
  score: number;
  at: number;
}

/** One entry per person in a video — their clearest appearance in it. */
export function peopleInVideo(relPath: string): VideoPersonRef[] {
  const entry = load().videos[relPath];
  if (!entry) return [];
  const best = new Map<string, VideoPersonRef>();
  for (const face of entry.faces) {
    if (!face.personId || !face.thumb) continue;
    const current = best.get(face.personId);
    if (current && current.score >= face.score) continue;
    best.set(face.personId, { personId: face.personId, faceId: face.id, score: face.score, at: face.at });
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export function indexedCount(): number {
  return Object.keys(load().videos).length;
}

export function faceCount(): { total: number; grouped: number } {
  const live = everyFace().filter(f => !f.face.ignored);
  return { total: live.length, grouped: live.filter(f => f.face.personId).length };
}

// ── Editing ───────────────────────────────────────────────────────────────────

export function renamePerson(personId: string, name: string): boolean {
  const person = load().people.find(p => p.id === personId);
  if (!person) return false;
  person.name = name.slice(0, 60);
  save();
  return true;
}

/**
 * Fold `sourceIds` into `targetId`, and remember the decision as must-link pairs
 * so a later re-group cannot pull them apart again.
 */
export function mergePeople(targetId: string, sourceIds: string[]): boolean {
  const data = load();
  const target = data.people.find(p => p.id === targetId);
  const sources = data.people.filter(p => p.id !== targetId && sourceIds.includes(p.id));
  if (!target || !sources.length) return false;

  const all = everyFace();
  const anchor = all.find(f => f.face.personId === targetId)?.face;
  for (const source of sources) {
    const theirs = all.filter(f => f.face.personId === source.id);
    if (anchor && theirs[0]) data.links.push([anchor.id, theirs[0].face.id]);
    for (const { face } of theirs) face.personId = targetId;
  }
  const gone = new Set(sources.map(p => p.id));
  data.people = data.people.filter(p => !gone.has(p.id));
  sweepFaceThumbs();
  save();
  return true;
}

/**
 * Remove a person. Their faces are kept but marked ignored, so re-grouping does
 * not simply rebuild them — otherwise "remove" would only last until the next
 * scan.
 */
export function deletePerson(personId: string): boolean {
  const data = load();
  const before = data.people.length;
  data.people = data.people.filter(p => p.id !== personId);
  if (data.people.length === before) return false;
  const dropped = new Set<string>();
  for (const { face } of everyFace()) {
    if (face.personId !== personId) continue;
    face.personId = null;
    face.ignored = true;
    dropped.add(face.id);
  }
  // A must-link naming a face that is now ignored would quietly resurrect them.
  data.links = data.links.filter(([a, b]) => !dropped.has(a) && !dropped.has(b));
  sweepFaceThumbs();
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
  for (const entry of Object.values(data.videos)) {
    for (const face of entry.faces) if (face.personId) live.add(face.personId);
  }
  data.people = data.people.filter(p => live.has(p.id));
  sweepFaceThumbs();
  if (removed) save();
  return removed;
}

/** Wipe the whole index — the "scan again from scratch" button. */
export function resetFaces(): void {
  _file = empty();
  try { fs.rmSync(FACE_THUMB_DIR, { recursive: true, force: true }); } catch { /* already gone */ }
  fs.mkdirSync(FACE_THUMB_DIR, { recursive: true });
  save();
}

/**
 * Delete face crops nothing refers to any more. Re-scanning a video replaces its
 * faces, and re-grouping changes which one represents a person, so the only
 * reliable rule is "keep what is referenced, drop the rest".
 */
export function sweepFaceThumbs(): number {
  const data = load();
  const keep = new Set<string>(data.people.map(p => p.cover));
  for (const entry of Object.values(data.videos)) {
    for (const face of entry.faces) if (face.thumb) keep.add(face.id);
  }
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

function discardThumbs(entry: StoredVideo | undefined): void {
  if (!entry) return;
  for (const face of entry.faces) {
    if (!face.thumb) continue;
    try { fs.rmSync(faceThumbPath(face.id), { force: true }); } catch { /* already gone */ }
  }
}

/** Tests only — drops the cached file so the next read hits disk again. */
export function resetFacesCache(): void {
  _file = null;
}
