import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { createLimiter } from './exec';
import { classifyProbe, probeVideo, thumbPath, spritePath, vttPath, invalidateThumb } from './media';
import { classifyHealth, healthOf, probeFastStart } from './health';
import {
  getLibrary, findById, rescan, buildMeta, purgeMetaEntry, makeVideoId, getMediaRoot,
} from './library';
import { rekeyFavorite } from './favorites';
import { rekeyFaces } from './faces/store';
import type { RepairJob, RepairPlan, VideoItem } from '../types';

// ── Repair ────────────────────────────────────────────────────────────────────
// Turns a video the browser refuses into one it plays, and never destroys the
// original until the replacement has been probed and found good.
//
// Two depths, picked by services/health.ts:
//   • remux    — copy the existing streams into an MP4 with the index up front.
//                Seconds, lossless, no re-encode. Fixes MKV/AVI/TS containers and
//                MP4s whose moov atom sits at the end.
//   • transcode— re-encode to H.264 + AAC. Slow (CPU-bound), but it is the only
//                thing that fixes HEVC/AV1/Opus/AC-3 and salvages truncated files.
// Streams that are already browser-safe are copied even inside a transcode, so a
// file that only has bad audio never pays for a video re-encode.
//
// One repair at a time: a transcode saturates the box, and playback for whoever
// is watching has to keep winning.

const SAFE_VIDEO = new Set(['h264', 'avc1']);
const SAFE_AUDIO = new Set(['aac', 'mp4a']);

const repairLimiter = createLimiter(1);
const jobs = new Map<string, RepairJob>();
const procs = new Map<string, ChildProcess>();
/** Jobs that settled are kept this long so the UI can show the outcome. */
const KEEP_FINISHED_MS = 10 * 60 * 1000;

function ffmpegArgs(video: VideoItem, plan: RepairPlan, out: string): string[] {
  const vcodec = (video.vcodec || '').toLowerCase();
  const acodec = (video.acodec || '').toLowerCase();
  const args = [
    '-nostdin', '-y',
    '-progress', 'pipe:1', '-nostats', '-loglevel', 'error',
  ];
  // A truncated or mis-timestamped file needs ffmpeg to rebuild presentation
  // timestamps, or the output plays at the wrong speed (or not at all).
  if (plan === 'transcode') args.push('-fflags', '+genpts');
  args.push('-i', video.absPath);
  // Subtitle and data streams are what make an MKV→MP4 copy fail, and nothing in
  // the player uses them. Take the first video and (if there is one) audio track.
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

  if (plan === 'transcode') {
    if (SAFE_VIDEO.has(vcodec)) {
      args.push('-c:v', 'copy');
    } else {
      // veryfast at CRF 23 is the sweet spot on a 4-vCPU homelab box: visually
      // indistinguishable, and fast enough that a long video finishes the same
      // evening. High@4.1 is the profile every phone and TV browser decodes.
      args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
      );
    }
    args.push(...(SAFE_AUDIO.has(acodec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2']));
  } else {
    args.push('-c', 'copy');
  }

  args.push('-movflags', '+faststart', '-f', 'mp4', out);
  return args;
}

/** Where the repaired file should land: same folder and name, always `.mp4`. */
function targetPath(video: VideoItem): string {
  const dir = path.dirname(video.absPath);
  let candidate = path.join(dir, `${video.name}.mp4`);
  let n = 1;
  // Only a DIFFERENT file in the way is a clash — replacing the video's own .mp4
  // in place is the normal case for a faststart fix.
  while (candidate !== video.absPath && fs.existsSync(candidate)) {
    candidate = path.join(dir, `${video.name} (fixed${n > 1 ? ' ' + n : ''}).mp4`);
    n++;
  }
  return candidate;
}

function runFfmpeg(job: RepairJob, video: VideoItem, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ffmpegArgs(video, job.plan, out);
    // Keep the encode at low priority on Linux so streaming wins under load —
    // the same bargain runMedia makes for thumbnails and previews.
    const child = process.platform === 'linux'
      ? spawn('nice', ['-n', '19', 'ffmpeg', ...args])
      : spawn('ffmpeg', args);
    procs.set(job.id, child);

    const totalUs = (video.duration || 0) * 1_000_000;
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && totalUs > 0) {
          job.progress = Math.min(99, Math.round((Number(m[1]) / totalUs) * 100));
        }
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', err => { procs.delete(job.id); reject(err); });
    child.on('close', code => {
      procs.delete(job.id);
      if (job.status === 'cancelled') { reject(new Error('Cancelled')); return; }
      if (code === 0) { resolve(); return; }
      reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
    });
  });
}

