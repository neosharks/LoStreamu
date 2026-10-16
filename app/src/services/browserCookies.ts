import fs from 'fs';
import puppeteer from 'puppeteer-core';
import { COOKIES_PATH } from '../config';
import { mergeCookies } from './cookieJar';

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

// Titles of bot-check interstitials (Cloudflare, DDoS-Guard, Sucuri, …) that
// run a script and then reload into the real page, setting a clearance cookie.
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|ddos-guard|please wait|verify(ing)? you are human/i;

// Age gates and consent walls: click the first button that says "I'm 18",
// "Enter", "Accept all", …. Runs in the page, hence a string.
const CLICK_GATE = `(() => {
  const re = /^((yes,? )?(i am|i'm) (over |at least )?18\\b|over 18\\b|18\\+|enter( (the )?site)?$|accept all$|i agree$)/i;
  for (const el of document.querySelectorAll('.buttonOver18, button, a, input[type=submit], [role=button]')) {
    const text = (el.innerText || el.value || '').trim();
    if (el.matches('.buttonOver18') || (text.length < 40 && re.test(text))) { el.click(); return true; }
  }
  return false;
})()`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

    // The real Chromium version, minus "Headless": a made-up UA that disagrees
    // with the browser's own client hints is exactly what bot checks look for.
    await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    for (let i = 0; i < 20 && CHALLENGE_TITLE.test(await page.title().catch(() => '')); i++) await sleep(1000);

    if (await page.evaluate(CLICK_GATE).catch(() => false)) await sleep(2000);

    // Every domain the visit touched: logins and consent often live on another
    // host than the video page (e.g. consent.youtube.com).
    const cookies = await browser.cookies();
    let existing = '';
    try { existing = fs.readFileSync(COOKIES_PATH, 'utf8'); } catch { /* first cookie fetch */ }
    fs.writeFileSync(COOKIES_PATH, mergeCookies(existing, cookies), { mode: 0o600 });
  } finally {
    clearTimeout(killTimer);
    await browser.close().catch(() => {});
  }
}
