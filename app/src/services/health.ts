import fs from 'fs';
import path from 'path';
import { probeVideo } from './media';
import type { VideoItem, VideoHealth, HealthLevel, RepairPlan } from '../types';

// ── Playability ───────────────────────────────────────────────────────────────
// A file that downloaded fine can still refuse to play in the browser. The three
// causes, in the order they actually bite:
//   • a codec <video> cannot decode — HEVC, AV1, MPEG-4 ASP, AC-3/Opus audio
//   • a container no browser opens — MKV, AVI, TS, FLV, WMV, even when the
//     streams inside are perfectly ordinary H.264 + AAC
//   • an MP4 whose moov index sits AFTER the media data, so the player has to
//     pull the whole file before it can start or seek
// classifyHealth() names which of those applies and what would fix it. Pure, so
// the whole decision table is unit-testable without any media on disk.

/** Decodes in every browser we care about, including Safari/iOS. */
const SAFE_VIDEO = new Set(['h264', 'avc1']);
/** Plays in Chrome/Firefox but not Safari or iOS. */
const LIMITED_VIDEO = new Set(['vp8', 'vp9', 'av1']);
const SAFE_AUDIO = new Set(['aac', 'mp3', 'mp4a']);
const LIMITED_AUDIO = new Set(['opus', 'vorbis']);

/** Containers a browser opens directly. */
const SAFE_CONTAINERS = new Set(['.mp4', '.m4v', '.webm']);

export interface HealthInput {
  ext: string;
  vcodec?: string;
  acodec?: string;
  /** MP4 only — undefined for containers where the question is meaningless. */
  faststart?: boolean;
  duration?: number;
}

const worst = (a: HealthLevel, b: HealthLevel): HealthLevel =>
  a === 'broken' || b === 'broken' ? 'broken' : a === 'warn' || b === 'warn' ? 'warn' : 'ok';

export function classifyHealth(input: HealthInput): VideoHealth {
  const ext = input.ext.toLowerCase();
  const vcodec = (input.vcodec || '').toLowerCase();
  const acodec = (input.acodec || '').toLowerCase();
  const issues: string[] = [];
  let level: HealthLevel = 'ok';
  let needsEncode = false;
  let needsRemux = false;

  // No probe result at all (ffprobe could not read it) or no duration: the file
  // is damaged, and a repair pass is the only way to find out if anything is
  // salvageable inside it.
  if (!vcodec) {
    return {
      level: 'broken',
      plan: 'transcode',
      issues: ['No video track could be read — the file is damaged or incomplete.'],
    };
  }
  if (input.duration !== undefined && !(input.duration > 0)) {
    issues.push('No playable duration — the download was cut short.');
    level = 'broken';
    needsEncode = true;
  }

  if (!SAFE_VIDEO.has(vcodec)) {
    if (LIMITED_VIDEO.has(vcodec)) {
      issues.push(`Video is ${vcodec.toUpperCase()} — plays in Chrome and Firefox, not in Safari or on iPhone/iPad.`);
      level = worst(level, 'warn');
    } else {
      issues.push(`Video is ${vcodec.toUpperCase()} — no browser can play it.`);
      level = 'broken';
    }
    needsEncode = true;
  }

  // No audio track is normal for some clips, never a fault.
  if (acodec && !SAFE_AUDIO.has(acodec)) {
    if (LIMITED_AUDIO.has(acodec)) {
      issues.push(`Audio is ${acodec.toUpperCase()} — silent in Safari and on iPhone/iPad.`);
      level = worst(level, 'warn');
    } else {
      issues.push(`Audio is ${acodec.toUpperCase()} — no browser can play it.`);
      level = 'broken';
    }
    needsEncode = true;
  }

  if (!SAFE_CONTAINERS.has(ext)) {
    issues.push(`${ext.replace('.', '').toUpperCase()} is not a container browsers open.`);
    level = 'broken';
    needsRemux = true;
  } else if ((ext === '.mp4' || ext === '.m4v') && input.faststart === false) {
    issues.push('The MP4 index sits at the end of the file, so playback and seeking stall until the whole file downloads.');
    level = worst(level, 'warn');
    needsRemux = true;
  }

  // WebM only accepts VP8/VP9/AV1 + Opus/Vorbis, so a re-encode to H.264/AAC has
  // to land in an MP4 — the re-encode implies the container change.
  const plan: RepairPlan = needsEncode ? 'transcode' : needsRemux ? 'remux' : 'none';
  return { level, plan, issues };
}

