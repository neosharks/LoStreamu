import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import os from 'os';
import { MODELS_DIR } from '../../config';

// ── Face models ───────────────────────────────────────────────────────────────
// Two ONNX models from the InsightFace "buffalo" packs, run through
// onnxruntime-node on the CPU:
//   • detection  — SCRFD, finds faces and their five landmarks
//   • recognition— ArcFace, turns an aligned face into a 512-d embedding
//
// `small` (buffalo_s, ~16 MB total) is the default: on a 4-vCPU homelab box it
// is several times faster than `large` and still separates people reliably in a
// personal library. Set SV_FACE_MODELS=large for buffalo_l (~191 MB) when the
// box has cores to spare.
//
// The files are downloaded on first use and cached in DATA_DIR/models, so they
// survive app updates. Dropping them in by hand works too — anything already on
// disk is used as-is and never re-fetched.

export type ModelSize = 'small' | 'large';

const SOURCES: Record<ModelSize, { detection: string; recognition: string }> = {
  small: {
    detection: 'https://huggingface.co/immich-app/buffalo_s/resolve/main/detection/model.onnx',
    recognition: 'https://huggingface.co/immich-app/buffalo_s/resolve/main/recognition/model.onnx',
  },
  large: {
    detection: 'https://huggingface.co/immich-app/buffalo_l/resolve/main/detection/model.onnx',
    recognition: 'https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx',
  },
};

export function modelSize(): ModelSize {
  return process.env.SV_FACE_MODELS === 'large' ? 'large' : 'small';
}

export function modelPath(kind: 'detection' | 'recognition', size = modelSize()): string {
  return path.join(MODELS_DIR, `${size}-${kind}.onnx`);
}

export function modelsPresent(size = modelSize()): boolean {
  return (['detection', 'recognition'] as const).every(kind => {
    try { return fs.statSync(modelPath(kind, size)).size > 0; } catch { return false; }
  });
}

// ── onnxruntime ───────────────────────────────────────────────────────────────
// Loaded lazily and by name: everything outside the face index must keep working
// on a box where the native runtime failed to install, and the error has to say
// so rather than taking the server down at boot.

export interface OrtTensor { data: Float32Array; dims: readonly number[]; }
export interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  inputNames: readonly string[];
  outputNames: readonly string[];
}
interface Ort {
  InferenceSession: { create(path: string, options?: unknown): Promise<OrtSession> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
}

let _ort: Ort | null = null;

export function loadRuntime(): Ort {
  if (_ort) return _ort;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _ort = require('onnxruntime-node') as Ort;
  } catch {
    throw new Error(
      'onnxruntime-node is not installed on this server, so faces cannot be scanned. '
      + 'Run `npm install` in the app directory and restart.',
    );
  }
  return _ort;
}

export function makeTensor(data: Float32Array, dims: number[]): OrtTensor {
  return new (loadRuntime().Tensor)('float32', data, dims);
}

export async function createSession(file: string): Promise<OrtSession> {
  const ort = loadRuntime();
  // Leave a core free: the scan must never starve the HTTP layer or a stream.
  const threads = Math.max(1, os.cpus().length - 1);
  return ort.InferenceSession.create(file, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
  });
}

// ── Download ──────────────────────────────────────────────────────────────────

export interface DownloadProgress { (percent: number): void; }

async function fetchModel(url: string, dest: string, onProgress?: DownloadProgress): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'streamvault/2' } });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;

  const tmp = dest + '.part';
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  if (onProgress && total > 0) {
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      onProgress(Math.min(99, Math.round((received / total) * 100)));
    });
  }
  await pipeline(source, fs.createWriteStream(tmp));
  // Only ever rename a complete file into place, so an interrupted download can
  // never leave a truncated model that fails at load time instead of here.
  fs.renameSync(tmp, dest);
}

/** Fetch whatever is missing. No-op once both models are on disk. */
export async function ensureModels(onProgress?: DownloadProgress): Promise<void> {
  const size = modelSize();
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const kinds = (['detection', 'recognition'] as const).filter(kind => {
    try { return fs.statSync(modelPath(kind, size)).size === 0; } catch { return true; }
  });
  if (!kinds.length) return;

  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i]!;
    const dest = modelPath(kind, size);
    try {
      await fetchModel(SOURCES[size][kind], dest, pct => {
        // Spread each file's progress across its share of the whole download.
        onProgress?.(Math.round(((i + pct / 100) / kinds.length) * 100));
      });
    } catch (err) {
      try { fs.rmSync(dest + '.part', { force: true }); } catch { /* already gone */ }
      throw new Error(
        `Could not download the ${kind} model (${(err as Error).message}). `
        + `Check the server's internet access, or place the file at ${dest} by hand.`,
      );
    }
  }
  onProgress?.(100);
}
