import fs from 'fs';
import { FACE_THUMB_DIR } from '../../config';
import { buildMeta, getLibrary } from '../library';
import { probeVideo } from '../media';
import { cosine, cropSquare, mergeCentroid, type Detection, type RgbImage } from './geometry';
import { detectFaces, unloadDetector } from './detect';
import { embedFace, unloadEmbedder } from './embed';
import { extractFrame, writeJpeg } from './frames';
import { ensureModels } from './models';
import {
  isIndexed, listPeople, newFaceId, recordVideo, regroupPeople, faceThumbPath,
  type NewFace,
} from './store';
import type { FaceIndexStatus, VideoItem } from '../../types';

// ── The scan ──────────────────────────────────────────────────────────────────
// Walk the library a video at a time, sample frames, and store an embedding for
// every face found. Deliberately modest about resources: one video at a time,
// one frame at a time, ffmpeg at nice 19 and the ONNX session leaving a core
// free. It is slower than it could be, and it stays invisible to whoever is
// watching something — which is the trade a homelab box wants.
//
// Within a video, repeat appearances of one face are folded into a "track", and
// several frames of that track are kept rather than one. A single shot captures
// one pose; keeping a spread of them is what lets the grouping pass recognise
// the same person in a different video, where the pose and lighting differ.
// Only the clearest frame of each track gets a picture saved — the rest are
// embeddings alone, which cost a few hundred bytes each.

/** Seconds between sampled frames, before the per-video cap applies. */
const SAMPLE_INTERVAL = 10;
/** Frames per video, however long it is. */
const MAX_SAMPLES = 60;
/** Faces kept per frame, best score first — a crowd scene is not worth indexing. */
const MAX_FACES_PER_FRAME = 8;
/** Distinct people the scanner will track inside one video. */
const MAX_TRACKS_PER_VIDEO = 30;
/** Embeddings kept per track, spread across the video. */
const SAMPLES_PER_TRACK = 4;
/** Seconds two kept samples of one track should be apart, so they differ. */
const SAMPLE_GAP = 4;
/**
 * Detection confidence a face needs before it is stored. A doubtful detection is
 * often not a face at all, and its embedding lands anywhere — which is precisely
 * what seeds spurious people.
 */
const MIN_FACE_SCORE = 0.65;
/** Same video, same lighting — the bar for folding repeat appearances together. */
const TRACK_THRESHOLD = 0.5;
const THUMB_SIZE = 160;

interface Sample {
  embedding: Float32Array;
  score: number;
  at: number;
}

interface Track {
  centroid: Float32Array;
  count: number;
  samples: Sample[];
  bestScore: number;
  bestAt: number;
  thumbnail: RgbImage;
}

interface RunState {
  running: boolean;
  cancelled: boolean;
  done: number;
  total: number;
  current?: string;
  phase?: 'models' | 'scanning' | 'grouping';
  error?: string;
  modelProgress?: number;
  finishedAt?: number;
}

const state: RunState = { running: false, cancelled: false, done: 0, total: 0 };

export function getIndexStatus(): FaceIndexStatus {
  return {
    running: state.running,
    done: state.done,
    total: state.total,
    ...(state.current !== undefined && { current: state.current }),
    ...(state.phase !== undefined && { phase: state.phase }),
    people: listPeople().length,
    ...(state.error !== undefined && { error: state.error }),
    ...(state.modelProgress !== undefined && { modelProgress: state.modelProgress }),
    ...(state.finishedAt !== undefined && { finishedAt: state.finishedAt }),
  };
}

export function stopIndexing(): void {
  if (state.running) state.cancelled = true;
}

/** Times to sample, spread evenly and kept clear of the very start and end. */
export function sampleTimes(duration: number): number[] {
  const length = Math.max(1, duration || 0);
  const count = Math.max(1, Math.min(MAX_SAMPLES, Math.ceil(length / SAMPLE_INTERVAL)));
  const step = length / count;
  return Array.from({ length: count }, (_, i) => Math.min(length - 0.5, (i + 0.5) * step));
}

