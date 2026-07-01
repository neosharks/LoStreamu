import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export interface RunOpts {
  timeout?: number;
  maxBuffer?: number;
}

// CPU-heavy media tools (ffmpeg / ffprobe) run ONE AT A TIME, at low priority.
//
// Without this, a single library load fans out into dozens of parallel ffmpeg
// processes (one per thumbnail/sprite request) and every core pins to 100%,
// making the host unusable. Serializing + `nice` keeps media generation to a
// single low-priority core so playback and streaming stay responsive.
let chain: Promise<unknown> = Promise.resolve();

export function runMedia(bin: string, args: string[], opts: RunOpts = {}) {
  const exec = () =>
    process.platform === 'linux'
      // `nice` execs the target in-place (same PID), so a timeout still kills ffmpeg.
      ? execFileP('nice', ['-n', '19', bin, ...args], opts)
      : execFileP(bin, args, opts);

  const run = chain.then(exec, exec);
  chain = run.then(() => {}, () => {}); // keep the queue alive past failures
  return run;
}
