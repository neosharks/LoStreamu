import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { ChildProcess } from 'child_process';
import {
  ytNetArgs, ytSpeedArgs, ytFilterArgs, isFilteredOut,
  spawnDownload, fetchMeta, netHint,
} from '../ytdlp';
import { fetchCookiesViaBrowser } from '../browserCookies';
import type { DownloadEngine, EngineHandle, EngineHooks, EngineResult, QueueItem } from './types';

// Production download engine: drives yt-dlp for a single item. Knows nothing
// about the queue — it just runs, reports progress via hooks, and settles once.
export class YtDlpEngine implements DownloadEngine {
  run(item: QueueItem, hooks: EngineHooks): EngineHandle {
    let stopKind: 'cancel' | 'pause' | null = null;
    let proc: ChildProcess | null = null;

    const runOnce = (): Promise<EngineResult> => new Promise(resolve => {
      fs.mkdirSync(item.destAbs, { recursive: true });
      const archivePath = path.join(item.destAbs, '.downloaded.txt');
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
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
        // Move the MP4 index (moov) to the front so the file streams/plays
        // immediately instead of needing a full download first.
        '--postprocessor-args', 'ffmpeg:-movflags +faststart',
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
      child.on('close', code => {
        if (stopKind === 'pause') return resolve({ status: 'paused' });
        if (stopKind === 'cancel') return resolve({ status: 'cancelled' });
        if (filtered) return resolve({ status: 'failed', error: 'Skipped — shorter than 10 minutes' });
        if (code === 0) return resolve({ status: 'completed' });
        resolve({ status: 'failed', error: lastError || `yt-dlp exited with code ${code}` });
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
