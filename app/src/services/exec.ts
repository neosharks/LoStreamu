import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execFileP = promisify(execFile);

export interface RunOpts {
  timeout?: number;
  maxBuffer?: number;
}

// Concurrency cap for CPU-heavy media tools (ffmpeg / ffprobe).
//
// Batch work (thumbnails / probes) fans out across cores to finish fast at 400+
// videos, but we deliberately LEAVE ONE CORE FREE so the event loop, HTTP layer,
// and — critically — active video streaming stay responsive instead of the host
// pinning at 100%. Each job runs with `-threads 1` (set by the callers), so N
// jobs = N cores with no oversubscription. Override via SV_MEDIA_CONCURRENCY
// (e.g. set to 2 on a tiny shared host).
const CORES = Math.max(1, os.cpus().length);
export const MEDIA_CONCURRENCY = Math.max(
  1,
  Number(process.env.SV_MEDIA_CONCURRENCY) || Math.max(1, CORES - 1),
);

// A small, SEPARATE cap for scrub-preview frames. Opening a video must not fire
// dozens of ffmpeg jobs across every core while that same video is decoding for
// playback — that's what made previews slow AND spiked CPU. Bounding previews to
// ~half the cores (2–4) keeps generation fast yet leaves plenty for streaming.
// Override via SV_PREVIEW_CONCURRENCY.
export const PREVIEW_CONCURRENCY = Math.max(
  1,
  Number(process.env.SV_PREVIEW_CONCURRENCY) || Math.min(4, Math.max(2, Math.floor(CORES / 2))),
);

// Minimal counting semaphore — hand a freed slot straight to the next waiter.
export function createLimiter(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    active < max ? (active++, Promise.resolve()) : new Promise<void>(r => waiters.push(r));
  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else active--;
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try { return await fn(); } finally { release(); }
    },
  };
}

const mediaLimiter = createLimiter(MEDIA_CONCURRENCY);

export async function runMedia(bin: string, args: string[], opts: RunOpts = {}) {
  return mediaLimiter.run(() =>
    // Keep media work at low priority on Linux so playback/streaming win under
    // contention. `nice` execs in-place (same PID), so a timeout still kills it.
    process.platform === 'linux'
      ? execFileP('nice', ['-n', '19', bin, ...args], opts)
      : execFileP(bin, args, opts),
  );
}
