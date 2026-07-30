import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { ChildProcess } from 'child_process';
import {
  ytNetArgs, ytSpeedArgs, ytFilterArgs, ytFormatArgs, isFilteredOut,
  spawnDownload, fetchMeta, netHint,
} from '../ytdlp';
import { fetchCookiesViaBrowser } from '../browserCookies';
import { classifyProbe, probeVideo, type ProbeVerdict } from '../media';
import { VIDEO_EXTENSIONS } from '../../config';
import type { DownloadEngine, EngineHandle, EngineHooks, EngineResult, QueueItem } from './types';

// All files yt-dlp may have written for this item: the final muxed file, any
// per-format leftovers (`base.f137.mp4`), and temp/part files (`base.mp4.part`).
function outputsFor(destAbs: string, base: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(destAbs); } catch { return []; }
  return names
    .filter(n => n === base || n.startsWith(base + '.'))
    .map(n => path.join(destAbs, n));
}

// The single finished video file for this item: `<base>.<videoExt>` exactly
// (excludes per-format `base.f137.mp4` leftovers from a merge that never ran).
function finalOutput(destAbs: string, base: string): string | null {
  let best: string | null = null;
  let bestSize = -1;
  for (const abs of outputsFor(destAbs, base)) {
    const name = path.basename(abs);
    const ext = path.extname(name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext) || path.basename(name, ext) !== base) continue;
    let size = 0;
    try { size = fs.statSync(abs).size; } catch { continue; }
    if (size > bestSize) { bestSize = size; best = abs; }
  }
  return best;
}

// Confirm the finished file is actually a playable video (see classifyProbe).
async function verifyOutput(destAbs: string, base: string): Promise<ProbeVerdict> {
  const file = finalOutput(destAbs, base);
  if (!file) return { ok: false, reason: 'no output file (merge/remux failed)' };
  if (fs.statSync(file).size === 0) return { ok: false, reason: 'empty file' };
  try { return classifyProbe(await probeVideo(file)); }
  catch { return { ok: false, reason: 'file unreadable by ffprobe' }; }
}

// Roll the download archive back to its pre-run contents so a retry re-downloads
// cleanly (yt-dlp records an entry even for a run we're about to reject).
function restoreArchive(archivePath: string, before: string | null): void {
  try {
    if (before === null) fs.rmSync(archivePath, { force: true });
    else fs.writeFileSync(archivePath, before);
  } catch { /* best-effort */ }
}

function cleanupOutputs(destAbs: string, base: string): void {
  for (const abs of outputsFor(destAbs, base)) {
    try { fs.rmSync(abs, { force: true }); } catch { /* already gone */ }
  }
}

// Production download engine: drives yt-dlp for a single item. Knows nothing
// about the queue — it just runs, reports progress via hooks, and settles once.
export class YtDlpEngine implements DownloadEngine {
  run(item: QueueItem, hooks: EngineHooks): EngineHandle {
    let stopKind: 'cancel' | 'pause' | null = null;
    let proc: ChildProcess | null = null;

    const runOnce = (): Promise<EngineResult> => new Promise(resolve => {
      fs.mkdirSync(item.destAbs, { recursive: true });
      const archivePath = path.join(item.destAbs, '.downloaded.txt');
      // Snapshot the archive so a rejected run (broken output) can be rolled back
      // exactly, without disturbing entries from other videos in this folder.
      const archiveBefore = fs.existsSync(archivePath) ? fs.readFileSync(archivePath, 'utf8') : null;
      // Files are saved under a random (or explicit) base name; the real title is
      // still fetched for the UI but never written into the filename.
      const base = item.filename || crypto.randomBytes(8).toString('hex');
      const outTpl = path.join(item.destAbs, base + '.%(ext)s');

      const args = [
        '--newline', '--no-mtime', '--no-warnings', '--continue',
        '--download-archive', archivePath,
        ...ytNetArgs(),
        ...ytSpeedArgs(),
        ...ytFilterArgs(item.url),         // skip < 10 min (YouTube exempt: any length)
        '--no-playlist',
        ...ytFormatArgs(),                 // browser-safe codecs + mp4 + faststart
        '-o', outTpl,
        item.url,
      ];

      let filtered = false;
      let lastError: string | undefined;

      const child = spawnDownload(args);
      proc = child;
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (!line.trim()) continue;
          if (isFilteredOut(line)) filtered = true;
          if (line.includes('[Merger]') || line.includes('[ffmpeg]')) { hooks.onProcessing(); continue; }
          const pct = line.match(/(\d+\.?\d*)%/);
          const spd = line.match(/at\s+([\d.]+\w+\/s)/);
          const eta = line.match(/ETA\s+(\S+)/);
          if (pct || spd || eta) {
            hooks.onProgress({
              progress: pct ? parseFloat(pct[1]) : undefined,
              speed: spd ? spd[1] : undefined,
              eta: eta ? eta[1] : undefined,
            });
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (isFilteredOut(text)) filtered = true;
        if (/ERROR|error/.test(text)) lastError = netHint(text.trim().split('\n')[0]);
      });
      child.on('error', err => resolve({ status: 'failed', error: err.message }));
      child.on('close', async code => {
        if (stopKind === 'pause') return resolve({ status: 'paused' });
        if (stopKind === 'cancel') return resolve({ status: 'cancelled' });
        if (filtered) return resolve({ status: 'failed', error: 'Skipped — shorter than 10 minutes' });
        if (code !== 0) return resolve({ status: 'failed', error: lastError || `yt-dlp exited with code ${code}` });
        // Exit 0 isn't proof the file plays. Verify it; a broken/incomplete file
        // is deleted and the archive rolled back so it never lands in the library
        // as an unplayable "completed" item and a retry starts clean.
        hooks.onProcessing();
        const verdict = await verifyOutput(item.destAbs, base);
        if (!verdict.ok) {
          restoreArchive(archivePath, archiveBefore);
          cleanupOutputs(item.destAbs, base);
          return resolve({ status: 'failed', error: `Broken download: ${verdict.reason}. It will re-download on retry.` });
        }
        resolve({ status: 'completed' });
      });
    });

    const done: Promise<EngineResult> = (async () => {
      // Preparing: pull metadata for the title/thumbnail shown while queued.
      try {
        const meta = await fetchMeta(item.url);
        hooks.onPrepared({ title: meta.title || item.url, uploader: meta.uploader, thumbUrl: meta.thumbUrl });
      } catch { /* non-fatal — the download can still proceed */ }
      if (stopKind) return { status: stopKind === 'pause' ? 'paused' : 'cancelled' };

      let result = await runOnce();
      // One age-gate retry: fetch cookies via headless browser, then re-run.
      if (result.status === 'failed' && !stopKind && /410|403|age.?gate/i.test(result.error || '')) {
        try { await fetchCookiesViaBrowser(item.url); result = await runOnce(); } catch { /* keep original result */ }
      }
      return result;
    })();

    return {
      stop(kind) { stopKind = kind; try { proc?.kill('SIGTERM'); } catch { /* already gone */ } },
      done,
    };
  }
}
