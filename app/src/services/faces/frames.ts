import fs from 'fs';
import { spawn } from 'child_process';
import type { RgbImage } from './geometry';

// Frame I/O for the face scanner. Frames come out of ffmpeg as raw RGB so no
// image library is needed, and thumbnails go back in the same way.
//
// Each frame is pulled with an INPUT SEEK (`-ss` before `-i`), which jumps to a
// nearby keyframe in roughly constant time however long the file is — the same
// trick services/preview.ts uses. Decoding the whole file to sample it would
// take minutes per video.

/** Longest edge a sampled frame is scaled to before detection. */
export const FRAME_MAX_EDGE = 1280;

/** Even dimensions — the raw/JPEG pipelines reject odd ones. */
export function frameSize(width: number, height: number, maxEdge = FRAME_MAX_EDGE): { w: number; h: number } {
  const longest = Math.max(width, height) || maxEdge;
  const scale = Math.min(1, maxEdge / longest);
  const even = (n: number) => Math.max(2, Math.round(n * scale / 2) * 2);
  return { w: even(width || maxEdge), h: even(height || maxEdge) };
}

function run(args: string[], stdin?: Buffer, timeout = 30000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Low priority on Linux so a library-wide scan never outbids playback.
    const child = process.platform === 'linux'
      ? spawn('nice', ['-n', '19', 'ffmpeg', ...args])
      : spawn('ffmpeg', args);
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeout);

    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-800); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
    });
    if (stdin) { child.stdin.end(stdin); }
    else child.stdin.end();
  });
}

/** One frame at `seconds`, as raw RGB. Null when the seek lands past the end. */
export async function extractFrame(
  absPath: string, seconds: number, width: number, height: number,
): Promise<RgbImage | null> {
  const { w, h } = frameSize(width, height);
  const buf = await run([
    '-nostdin', '-threads', '1',
    '-ss', seconds.toFixed(2), '-i', absPath,
    '-frames:v', '1', '-an', '-vf', `scale=${w}:${h}`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
  ]);
  if (buf.length < w * h * 3) return null;
  return { data: new Uint8Array(buf.subarray(0, w * h * 3)), width: w, height: h };
}

/** Write an RGB image out as a JPEG. */
export async function writeJpeg(image: RgbImage, dest: string): Promise<void> {
  const jpeg = await run([
    '-nostdin', '-threads', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${image.width}x${image.height}`, '-i', 'pipe:0',
    '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', '-',
  ], Buffer.from(image.data));
  fs.writeFileSync(dest, jpeg);
}
