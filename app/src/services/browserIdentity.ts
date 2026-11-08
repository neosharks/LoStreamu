import fs from 'fs';
import { spawnSync } from 'child_process';

const CHROMIUM_PATHS = [
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  // Linux
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
];

export function findChromium(): string {
  for (const p of CHROMIUM_PATHS) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  throw new Error('Chromium not found — on macOS install Chrome from https://google.com/chrome; on Linux: apt-get install -y chromium');
}

// Client-hint platform names and User-Agent OS tokens, as Chrome sends them.
const PLATFORMS: Record<string, { hint: string; ua: string }> = {
  darwin: { hint: 'macOS', ua: 'Macintosh; Intel Mac OS X 10_15_7' },
  win32: { hint: 'Windows', ua: 'Windows NT 10.0; Win64; x64' },
  linux: { hint: 'Linux', ua: 'X11; Linux x86_64' },
};

export interface BrowserIdentity {
  major: number;
  userAgent: string;
  platform: string;
  brands: { brand: string; version: string }[];
}

// What Chrome `major` sends as an ordinary, headed browser. Chrome reports only
// its major version and a frozen OS token in the User-Agent, so this is the real
// string, not an approximation. The cookie browser and yt-dlp both present it:
// bot-check clearance cookies only work for the identity that earned them.
export function browserIdentity(major: number, platform: string = process.platform): BrowserIdentity {
  const p = PLATFORMS[platform] ?? PLATFORMS.linux;
  return {
    major,
    userAgent: `Mozilla/5.0 (${p.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    platform: p.hint,
    brands: [
      { brand: 'Chromium', version: String(major) },
      { brand: 'Google Chrome', version: String(major) },
      { brand: 'Not_A Brand', version: '24' },
    ],
  };
}

// The Sec-CH-UA headers Chrome sends alongside that User-Agent.
export function clientHintHeaders(id: BrowserIdentity): Record<string, string> {
  return {
    'Sec-CH-UA': id.brands.map(b => `"${b.brand}";v="${b.version}"`).join(', '),
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': `"${id.platform}"`,
  };
}

let _local: BrowserIdentity | null | undefined;

// The identity of this host's Chromium, or null if there is none. Probed once.
export function localBrowserIdentity(): BrowserIdentity | null {
  if (_local !== undefined) return _local;
  _local = null;
  try {
    const r = spawnSync(findChromium(), ['--version'], { encoding: 'utf8', timeout: 10000 });
    const m = (r.stdout || '').match(/(\d+)\.\d+\.\d+/);
    if (m) _local = browserIdentity(Number(m[1]));
  } catch { /* no Chromium */ }
  return _local;
}