/**
 * Pick which frames of a track to keep: clearest first, but preferring ones far
 * enough apart in time to actually show something different. Pure, so the
 * selection rule is testable on its own.
 */
export function pickSamples(samples: Sample[], limit = SAMPLES_PER_TRACK, gap = SAMPLE_GAP): Sample[] {
  const byScore = [...samples].sort((a, b) => b.score - a.score);
  const kept: Sample[] = [];
  for (const sample of byScore) {
    if (kept.length >= limit) break;
    if (kept.every(k => Math.abs(k.at - sample.at) >= gap)) kept.push(sample);
  }
  // A short clip may have nothing far enough apart; take the best regardless
  // rather than storing a single frame of a person who is on screen throughout.
  for (const sample of byScore) {
    if (kept.length >= limit) break;
    if (!kept.includes(sample)) kept.push(sample);
  }
  return kept;
}

/** Fold a face into the track it belongs to, or start a new one. */
function addToTracks(
  tracks: Track[], embedding: Float32Array, detection: Detection, frame: RgbImage, at: number,
): void {
  let best: Track | null = null;
  let bestSimilarity = -1;
  for (const track of tracks) {
    const similarity = cosine(embedding, track.centroid);
    if (similarity > bestSimilarity) { bestSimilarity = similarity; best = track; }
  }

  if (best && bestSimilarity >= TRACK_THRESHOLD) {
    best.centroid = mergeCentroid(best.centroid, best.count, embedding);
    best.count++;
    best.samples.push({ embedding, score: detection.score, at });
    // Keep the clearest shot of this person as their picture for this video.
    if (detection.score > best.bestScore) {
      best.bestScore = detection.score;
      best.bestAt = at;
      best.thumbnail = cropSquare(frame, detection.box, THUMB_SIZE);
    }
    return;
  }
  if (tracks.length >= MAX_TRACKS_PER_VIDEO) return;
  tracks.push({
    centroid: embedding,
    count: 1,
    samples: [{ embedding, score: detection.score, at }],
    bestScore: detection.score,
    bestAt: at,
    thumbnail: cropSquare(frame, detection.box, THUMB_SIZE),
  });
}

/**
 * Length and frame size, probing the file when the library has not cached them.
 * Both are load-bearing: without the duration the scan samples a single frame at
 * the very start, and without the real aspect ratio every frame is squeezed into
 * a square, which distorts faces enough to break both detection and matching.
 */
async function dimensions(video: VideoItem): Promise<{ duration: number; width: number; height: number }> {
  if (video.duration && video.width && video.height) {
    return { duration: video.duration, width: video.width, height: video.height };
  }
  const probe = await probeVideo(video.absPath) as {
    streams?: Array<Record<string, unknown>>; format?: { duration?: string };
  };
  const stream = (probe.streams ?? []).find(s => s['codec_type'] === 'video');
  const duration = parseFloat(String(probe.format?.duration ?? stream?.['duration'] ?? '0'));
  const width = Number(stream?.['width'] ?? 0);
  const height = Number(stream?.['height'] ?? 0);
  // Throwing leaves the video unrecorded, so the next scan tries it again rather
  // than writing it off as "no faces here".
  if (!(duration > 0) || !width || !height) throw new Error(`Cannot read ${video.name}`);
  return { duration, width, height };
}

async function scanVideo(video: VideoItem): Promise<void> {
  const stat = fs.statSync(video.absPath);
  const { duration, width, height } = await dimensions(video);
  const tracks: Track[] = [];

  for (const at of sampleTimes(duration)) {
    if (state.cancelled) return;
    let frame: RgbImage | null = null;
    try { frame = await extractFrame(video.absPath, at, width, height); }
    catch { continue; } // an unreadable moment is not a reason to abandon the video
    if (!frame) continue;

    let detections: Detection[];
    try { detections = await detectFaces(frame); }
    catch { continue; }

    const top = detections
      .filter(d => d.score >= MIN_FACE_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_FACES_PER_FRAME);
    for (const detection of top) {
      if (state.cancelled) return;
      try {
        const embedding = await embedFace(frame, detection);
        addToTracks(tracks, embedding, detection, frame, at);
      } catch { /* skip this face */ }
    }
  }
  if (state.cancelled) return;

  // One picture per track — the clearest frame — plus a spread of embeddings
  // that carry no picture and exist purely so grouping has something to work
  // with beyond a single pose.
  const faces: NewFace[] = [];
  for (const track of tracks) {
    const thumbId = newFaceId();
    try { await writeJpeg(track.thumbnail, faceThumbPath(thumbId)); }
    catch { continue; } // no picture, no entry — the People page needs a face
    faces.push({ id: thumbId, score: track.bestScore, at: track.bestAt, embedding: track.centroid, thumb: true });
    for (const sample of pickSamples(track.samples)) {
      if (sample.at === track.bestAt) continue;
      faces.push({ id: newFaceId(), score: sample.score, at: sample.at, embedding: sample.embedding });
    }
  }
  recordVideo(video.relPath, stat, faces);
}

