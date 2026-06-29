import fs from 'fs';
import puppeteer from 'puppeteer-core';
import { COOKIES_PATH } from '../config';

const CHROMIUM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
];

function findChromium(): string {
  for (const p of CHROMIUM_PATHS) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  throw new Error('Chromium not found — install with: apt-get install -y chromium');
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

const COOKIE_MAX_AGE_MS = 30 * 60 * 1000;
let _refreshing = false;

function cookiesAge(): number {
  try { return Date.now() - fs.statSync(COOKIES_PATH).mtimeMs; } catch { return Infinity; }
}

export async function refreshBrowserCookies(url: string): Promise<void> {
  if (_refreshing || cookiesAge() < COOKIE_MAX_AGE_MS) return;
  _refreshing = true;
  try {
    const executablePath = findChromium();
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Click the age-gate confirmation button if present
      try {
        await page.waitForSelector('.buttonOver18', { timeout: 5000 });
        await page.click('.buttonOver18');
        await new Promise(r => setTimeout(r, 1500));
      } catch {
        // No age gate visible — already accepted or not shown
      }

      const cookies = await page.cookies();
      fs.writeFileSync(COOKIES_PATH, toNetscape(cookies));
    } finally {
      await browser.close();
    }
  } catch (err: any) {
    console.warn('browserCookies: failed to refresh:', err?.message?.split('\n')[0]);
  } finally {
    _refreshing = false;
  }
}
