import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { getProxy, COOKIES_PATH, YT_DLP_LOCAL } from '../config';
import { fetchCookiesViaBrowser } from './browserCookies';
import type { PlaylistProbeResult, PlaylistEntry, YtDlpVersionInfo } from '../types';

const execFileP = promisify(execFile);

export function ytDlpBin(): string {
  return fs.existsSync(YT_DLP_LOCAL) ? YT_DLP_LOCAL : 'yt-dlp';
}

export function normalizeUrl(url: string): string {
  return url;
}


export function ytNetArgs(): string[] {
  const args: string[] = [];
  if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
  const proxy = getProxy();
  if (proxy) args.push('--proxy', proxy);
  args.push(
    // Impersonate Chrome at the TLS + HTTP level — fixes connection-reset-by-peer
    // on sites that fingerprint the TLS handshake (requires curl-cffi on server).
    '--impersonate', 'chrome',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--force-ipv4',
    '--geo-bypass',
    '--retries', '10',
    '--fragment-retries', '10',
    '--socket-timeout', '30',
    '--extractor-retries', '5',
    '--sleep-requests', '2',
    '--no-check-certificates',
  );
  return args;
}

// Speed flags for actual media downloads (NOT metadata probes).
// - concurrent-fragments: parallelise DASH/HLS chunk fetches (the #1 throughput win)
// - http-chunk-size: chunked HTTP sidesteps YouTube's single-connection throttling
// Both are network-bound — negligible CPU, so they don't undo the CPU work above.
export function ytSpeedArgs(): string[] {
  return ['--concurrent-fragments', '4', '--http-chunk-size', '10M'];
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
  if (/HTTP Error 410|410.*Gone/i.test(msg))
    return msg + ' — Site rejected the request (410). Try updating yt-dlp via the navbar button.';
  if (/sign.?in|log.?in required|age.?verif|members.?only|premium|private|video.*not available|not available.*country|account required/i.test(msg))
    return msg + ' — Authentication required. Drop a cookies.txt (Netscape format) next to server.js and retry.';
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

// Run fn; on age-gate error fetch cookies via browser and retry once.
async function withAgeGateRetry<T>(url: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isAgeGateError(err)) throw err;
    console.log(`[ytdlp] age-gate detected for ${url} — launching browser to accept…`);
    await fetchCookiesViaBrowser(url);
    return await fn();
  }
}

export async function fetchPlaylistEntries(url: string): Promise<PlaylistProbeResult> {
  const run = () => execFileP(ytDlpBin(), [
    '-J', '--flat-playlist', '--no-warnings', ...ytNetArgs(), normalizeUrl(url),
  ], { timeout: 60000, maxBuffer: 50 * 1024 * 1024 });

  const { stdout } = await withAgeGateRetry(url, run);

  const j = JSON.parse(stdout);
  const rawEntries: any[] = j.entries || [];
  const entries: PlaylistEntry[] = rawEntries.map((e: any, i: number) => ({
    index: i + 1,
    title: decodeHtml(e.title) || `Item ${i + 1}`,
    url: e.url || e.webpage_url,
    duration: e.duration,
    thumbnail: e.thumbnail || (e.thumbnails?.[0]?.url),
  }));

  return {
    title: decodeHtml(j.title || j.playlist_title || 'Playlist'),
    count: entries.length,
    entries,
  };
}

export async function fetchMeta(url: string): Promise<{ title: string; uploader?: string; thumbUrl?: string }> {
  const run = () => execFileP(ytDlpBin(), [
    '-J', '--no-playlist', '--no-warnings', ...ytNetArgs(), normalizeUrl(url),
  ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });

  const { stdout } = await withAgeGateRetry(url, run);

  const j = JSON.parse(stdout);
  return {
    title: decodeHtml(j.title || j.fulltitle || ''),
    uploader: decodeHtml(j.uploader || j.channel || j.extractor_key || ''),
    thumbUrl: j.thumbnail || j.thumbnails?.[0]?.url,
  };
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
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

export function spawnDownload(args: string[]) {
  return spawn(ytDlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