/** Undefined until buildMeta has probed the file — absence of a verdict, not a bad one. */
export function healthOf(video: VideoItem): VideoHealth | undefined {
  if (!video.probedAt) return undefined;
  return classifyHealth({
    ext: video.ext,
    vcodec: video.vcodec,
    acodec: video.acodec,
    faststart: video.faststart,
    duration: video.duration,
  });
}

/**
 * The verdict for one video, probing it now if the background pass has not
 * reached it. Used where the answer cannot wait — a player that just failed.
 */
export async function resolveHealth(video: VideoItem): Promise<VideoHealth> {
  const known = healthOf(video);
  if (known) return known;
  let streams: Array<Record<string, unknown>> = [];
  let duration: number | undefined;
  try {
    const probe = await probeVideo(video.absPath) as {
      streams?: Array<Record<string, unknown>>; format?: { duration?: string };
    };
    streams = probe.streams ?? [];
    duration = parseFloat(String(probe.format?.duration ?? '0'));
  } catch {
    return {
      level: 'broken',
      plan: 'transcode',
      issues: ['The file could not be read at all — it is damaged or was never finished.'],
    };
  }
  return classifyHealth({
    ext: video.ext,
    vcodec: String(streams.find(s => s['codec_type'] === 'video')?.['codec_name'] ?? ''),
    acodec: String(streams.find(s => s['codec_type'] === 'audio')?.['codec_name'] ?? ''),
    faststart: probeFastStart(video.absPath),
    duration,
  });
}

// ── MP4 box order ─────────────────────────────────────────────────────────────
// `+faststart` moves the moov index in front of the media data. ffprobe does not
// report where it ended up, so read the top-level box headers: 4-byte big-endian
// size, 4-byte type, with size 1 meaning a 64-bit size follows and size 0 meaning
// "runs to end of file". Only the names are needed, so nothing but the headers is
// read, however large the file.

/** Reads `length` bytes at `offset`, or null past the end. */
export type ByteReader = (offset: number, length: number) => Buffer | null;

export function readTopLevelBoxes(read: ByteReader, fileSize: number, max = 32): string[] {
  const boxes: string[] = [];
  let offset = 0;
  while (offset + 8 <= fileSize && boxes.length < max) {
    const header = read(offset, 16);
    if (!header || header.length < 8) break;
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    // A type outside printable ASCII means we have lost sync with the box tree —
    // reading further would be guesswork.
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;
    boxes.push(type);
    if (size === 0) break;                       // extends to end of file
    if (size === 1) {
      if (header.length < 16) break;
      const large = header.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
    }
    if (size < 8) break;                         // malformed
    offset += size;
  }
  return boxes;
}

/** True when the moov index is reachable before the media data. */
export function boxesAreFastStart(boxes: string[]): boolean {
  const moov = boxes.indexOf('moov');
  const mdat = boxes.indexOf('mdat');
  if (moov === -1) return false;
  return mdat === -1 || moov < mdat;
}

/** Reads the real file. Returns undefined for non-MP4 containers. */
export function probeFastStart(absPath: string): boolean | undefined {
  const ext = path.extname(absPath).toLowerCase();
  if (ext !== '.mp4' && ext !== '.m4v') return undefined;
  let fd: number | undefined;
  try {
    const size = fs.statSync(absPath).size;
    fd = fs.openSync(absPath, 'r');
    const read: ByteReader = (offset, length) => {
      const buf = Buffer.alloc(length);
      const got = fs.readSync(fd as number, buf, 0, length, offset);
      return got > 0 ? buf.subarray(0, got) : null;
    };
    return boxesAreFastStart(readTopLevelBoxes(read, size));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}
