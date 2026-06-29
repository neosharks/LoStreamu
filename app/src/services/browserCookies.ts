import fs from 'fs';
import { chromium } from 'playwright-core';
import { COOKIES_PATH } from '../config';

// Age-gate selectors to try clicking in order.
const AGE_GATE_SELECTORS = [
  'button[data-action="age-gate-confirm"]',
  'button.ageGateButton',
  'a.ageGateButton',
  '[class*="ageGate"] button',
  '[class*="age-gate"] button',
  'button:has-text("I am 18")',
  'button:has-text("Enter")',
  'a:has-text("I am 18")',
  '.age-gate .button',
];

let _refreshing = false;
const COOKIE_MAX_AGE_MS = 30 * 60 * 1000; // refresh cookies every 30 minutes

function cookiesAge(): number {
  try {
    const stat = fs.statSync(COOKIES_PATH);
    return Date.now() - stat.mtimeMs;
  } catch {
    return Infinity;
  }
}

function toNetscape(cookies: Array<{
  name: string; value: string; domain: string;
  path: string; secure: boolean; expires: number;
}>): string {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    const expires = c.expires > 0 ? c.expires : Math.floor(Date.now() / 1000) + 86400 * 30;
    lines.push(`${domain}\tTRUE\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${expires}\t${c.name}\t${c.value}`);
  }
  return lines.join('\n') + '\n';
}

export async function refreshBrowserCookies(url: string): Promise<void> {
  if (_refreshing) return;
  if (cookiesAge() < COOKIE_MAX_AGE_MS) return;
  _refreshing = true;
  try {
    const origin = new URL(url).origin;

    const browser = await chromium.launch({
      executablePath: findChromium(),
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--no-first-run', '--no-zygote',
      ],
    });

    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        locale: 'en-US',
        viewport: { width: 1280, height: 800 },
      });

      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Try each age-gate selector
      for (const selector of AGE_GATE_SELECTORS) {
        try {
          const el = page.locator(selector).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.click();
            await page.waitForTimeout(1000);
            break;
          }
        } catch {}
      }

      // Also visit the origin root to pick up any base cookies
      if (!url.endsWith('/') || url !== origin + '/') {
        try { await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 10000 }); } catch {}
      }

      const cookies = await context.cookies();
      fs.writeFileSync(COOKIES_PATH, toNetscape(cookies));
      await context.close();
    } finally {
      await browser.close();
    }
  } catch (err: any) {
    console.warn('browserCookies: failed to refresh cookies:', err?.message?.split('\n')[0]);
  } finally {
    _refreshing = false;
  }
}

function findChromium(): string {
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  throw new Error('Chromium not found. Install it: apt-get install -y chromium');
}
