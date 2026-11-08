import { execFile, spawn, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { getProxy, getMinDurationSec, COOKIES_PATH, YT_DLP_LOCAL, DENO_LOCAL } from '../config';
import { fetchCookiesViaBrowser } from './browserCookies';
import { prepareCookiesFile } from './cookieJar';
import type { PlaylistEntry, YtDlpVersionInfo } from '../types';

const execFileP = promisify(execFile);

export function ytDlpBin(): string {
  return fs.existsSync(YT_DLP_LOCAL) ? YT_DLP_LOCAL : 'yt-dlp';
}

export function normalizeUrl(url: string): string {
  return url;
}


// First yt-dlp release with --js-runtimes (YouTube's EJS challenge solver).
const JS_RUNTIMES_SINCE = '2025.11.12';
// Oldest Node yt-dlp accepts as a JS runtime.
const MIN_NODE_FOR_YTDLP = 22;

// True if `--list-impersonate-targets` output has a usable Chrome target.
// yt-dlp still lists targets whose backend is missing, suffixed "(unavailable)".
export function hasChromeImpersonation(listing: string): boolean {
  return listing.split('\n').some(l => /^chrome\b/i.test(l.trim()) && !/unavailable/i.test(l));
}

// True if this yt-dlp version understands --js-runtimes. Versions are dated
// (YYYY.MM.DD[.build]), so string order is chronological.
export function supportsJsRuntimes(version: string): boolean {
  const m = version.match(/\d{4}\.\d{2}\.\d{2}/);
  return !!m && m[0] >= JS_RUNTIMES_SINCE;
}

interface YtDlpCaps { bin: string; impersonate: boolean; jsRuntimes: boolean }
let _caps: YtDlpCaps | null = null;

// What the installed yt-dlp can use on this host. Passing a flag it can't honour
// is fatal: `--impersonate chrome` without a compatible curl-cffi aborts every
// run, and an unknown option fails argument parsing. Probed once per binary.
function ytDlpCaps(): YtDlpCaps {
  const bin = ytDlpBin();
  if (_caps?.bin === bin) return _caps;
  const r = spawnSync(bin, ['-v', '--list-impersonate-targets'], { encoding: 'utf8', timeout: 30000 });
  const version = (r.stderr || '').match(/yt-dlp version \S*?(\d{4}\.\d{2}\.\d{2}\S*)/)?.[1] || '';
  _caps = {
    bin,
    impersonate: hasChromeImpersonation(r.stdout || ''),
    jsRuntimes: supportsJsRuntimes(version),
  };
  if (!_caps.impersonate) {
    console.warn('[ytdlp] Chrome impersonation unavailable (curl-cffi missing or unsupported) — downloading without it');
  }
  return _caps;
}

// True if yt-dlp failed in curl-cffi's TLS handshake ("Failed to perform,
// curl: (35) ..."). Some sites and middleboxes reject the impersonated Chrome
// handshake that plain TLS gets through, so these runs are retried without it.
export function isImpersonationTlsError(msg: string | undefined): boolean {
  return /curl: \(35\)/i.test(msg || '');
}

export function ytNetArgs(impersonate = true): string[] {
  const caps = ytDlpCaps();
  const args: string[] = [];
  if (prepareCookiesFile(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
  const proxy = getProxy();
  if (proxy) args.push('--proxy', proxy);
  // Impersonate Chrome at the TLS + HTTP level — fixes connection-reset-by-peer
  // on sites that fingerprint the TLS handshake (requires curl-cffi on server).
  if (impersonate && caps.impersonate) args.push('--impersonate', 'chrome');
  // YouTube needs a JS runtime to solve its player challenges; without one,
  // formats go missing or extraction fails. yt-dlp only finds deno on PATH by
  // default, so also offer the updater's own deno and, when new enough, the
  // Node running this app.
  if (caps.jsRuntimes) {
    if (fs.existsSync(DENO_LOCAL)) args.push('--js-runtimes', `deno:${DENO_LOCAL}`);
    if (Number(process.versions.node.split('.')[0]) >= MIN_NODE_FOR_YTDLP) {
      args.push('--js-runtimes', `node:${process.execPath}`);
    }
  }
  args.push(
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--force-ipv4',
    '--geo-bypass',
    '--retries', '10',
    '--fragment-retries', '10',
    '--socket-timeout', '30',
    '--extractor-retries', '5',
    '--no-check-certificates',
  );
  return args;
}

// Speed flags for actual media downloads (NOT metadata probes).
// - concurrent-fragments: parallelise DASH/HLS chunk fetches (the #1 throughput win)
// - http-chunk-size: chunked HTTP sidesteps YouTube's single-connection throttling
// - sleep-requests: pace extraction requests to stay under rate limits. Never on
//   probes: a playlist listing pages through 100 entries per request, so a 2s
//   sleep per page pushed big playlists and channels past the probe timeout.
// All network-bound — negligible CPU, so they don't undo the CPU work above.
export function ytSpeedArgs(): string[] {
  return ['--concurrent-fragments', '4', '--http-chunk-size', '10M', '--sleep-requests', '2'];
}

// Format selection + container flags shared by every media download.
//
// Why this shape: a self-hosted library is watched from every browser (incl.
// Safari / iOS), so the file on disk must be broadly playable WITHOUT re-encoding
// (this app runs on tiny low-CPU boxes). We therefore:
//   • prefer an MP4 (H.264 video + AAC audio) stream when the site offers one —
//     the one combo every browser plays — via the `-f` preference ladder AND the
//     `-S` format sort (vcodec:h264 / acodec:aac). VP9/AV1/Opus are the fallback,
//     not the default, so we don't hand Safari a file it can't decode;
//   • always land in an MP4 container (`--merge-output-format` + `--remux-video`);
//   • move the moov atom to the front (`+faststart`) so the file streams and seeks
//     from byte 0 instead of the player hunting for the index — the usual cause of
//     "it starts in the wrong place / jumps around" on progressive playback.
export function ytFormatArgs(): string[] {
  return [
    '-f',
    // avc1+m4a mp4 → any mp4 video+m4a → any progressive mp4 → best video+audio → best
    'bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    '-S', 'vcodec:h264,acodec:aac,ext:mp4',
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    // Move the MP4 index (moov) to the front so the file streams/plays immediately
    // instead of needing a full download first.
    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
  ];
}

// True for YouTube URLs (any subdomain, plus youtu.be short links and the
// privacy-enhanced youtube-nocookie.com host). Malformed URLs → false.
export function isYouTubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(^|\.)youtube\.com$/.test(host)
      || /(^|\.)youtube-nocookie\.com$/.test(host)
      || host === 'youtu.be';
  } catch {
    return false;
  }
}

// yt-dlp filter that rejects videos shorter than the configured minimum
// (Downloads page setting) — EXCEPT for YouTube, where a video of any length is
// allowed. yt-dlp reads the duration from metadata first, so a rejected video
// prints "does not pass filter" and exits 0 without downloading any media.
export function ytFilterArgs(url: string, minSec: number = getMinDurationSec()): string[] {
  if (isYouTubeUrl(url) || minSec <= 0) return [];
  return ['--match-filter', `duration >= ${minSec}`];
}

// True if a yt-dlp output line indicates the video was skipped by the filter.
export function isFilteredOut(line: string): boolean {
  return /does not pass filter/i.test(line);
}

// The error shown for a video the duration filter skipped.
export function filteredOutMessage(minSec: number = getMinDurationSec()): string {
  const min = Math.round((minSec / 60) * 10) / 10;
  return `Skipped — shorter than ${min} minute${min === 1 ? '' : 's'}`;
}

// True if yt-dlp skipped the video because this folder's download archive
// already lists it (it exits 0 and writes no file).
export function isAlreadyArchived(line: string): boolean {
  return /has already been recorded in the archive/i.test(line);
}

function decodeHtml(s: string): string {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export function netHint(msg: string): string {
  if (/impersonate target.*not available|missing dependencies required to support/i.test(msg))
    return msg + ' — yt-dlp is missing the curl-cffi dependency. Fix: pip3 install --break-system-packages curl-cffi';
  if (isImpersonationTlsError(msg))
    return msg + ' — TLS handshake failed, with and without browser impersonation. Update yt-dlp via the navbar button, or set a proxy in Account → Network settings.';
  if (/HTTP Error 410|410.*Gone/i.test(msg))
    return msg + ' — Site rejected the request (410). Try updating yt-dlp via the navbar button.';
  if (/sign.?in|log.?in required|logged.?in|account credentials|age.?verif|members.?only|premium|private|video.*not available|not available.*country|account required/i.test(msg))
    return msg + ` — Authentication required. Export this site's cookies from a logged-in browser to ${COOKIES_PATH} (Netscape or JSON) and retry.`;
  if (/reset by peer|errno 104|connection refused|timed out|network is unreachable|getaddrinfo|failed to resolve/i.test(msg))
    return msg + (getProxy()
      ? ' — Even via the configured proxy. Check the proxy can reach this site.'
      : ' — Site looks blocked on the server network. Set a proxy in Account → Network settings.');
  return msg;
}

// Returns true if the error looks like an age-gate / bot-detection rejection.
function isAgeGateError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Exclude yt-dlp dependency/feature errors — these are not age gates.
  if (/impersonate target|missing dependencies required to support/i.test(msg)) return false;
  return /410|403 forbidden|age.?gate|age.?verif|video.*not available|not available.*country|confirm your age/i.test(msg);
}

// The useful part of a failed yt-dlp run. execFile's own message starts with
// "Command failed: <the whole command line>", which buries yt-dlp's ERROR line.
export function ytErrorMessage(err: unknown): string {
  const e = err as { stderr?: string; message?: string; killed?: boolean } | undefined;
  const lines = `${e?.stderr || ''}\n${e?.message || ''}`.split('\n').map(l => l.trim());
  const errLine = lines.filter(l => l.startsWith('ERROR:')).pop();
  if (errLine) return errLine;
  if (e?.killed) return 'yt-dlp timed out';
  return lines.find(l => l && !l.startsWith('Command failed:')) || e?.message || String(err);
}

// Run fn; on a TLS handshake error retry once without impersonation, and on an
// age-gate error fetch cookies via browser and retry once.
async function withAgeGateRetry<T>(url: string, fn: (impersonate: boolean) => Promise<T>): Promise<T> {
  let impersonate = true;
  let readable: Error;
  try {
    return await fn(impersonate);
  } catch (err) {
    readable = new Error(ytErrorMessage(err));
  }
  if (isImpersonationTlsError(readable.message)) {
    console.log(`[ytdlp] TLS handshake failed for ${url} — retrying without impersonation…`);
    impersonate = false;
    try { return await fn(impersonate); } catch (err) { readable = new Error(ytErrorMessage(err)); }
  }
  if (!isAgeGateError(readable)) throw readable;
  console.log(`[ytdlp] age-gate detected for ${url} — launching browser to accept…`);
  await fetchCookiesViaBrowser(url);
  try { return await fn(impersonate); } catch (retryErr) { throw new Error(ytErrorMessage(retryErr)); }
}

// Entries are handed over in batches of this many, or after FLUSH_MS, whichever
// comes first — the UI fills in steadily without one event per entry.
const PLAYLIST_BATCH = 50;
const PLAYLIST_FLUSH_MS = 500;
// yt-dlp prints a page of entries every second or two. This long with no output
// at all means it is stuck, not slow — there is deliberately no overall limit.
const PLAYLIST_IDLE_MS = 120000;

// One entry from a `--flat-playlist -j` line, or null for anything that is not
// a playlist entry (a single video's own info, non-JSON output).
export function parsePlaylistLine(line: string): { entry: PlaylistEntry; playlistTitle: string } | null {
  let e: any;
  try { e = JSON.parse(line); } catch { return null; }
  if (!e || typeof e.playlist_index !== 'number') return null;
  return {
    entry: {
      index: e.playlist_index,
      title: decodeHtml(e.title) || `Item ${e.playlist_index}`,
      url: e.url || e.webpage_url,
      duration: e.duration,
      thumbnail: e.thumbnail || e.thumbnails?.[0]?.url,
    },
    playlistTitle: decodeHtml(e.playlist_title || e.playlist || ''),
  };
}

export interface PlaylistStreamHooks {
  onTitle(title: string): void;
  onEntries(entries: PlaylistEntry[]): void;
}

// Lists a playlist while yt-dlp pages through it (--lazy-playlist) instead of
// waiting for the whole list. A huge playlist is usable after its first page,
// and a failure late in the list keeps everything read before it. `done`
// resolves with the number of entries found.
export function streamPlaylistEntries(url: string, hooks: PlaylistStreamHooks): { done: Promise<number>; stop(): void } {
  let proc: ChildProcess | null = null;
  let stopped = false;
  let count = 0;

  const runOnce = (impersonate: boolean) => new Promise<void>((resolve, reject) => {
    const child = spawn(ytDlpBin(), [
      '--flat-playlist', '--lazy-playlist', '-j', '--no-warnings', ...ytNetArgs(impersonate), normalizeUrl(url),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc = child;

    let titled = false;
    let partial = '';
    let stderr = '';
    let batch: PlaylistEntry[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let timedOut = false;

    const flush = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (batch.length) { hooks.onEntries(batch); batch = []; }
    };
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, PLAYLIST_IDLE_MS);
    };
    const take = (line: string) => {
      const parsed = parsePlaylistLine(line);
      if (!parsed) return;
      if (!titled) { titled = true; hooks.onTitle(parsed.playlistTitle || 'Playlist'); }
      batch.push(parsed.entry);
      count++;
    };

    touch();
    child.stdout.on('data', (chunk: Buffer) => {
      touch();
      const lines = (partial + chunk.toString()).split('\n');
      partial = lines.pop() ?? '';
      lines.forEach(take);
      if (batch.length >= PLAYLIST_BATCH) flush();
      else if (batch.length && !flushTimer) flushTimer = setTimeout(flush, PLAYLIST_FLUSH_MS);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      touch();
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    child.on('error', err => {
      if (idleTimer) clearTimeout(idleTimer);
      flush();
      reject(err);
    });
    child.on('close', code => {
      if (idleTimer) clearTimeout(idleTimer);
      if (partial) take(partial);
      flush();
      if (stopped || code === 0) return resolve();
      reject(new Error(timedOut
        ? 'yt-dlp stopped responding while reading the playlist'
        : ytErrorMessage({ stderr, message: `yt-dlp exited with code ${code}` })));
    });
  });

  const done = (async () => {
    let impersonate = true;
    try {
      await runOnce(impersonate);
    } catch (err) {
      // Retrying after entries went out would list them twice.
      if (stopped || count > 0) throw err;
      if (isImpersonationTlsError((err as Error).message)) {
        console.log(`[ytdlp] TLS handshake failed for ${url} — retrying without impersonation…`);
        impersonate = false;
        try { await runOnce(impersonate); return count; } catch (retryErr) { err = retryErr; }
        if (stopped || count > 0) throw err;
      }
      if (!isAgeGateError(err)) throw err;
      console.log(`[ytdlp] age-gate detected for ${url} — launching browser to accept…`);
      await fetchCookiesViaBrowser(url);
      if (!stopped) await runOnce(impersonate);
    }
    return count;
  })();

  return {
    done,
    stop() { stopped = true; try { proc?.kill('SIGTERM'); } catch { /* already gone */ } },
  };
}

// Only the thumbnail is kept: the source title never leaves yt-dlp, so the
// original name appears nowhere — not in the queue, the UI or the saved queue file.
export async function fetchThumbnail(url: string): Promise<string | undefined> {
  const run = (impersonate: boolean) => execFileP(ytDlpBin(), [
    '-J', '--no-playlist', '--no-warnings', ...ytNetArgs(impersonate), normalizeUrl(url),
  ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });

  const { stdout } = await withAgeGateRetry(url, run);

  const j = JSON.parse(stdout);
  return j.thumbnail || j.thumbnails?.[0]?.url;
}

let _latestCache: { tag: string | null; at: number } = { tag: null, at: 0 };
const CACHE_TTL = 6 * 60 * 60 * 1000;

export async function getYtDlpVersion(): Promise<YtDlpVersionInfo> {
  let current: string | null = null;
  try {
    const { stdout } = await execFileP(ytDlpBin(), ['--version'], { timeout: 8000 });
    current = stdout.trim();
  } catch {}

  const now = Date.now();
  if (!_latestCache.tag || now - _latestCache.at > CACHE_TTL) {
    try {
      const res = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
        headers: { 'User-Agent': 'streamvault/2.0' },
      });
      const data = await res.json() as { tag_name?: string };
      _latestCache = { tag: data.tag_name || null, at: now };
    } catch {}
  }

  const latest = _latestCache.tag;
  return { current, latest, outdated: !!(current && latest && current !== latest) };
}

export async function updateYtDlp(): Promise<void> {
  const tmp = YT_DLP_LOCAL + '.tmp';
  try {
    await execFileP('curl', [
      '-fsSL',
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
      '-o', tmp,
    ], { timeout: 120000 });
    fs.renameSync(tmp, YT_DLP_LOCAL);
    fs.chmodSync(YT_DLP_LOCAL, 0o755);
    try { fs.copyFileSync(YT_DLP_LOCAL, '/usr/local/bin/yt-dlp'); } catch {}
    _latestCache = { tag: null, at: 0 };
    _caps = null;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

export function spawnDownload(args: string[]) {
  const bin = ytDlpBin();
  // On Linux run the download at the lowest CPU priority so video streaming and
  // the web app always win under contention (playback is the priority). yt-dlp's
  // ffmpeg merge inherits the niceness. `nice` execs in place, so the returned
  // process is still yt-dlp and SIGTERM/kill work as before.
  if (process.platform === 'linux') {
    return spawn('nice', ['-n', '19', bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