export interface IndexOptions {
  /** Limit the scan to one folder (and, by default, everything under it). */
  folder?: string;
  deep?: boolean;
  /** Re-scan videos that were already indexed. */
  force?: boolean;
}

function videosToScan(options: IndexOptions): VideoItem[] {
  const folder = options.folder ?? '';
  const deep = options.deep !== false;
  const prefix = folder ? folder + '/' : '';
  return getLibrary()
    .filter(v => !folder || v.folder === folder || (deep && v.folder.startsWith(prefix)))
    .filter(v => {
      if (options.force) return true;
      try { return !isIndexed(v.relPath, fs.statSync(v.absPath)); } catch { return false; }
    });
}

/**
 * Start a scan in the background. Returns immediately; progress is read from
 * getIndexStatus(). Calling it while a scan runs is a no-op.
 */
export function startIndexing(options: IndexOptions = {}): FaceIndexStatus {
  if (state.running) return getIndexStatus();
  const queue = videosToScan(options);

  state.running = true;
  state.cancelled = false;
  state.done = 0;
  state.total = queue.length;
  delete state.error;
  delete state.current;
  delete state.finishedAt;

  void (async () => {
    try {
      fs.mkdirSync(FACE_THUMB_DIR, { recursive: true });
      // First run only: pull the models down, reporting progress so the UI can
      // explain why nothing is happening yet.
      state.phase = 'models';
      state.modelProgress = 0;
      await ensureModels(pct => { state.modelProgress = pct; });
      delete state.modelProgress;
      // Make sure durations and frame sizes are cached before sampling anything;
      // a library that has only just been rescanned has neither.
      await buildMeta();

      state.phase = 'scanning';
      for (const video of queue) {
        if (state.cancelled) break;
        state.current = video.name;
        try { await scanVideo(video); }
        catch { /* a video that cannot be scanned must not stop the run */ }
        state.done++;
      }

      // Faces are stored without an owner; who they belong to is decided here,
      // across the whole library at once, so the answer cannot depend on the
      // order the videos happened to be scanned in.
      delete state.current;
      state.phase = 'grouping';
      regroupPeople(undefined, (done, total) => {
        state.done = done;
        state.total = total;
      });
    } catch (err) {
      state.error = (err as Error).message;
    } finally {
      // Hand the models' memory back — a 4 GB box should not carry an idle
      // inference session around between scans.
      unloadDetector();
      unloadEmbedder();
      delete state.modelProgress;
      delete state.current;
      delete state.phase;
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  return getIndexStatus();
}

/**
 * Re-group everyone from the stored embeddings, with no re-scanning. This is
 * what makes the grouping settings usable: changing them is seconds of work on
 * data already on disk, not hours of video.
 */
export function regroupNow(options?: { threshold?: number; minFaces?: number }): FaceIndexStatus {
  if (state.running) return getIndexStatus();
  state.running = true;
  state.cancelled = false;
  state.phase = 'grouping';
  state.done = 0;
  state.total = 0;
  delete state.error;
  delete state.finishedAt;

  void (async () => {
    try {
      regroupPeople(options, (done, total) => { state.done = done; state.total = total; });
    } catch (err) {
      state.error = (err as Error).message;
    } finally {
      delete state.phase;
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  return getIndexStatus();
}
