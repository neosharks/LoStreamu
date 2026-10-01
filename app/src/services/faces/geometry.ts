// Pure image + vector maths behind face detection. No ONNX, no disk, no ffmpeg —
// everything here is a function of its arguments, so the fiddly parts (anchor
// decoding, the alignment transform, overlap suppression) are unit-testable
// without any model files present.

export interface Box { x1: number; y1: number; x2: number; y2: number; }

export interface Detection {
  box: Box;
  score: number;
  /** Five landmarks — eyes, nose, mouth corners — in source-image pixels. */
  landmarks: Array<[number, number]>;
}

/** A plain RGB image: `data` is width*height*3 bytes, row-major. */
export interface RgbImage { data: Uint8Array; width: number; height: number; }

// ── Letterbox ────────────────────────────────────────────────────────────────
// SCRFD wants a fixed square input. Scale the frame down to fit, pin it to the
// top-left and pad the rest black — the layout InsightFace itself uses, so
// detections map back by a single divide.

export interface Letterboxed { image: RgbImage; scale: number; }

export function letterbox(src: RgbImage, size: number): Letterboxed {
  const scale = Math.min(size / src.width, size / src.height);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const data = new Uint8Array(size * size * 3); // zero-filled = black padding
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const from = (sy * src.width + sx) * 3;
      const to = (y * size + x) * 3;
      data[to] = src.data[from]!;
      data[to + 1] = src.data[from + 1]!;
      data[to + 2] = src.data[from + 2]!;
    }
  }
  return { image: { data, width: size, height: size }, scale };
}

// ── Anchors + box decoding ───────────────────────────────────────────────────
// SCRFD predicts, per anchor, the distance from the anchor centre to each of the
// four box edges, in stride units. Anchor centres are the cell centres of a
// stride-sized grid, each repeated `perCell` times (2 for every buffalo model).

export function anchorCenters(size: number, stride: number, perCell: number): Float32Array {
  const n = Math.ceil(size / stride);
  const out = new Float32Array(n * n * perCell * 2);
  let i = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      for (let a = 0; a < perCell; a++) {
        out[i++] = x * stride;
        out[i++] = y * stride;
      }
    }
  }
  return out;
}

export function distanceToBox(cx: number, cy: number, d: ArrayLike<number>, offset: number, stride: number): Box {
  return {
    x1: cx - d[offset]! * stride,
    y1: cy - d[offset + 1]! * stride,
    x2: cx + d[offset + 2]! * stride,
    y2: cy + d[offset + 3]! * stride,
  };
}

export function distanceToPoints(
  cx: number, cy: number, d: ArrayLike<number>, offset: number, stride: number, count: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    pts.push([cx + d[offset + i * 2]! * stride, cy + d[offset + i * 2 + 1]! * stride]);
  }
  return pts;
}

// ── Non-maximum suppression ──────────────────────────────────────────────────

export function iou(a: Box, b: Box): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (w <= 0 || h <= 0) return 0;
  const overlap = w * h;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - overlap;
  return union > 0 ? overlap / union : 0;
}

/** Highest score wins; anything overlapping it by more than `threshold` goes. */
export function nms(detections: Detection[], threshold: number): Detection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const det of sorted) {
    if (kept.every(k => iou(k.box, det.box) <= threshold)) kept.push(det);
  }
  return kept;
}

// ── Alignment ────────────────────────────────────────────────────────────────
// ArcFace expects the face rotated upright and scaled so the five landmarks land
// on fixed positions in a 112×112 crop. That is a 2D similarity transform — four
// degrees of freedom — which has a closed-form least-squares solution, so no
// matrix library is needed.

/** The ArcFace 112×112 landmark template: eyes, nose, mouth corners. */
export const ARCFACE_TEMPLATE: Array<[number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/** Row-major 2×3 affine: [a, b, tx, c, d, ty], mapping x' = a·x + b·y + tx. */
export type Affine = [number, number, number, number, number, number];

export function similarityTransform(src: Array<[number, number]>, dst: Array<[number, number]>): Affine {
  const n = Math.min(src.length, dst.length);
  let mpx = 0, mpy = 0, mqx = 0, mqy = 0;
  for (let i = 0; i < n; i++) {
    mpx += src[i]![0]; mpy += src[i]![1];
    mqx += dst[i]![0]; mqy += dst[i]![1];
  }
  mpx /= n; mpy /= n; mqx /= n; mqy /= n;

  let a = 0, b = 0, varP = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i]![0] - mpx, py = src[i]![1] - mpy;
    const qx = dst[i]![0] - mqx, qy = dst[i]![1] - mqy;
    a += px * qx + py * qy;   // scaled cosine
    b += px * qy - py * qx;   // scaled sine
    varP += px * px + py * py;
  }
  // Degenerate input (all five landmarks on one spot): fall back to a translation.
  if (varP === 0) return [1, 0, mqx - mpx, 0, 1, mqy - mpy];
  const cos = a / varP;
  const sin = b / varP;
  return [cos, -sin, mqx - (cos * mpx - sin * mpy), sin, cos, mqy - (sin * mpx + cos * mpy)];
}

export function invertAffine(m: Affine): Affine {
  const det = m[0] * m[4] - m[1] * m[3];
  if (det === 0) return [1, 0, 0, 0, 1, 0];
  const a = m[4] / det, b = -m[1] / det, c = -m[3] / det, d = m[0] / det;
  return [a, b, -(a * m[2] + b * m[5]), c, d, -(c * m[2] + d * m[5])];
}

/**
 * Resample `src` into a `width`×`height` image through `forward` (src → out),
 * sampling bilinearly along the inverse so every output pixel gets a value.
 */
export function warpAffine(src: RgbImage, forward: Affine, width: number, height: number): RgbImage {
  const inv = invertAffine(forward);
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = inv[0] * x + inv[1] * y + inv[2];
      const sy = inv[3] * x + inv[4] * y + inv[5];
      const out = (y * width + x) * 3;
      if (sx < 0 || sy < 0 || sx > src.width - 1 || sy > src.height - 1) continue; // black
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        const p00 = src.data[(y0 * src.width + x0) * 3 + c]!;
        const p10 = src.data[(y0 * src.width + x1) * 3 + c]!;
        const p01 = src.data[(y1 * src.width + x0) * 3 + c]!;
        const p11 = src.data[(y1 * src.width + x1) * 3 + c]!;
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        data[out + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return { data, width, height };
}

/** Square crop around a box with margin, scaled to `size` — the face thumbnail. */
export function cropSquare(src: RgbImage, box: Box, size: number, margin = 0.4): RgbImage {
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  const half = (Math.max(box.x2 - box.x1, box.y2 - box.y1) / 2) * (1 + margin);
  const scale = size / (half * 2);
  // Place the crop's top-left corner at the output origin, then scale to size.
  const forward: Affine = [scale, 0, -(cx - half) * scale, 0, scale, -(cy - half) * scale];
  return warpAffine(src, forward, size, size);
}

// ── Embeddings ───────────────────────────────────────────────────────────────

export function l2Normalize(v: Float32Array | number[]): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** Cosine similarity. Both sides are expected to be L2-normalised already. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** Running mean of unit vectors, renormalised — a person's centroid. */
export function mergeCentroid(
  centroid: ArrayLike<number>, count: number, incoming: ArrayLike<number>,
): Float32Array {
  const out = new Float32Array(centroid.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = (centroid[i]! * count + incoming[i]!) / (count + 1);
  }
  return l2Normalize(out);
}
