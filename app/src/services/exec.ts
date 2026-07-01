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
// Defaults to the CPU core count so a burst of thumbnail/sprite/probe work uses
// EVERY core and finishes fast (important at 400+ videos), then idles. Each job
// runs with `-threads 1` (set by the callers), so N jobs = N cores with no
// oversubscription — this avoids both the old "1 core only" bottleneck and the
// original unbounded fan-out that pinned the host. Override via
// SV_MEDIA_CONCURRENCY (e.g. set to 2 on a tiny shared host).
export const MEDIA_CONCURRENCY = Math.max(
  1,
  Number(process.env.SV_MEDIA_CONCURRENCY) || os.cpus().length,
);

let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MEDIA_CONCURRENCY) { active++; return Promise.resolve(); }
  return new Promise<void>(resolve => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();   // hand the slot directly to the next waiter
  else active--;
}

export async function runMedia(bin: string, args: string[], opts: RunOpts = {}) {
  await acquire();
  try {
    // Keep media work at low priority on Linux so playback/streaming win under
    // contention. `nice` execs in-place (same PID), so a timeout still kills it.
    return process.platform === 'linux'
      ? await execFileP('nice', ['-n', '19', bin, ...args], opts)
      : await execFileP(bin, args, opts);
  } finally {
    release();
  }
}
