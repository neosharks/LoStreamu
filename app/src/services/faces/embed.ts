import {
  similarityTransform, warpAffine, l2Normalize, ARCFACE_TEMPLATE,
  type Detection, type RgbImage,
} from './geometry';
import { createSession, makeTensor, modelPath, type OrtSession, type OrtTensor } from './models';

// ── ArcFace embeddings ────────────────────────────────────────────────────────
// The recognition model turns one aligned face into a 512-number vector whose
// direction identifies the person: two crops of the same face point almost the
// same way, two different people point apart. Alignment matters as much as the
// model — the five landmarks are warped onto a fixed 112×112 template first, so
// head tilt and distance stop affecting the result.

const CROP_SIZE = 112;

let session: OrtSession | null = null;

export async function loadEmbedder(): Promise<void> {
  if (!session) session = await createSession(modelPath('recognition'));
}

export function unloadEmbedder(): void {
  session = null;
}

/** The upright, template-aligned 112×112 crop the model expects. */
export function alignFace(frame: RgbImage, detection: Detection): RgbImage {
  const transform = similarityTransform(detection.landmarks, ARCFACE_TEMPLATE);
  return warpAffine(frame, transform, CROP_SIZE, CROP_SIZE);
}

function toFaceTensor(face: RgbImage): OrtTensor {
  const pixels = face.width * face.height;
  const data = new Float32Array(pixels * 3);
  // NCHW with ArcFace's normalisation: (x - 127.5) / 127.5.
  for (let i = 0; i < pixels; i++) {
    data[i] = (face.data[i * 3]! - 127.5) / 127.5;
    data[pixels + i] = (face.data[i * 3 + 1]! - 127.5) / 127.5;
    data[pixels * 2 + i] = (face.data[i * 3 + 2]! - 127.5) / 127.5;
  }
  return makeTensor(data, [1, 3, face.height, face.width]);
}

/** Unit-length embedding for one detected face. */
export async function embedFace(frame: RgbImage, detection: Detection): Promise<Float32Array> {
  await loadEmbedder();
  const active = session;
  if (!active) throw new Error('Face recognition model is not loaded');
  const feeds: Record<string, OrtTensor> = {
    [active.inputNames[0] as string]: toFaceTensor(alignFace(frame, detection)),
  };
  const result = await active.run(feeds);
  const output = result[active.outputNames[0] as string];
  if (!output) throw new Error('Face recognition model returned nothing');
  return l2Normalize(output.data);
}