/** Confirm the rebuilt file is genuinely playable before anything is replaced. */
async function verifyRepaired(out: string): Promise<string | null> {
  let probe: unknown;
  try { probe = await probeVideo(out); }
  catch { return 'the rebuilt file could not be read back'; }
  const verdict = classifyProbe(probe);
  if (!verdict.ok) return verdict.reason ?? 'the rebuilt file is not a usable video';

  const j = probe as { streams?: Array<Record<string, unknown>> };
  const streams = j.streams ?? [];
  const health = classifyHealth({
    ext: '.mp4',
    vcodec: String(streams.find(s => s['codec_type'] === 'video')?.['codec_name'] ?? ''),
    acodec: String(streams.find(s => s['codec_type'] === 'audio')?.['codec_name'] ?? ''),
    faststart: probeFastStart(out),
  });
  return health.level === 'broken' ? health.issues[0] ?? 'the rebuilt file still will not play' : null;
}

async function runJob(job: RepairJob, video: VideoItem): Promise<void> {
  const original = video.absPath;
  const originalRel = video.relPath;
  const stat = fs.statSync(original);
  // Written with a .tmp extension so a crash mid-repair leaves something the
  // library scan ignores and Settings → Clean junk files sweeps away.
  const tmp = path.join(path.dirname(original), `.sv-repair-${job.id}.tmp`);

  try {
    await runFfmpeg(job, video, tmp);
    const problem = await verifyRepaired(tmp);
    if (problem) throw new Error(`Rebuilt the file, but ${problem}. Original left untouched.`);

    const target = targetPath(video);
    fs.renameSync(tmp, target);
    if (path.resolve(original) !== path.resolve(target)) {
      try { fs.rmSync(original, { force: true }); } catch { /* the new file is already in place */ }
    }
    // Keep the original timestamps so a repaired video does not jump to the top
    // of a "newest first" library for having been fixed.
    try { fs.utimesSync(target, stat.atime, stat.mtime); } catch { /* cosmetic */ }

    // The id is a hash of the path, so changing the extension mints a new one.
    // Carry the stars and the face index across, and drop the stale thumbnail.
    const newRel = path.relative(getMediaRoot(), target).split(path.sep).join('/');
    const newId = makeVideoId(newRel);
    if (newId !== video.id) {
      rekeyFavorite(originalRel, newRel);
      rekeyFaces(originalRel, newRel);
      purgeMetaEntry(video.id);
    } else {
      // Same path: the cached duration/codecs describe the old file.
      purgeMetaEntry(video.id);
    }
    for (const p of [thumbPath(video.id), spritePath(video.id), vttPath(video.id)]) {
      try { fs.rmSync(p, { force: true }); } catch { /* already gone */ }
    }
    invalidateThumb(video.id);
    rescan();
    // The rebuilt file has no cached codecs, so re-probe before the job reports
    // done — otherwise the library shows it as "not looked at yet" and the grid
    // loses its duration badge until the next restart.
    await buildMeta();

    job.newVideoId = newId;
    job.progress = 100;
    job.status = 'done';
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* already gone */ }
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.error = (err as Error).message;
    }
  }
}

function sweepFinished(): void {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (const [id, job] of jobs) {
    if (job.status !== 'queued' && job.status !== 'running' && job.startedAt < cutoff) jobs.delete(id);
  }
}

/**
 * Queue a repair. Returns the existing job when one is already pending for this
 * video, so double-clicking Fix never starts two encodes of the same file.
 */
export function enqueueRepair(video: VideoItem, plan?: RepairPlan): RepairJob {
  sweepFinished();
  for (const job of jobs.values()) {
    if (job.videoId === video.id && (job.status === 'queued' || job.status === 'running')) return job;
  }
  const chosen = plan ?? healthOf(video)?.plan ?? 'remux';
  const job: RepairJob = {
    id: crypto.randomBytes(6).toString('hex'),
    videoId: video.id,
    name: video.name,
    // A file with nothing wrong is still worth remuxing on an explicit request —
    // it is what "fix it anyway" means when a video misbehaves for some other reason.
    plan: chosen === 'none' || chosen === 'unfixable' ? 'remux' : chosen,
    status: 'queued',
    progress: 0,
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  repairLimiter.run(async () => {
    if (job.status === 'cancelled') return;
    job.status = 'running';
    // Re-resolve: a repair that ran before this one may have renamed the file.
    const current = findById(job.videoId) ?? video;
    await runJob(job, current);
  }).catch(() => {
    job.status = 'error';
    job.error = job.error || 'Repair failed to start';
  });
  return job;
}

/** Queue every video in `folder` that is not already playable. */
export function enqueueFolderRepair(folder: string, deep = true): RepairJob[] {
  const prefix = folder ? folder + '/' : '';
  return getLibrary()
    .filter(v => v.folder === folder || (deep && v.folder.startsWith(prefix)))
    .filter(v => {
      const plan = healthOf(v)?.plan;
      return plan === 'remux' || plan === 'transcode';
    })
    .map(v => enqueueRepair(v));
}

export function listRepairJobs(): RepairJob[] {
  sweepFinished();
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function cancelRepair(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return false;
  job.status = 'cancelled';
  try { procs.get(jobId)?.kill('SIGTERM'); } catch { /* already gone */ }
  return true;
}
