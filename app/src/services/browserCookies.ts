import fs from 'fs';
import puppeteer from 'puppeteer-core';
import { COOKIES_PATH } from '../config';

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

function findChromium(): string {
  for (const p of CHROMIUM_PATHS) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  throw new Error('Chromium not found — on macOS install Chrome from https://google.com/chrome; on Linux: apt-get install -y chromium');
}

function toNetscape(cookies: Array<{
  name: string; value: string; domain: string;
  path: string; secure: boolean; expires: number;
}>): string {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const expires = c.expires > 0 ? Math.round(c.expires) : Math.floor(Date.now() / 1000) + 86400 * 30;
    lines.push([domain, 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

// One Chromium launch at a time — reuse the pending promise if one is already running.
let _pending: Promise<void> | null = null;

export function fetchCookiesViaBrowser(url: string): Promise<void> {
  if (_pending) return _pending;
  _pending = _run(url).finally(() => { _pending = null; });
  return _pending;
}

// Resource types we never need for cookie extraction — blocking them cuts most
// of Chromium's CPU/network/decoding work (images, video, fonts, CSS).
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font', 'stylesheet']);

async function _run(url: string): Promise<void> {
  const executablePath = findChromium();

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    protocolTimeout: 45000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      // Trim background work Chromium does that we never use here.
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-default-apps',
      '--disable-sync',
      '--mute-audio',
      '--no-default-browser-check',
      '--metrics-recording-only',
    ],
  });

  // Safety net: never let a stuck Chromium linger burning CPU.
  const killTimer = setTimeout(() => {
    try { browser.process()?.kill('SIGKILL'); } catch {}
  }, 60000);

  try {
    const page = await browser.newPage();

    // Abort heavy resources — we only need the HTML document + its cookies.
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (BLOCKED_RESOURCES.has(req.resourceType())) req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Click age-gate if present
    try {
      await page.waitForSelector('.buttonOver18', { timeout: 5000 });
      await page.click('.buttonOver18');
      await new Promise(r => setTimeout(r, 1500));
    } catch {
      // No age gate — site loaded normally
    }

    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_PATH, toNetscape(cookies));
  } finally {
    clearTimeout(killTimer);
    await browser.close().catch(() => {});
  }
}
