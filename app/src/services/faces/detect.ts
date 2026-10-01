import {
  letterbox, anchorCenters, distanceToBox, distanceToPoints, nms,
  type Detection, type RgbImage,
} from './geometry';
import { createSession, makeTensor, modelPath, type OrtSession, type OrtTensor } from './models';

// ── SCRFD face detection ──────────────────────────────────────────────────────
// The buffalo detection models take a 640×640 letterboxed RGB frame and emit, for
// three strides (8/16/32), one score / box / landmark tensor each. Every anchor
// position carries `perCell` anchors, and boxes are expressed as distances from
// the anchor centre to the four edges, in stride units.
//
// Outputs are matched by SHAPE rather than by name or position: the last
// dimension says what a tensor is (1 = score, 4 = box, 10 = landmarks) and the
// row count says which stride it belongs to. That keeps this working across the
// small and large packs, which name their outputs differently.

const INPUT_SIZE = 640;
const STRIDES = [8, 16, 32];
const SCORE_THRESHOLD = 0.5;
const NMS_THRESHOLD = 0.4;
/** Faces smaller than this (longest edge, source pixels) are too blurry to match. */
const MIN_FACE_PX = 40;

let session: OrtSession | null = null;

export async function loadDetector(): Promise<void> {
  if (!session) session = await createSession(modelPath('detection'));
}

export function unloadDetector(): void {
  session = null;
}

/** Grouped by last dimension, each list ordered stride 8 → 16 → 32. */
interface Grouped { scores: OrtTensor[]; boxes: OrtTensor[]; points: OrtTensor[]; }

export function groupOutputs(tensors: OrtTensor[]): Grouped {
  const rows = (t: OrtTensor) => t.data.length / lastDim(t);
  const byWidth = (width: number) => tensors
    .filter(t => lastDim(t) === width)
    .sort((a, b) => rows(b) - rows(a));   // most anchors = smallest stride
  return { scores: byWidth(1), boxes: byWidth(4), points: byWidth(10) };
}

function lastDim(t: OrtTensor): number {
  return t.dims[t.dims.length - 1] || 1;
}

function toImageTensor(image: RgbImage): OrtTensor {
  const pixels = image.width * image.height;
  const data = new Float32Array(pixels * 3);
  // NCHW, and the normalisation SCRFD was trained with: (x - 127.5) / 128.
  for (let i = 0; i < pixels; i++) {
    data[i] = (image.data[i * 3]! - 127.5) / 128;
    data[pixels + i] = (image.data[i * 3 + 1]! - 127.5) / 128;
    data[pixels * 2 + i] = (image.data[i * 3 + 2]! - 127.5) / 128;
  }
  return makeTensor(data, [1, 3, image.height, image.width]);
}

/** Every face in the frame, in source-image coordinates. */
export async function detectFaces(frame: RgbImage): Promise<Detection[]> {
  await loadDetector();
  const active = session;
  if (!active) return [];

  const { image, scale } = letterbox(frame, INPUT_SIZE);
  const feeds: Record<string, OrtTensor> = { [active.inputNames[0] as string]: toImageTensor(image) };
  const result = await active.run(feeds);
  const grouped = groupOutputs(active.outputNames.map(name => result[name] as OrtTensor).filter(Boolean));
  if (grouped.scores.length < STRIDES.length) return [];

  // Anchors per cell is whatever makes the stride-8 tensor's row count add up.
  const cells8 = (INPUT_SIZE / STRIDES[0]!) ** 2;
  const perCell = Math.max(1, Math.round(grouped.scores[0]!.data.length / cells8));

  const found: Detection[] = [];
  for (let s = 0; s < STRIDES.length; s++) {
    const stride = STRIDES[s]!;
    const scores = grouped.scores[s];
    const boxes = grouped.boxes[s];
    const points = grouped.points[s];
    if (!scores || !boxes) continue;
    const centers = anchorCenters(INPUT_SIZE, stride, perCell);
    const count = Math.min(scores.data.length, centers.length / 2);

    for (let i = 0; i < count; i++) {
      const score = scores.data[i]!;
      if (score < SCORE_THRESHOLD) continue;
      const cx = centers[i * 2]!;
      const cy = centers[i * 2 + 1]!;
      const box = distanceToBox(cx, cy, boxes.data, i * 4, stride);
      const landmarks = points
        ? distanceToPoints(cx, cy, points.data, i * 10, stride, 5)
        : [];
      // Undo the letterbox so everything downstream works in frame pixels.
      found.push({
        score,
        box: { x1: box.x1 / scale, y1: box.y1 / scale, x2: box.x2 / scale, y2: box.y2 / scale },
        landmarks: landmarks.map(([x, y]) => [x / scale, y / scale] as [number, number]),
      });
    }
  }

  return nms(found, NMS_THRESHOLD).filter(d => {
    const size = Math.max(d.box.x2 - d.box.x1, d.box.y2 - d.box.y1);
    return size >= MIN_FACE_PX && d.landmarks.length === 5;
  });
}
