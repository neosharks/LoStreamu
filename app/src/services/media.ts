import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { APP_DIR } from '../config';

const execFileP = promisify(execFile);
const THUMB_DIR = path.join(APP_DIR, 'thumbnails');

export function thumbPath(id: string): string {
  return path.join(THUMB_DIR, `${id}.jpg`);
}

export function spritePath(id: string): string {
  return path.join(THUMB_DIR, `${id}.sprite.jpg`);
}

export function vttPath(id: string): string {
  return path.join(THUMB_DIR, `${id}.vtt`);
}

function ensureThumbDir(): void {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
}

export async function generateThumb(id: string, absPath: string, durationSec: number): Promise<string> {
  ensureThumbDir();
  const out = thumbPath(id);
  if (fs.existsSync(out)) return out;
  const seek = Math.max(1, durationSec * 0.2).toFixed(2);
  await execFileP('ffmpeg', [
    '-ss', seek, '-i', absPath,
    '-vframes', '1', '-vf', 'scale=480:-2',
    '-q:v', '5', '-y', out,
  ], { timeout: 20000 });
  return out;
}

export async function generateSprite(
  id: string,
  absPath: string,
  durationSec: number,
): Promise<{ sprite: string; vtt: string }> {
  ensureThumbDir();
  const sprite = spritePath(id);
  const vtt = vttPath(id);
  if (fs.existsSync(sprite) && fs.existsSync(vtt)) return { sprite, vtt };

  const COLS = 5, ROWS = 5, W = 160, H = 90;
  const total = COLS * ROWS;
  const interval = Math.max(1, durationSec / total);
  const tmpDir = path.join(THUMB_DIR, `${id}_tmp`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    await execFileP('ffmpeg', [
      '-i', absPath,
      '-vf', `fps=1/${interval.toFixed(2)},scale=${W}:${H}`,
      '-frames:v', String(total),
      '-q:v', '5', '-y',
      path.join(tmpDir, 'f%03d.jpg'),
    ], { timeout: 60000 });

    const frames = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.jpg'))
      .sort()
      .slice(0, total);

    const inputs = frames.map(f => ['-i', path.join(tmpDir, f)]).flat();
    await execFileP('ffmpeg', [
      ...inputs,
      '-filter_complex', `tile=${COLS}x${ROWS}`,
      '-q:v', '5', '-y', sprite,
    ], { timeout: 30000 });

    const lines = ['WEBVTT', ''];
    frames.forEach((_, i) => {
      const t = i * interval;
      const col = i % COLS, row = Math.floor(i / COLS);
      const fmt = (s: number) => {
        const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
      };
      lines.push(fmt(t) + ' --> ' + fmt(t + interval));
      lines.push(`sprite.jpg#xywh=${col * W},${row * H},${W},${H}`, '');
    });
    fs.writeFileSync(vtt, lines.join('\n'));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  return { sprite, vtt };
}
