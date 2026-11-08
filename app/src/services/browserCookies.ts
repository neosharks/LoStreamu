import fs from 'fs';
import puppeteer from 'puppeteer-core';
import type { Page } from 'puppeteer-core';
import { COOKIES_PATH } from '../config';
import { mergeCookies, parseCookies } from './cookieJar';
import { browserIdentity, findChromium } from './browserIdentity';

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

// "Accept" controls of common consent managers and age gates. Their buttons
// often carry no useful text (icons, translated labels), so they go by selector.
const GATE_SELECTORS = [
  '#onetrust-accept-btn-handler',                           // OneTrust
  '#didomi-notice-agree-button',                            // Didomi
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', // Cookiebot
  '#CybotCookiebotDialogBodyButtonAccept',
  '[data-testid="uc-accept-all-button"]',                   // Usercentrics
  '.fc-cta-consent',                                        // Google Funding Choices
  '.qc-cmp2-summary-buttons button[mode="primary"]',        // Quantcast
  '#truste-consent-button',                                 // TrustArc
  '.sp_choice_type_11',                                     // Sourcepoint
  '.buttonOver18',
].join(', ');

// Whole button labels that accept an age gate or consent wall: "I'm 18 or
// older", "Enter site", "Accept all cookies", "I agree", "Got it", …
const GATE_TEXT = /^((yes,? )?(i am|i'm|i’m) (over |at least )?18\b.*|over 18\b.*|18\+.*|(yes,? )?enter( (the )?site)?|(accept|allow)( all)?( cookies)?|(i )?(agree|accept)( (and|&) (continue|close|proceed))?|got it|ok(ay)?|continue( to (the )?(site|video))?)$/i;

// Clicks the first visible accept control in a document, searching open shadow
// roots too (some consent managers render inside one). Returns its label, or ''
// if there was none. A control that stays on screen is clicked only once, so a
// later round can't toggle it back. Runs in the page, hence a string.
export const CLICK_GATE = `(() => {
  const clicked = window.__svClicked || (window.__svClicked = new WeakSet());
  const visible = el => !clicked.has(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const label = el => (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  const all = sel => roots.flatMap(r => [...r.querySelectorAll(sel)]);
  const el = all(${JSON.stringify(GATE_SELECTORS)}).find(visible)
    || all('button, a, input[type=submit], input[type=button], [role=button]')
      .find(el => { const t = label(el); return t.length < 40 && ${GATE_TEXT}.test(t) && visible(el); });
  if (!el) return '';
  clicked.add(el);
  el.click();
  return label(el) || el.id || 'button';
})()`;

// Pop-ups come in layers (a cookie banner, then an age gate) and often in a
// frame of their own, so click through every frame until nothing is left.
const GATE_ROUNDS = 4;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitOutChallenge(page: Page): Promise<void> {
  for (let i = 0; i < 20 && CHALLENGE_TITLE.test(await page.title().catch(() => '')); i++) await sleep(1000);
}

async function clickGates(page: Page, url: string): Promise<void> {
  for (let round = 0; round < GATE_ROUNDS; round++) {
    let clicked = false;
    for (const frame of page.frames()) {
      const label = await frame.evaluate(CLICK_GATE).catch(() => '');
      if (!label) continue;
      console.log(`[cookies] accepted "${label}" on ${url}`);
      clicked = true;
    }
    if (!clicked) return;
    await sleep(2000);
    await waitOutChallenge(page);
  }
}

async function _run(url: string): Promise<void> {
  const executablePath = findChromium();

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    protocolTimeout: 45000,
    defaultViewport: { width: 1366, height: 768 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-first-run',
      '--no-zygote',
      // Hide navigator.webdriver, the first thing bot checks test.
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US',
      '--window-size=1366,768',
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
    const host = new URL(url).hostname;
    let existing = '';
    try { existing = fs.readFileSync(COOKIES_PATH, 'utf8'); } catch { /* first cookie fetch */ }

    // Visit with this site's cookies already on file (a login, an accepted
    // consent), so the site sees what yt-dlp will send and refreshes them.
    for (const c of parseCookies(existing, host)) {
      await browser.setCookie({
        name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, expires: c.expires,
      }).catch(() => { /* a cookie Chromium rejects is one the site would too */ });
    }

    const page = await browser.newPage();

    // Abort heavy resources — we only need the HTML document + its cookies.
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (BLOCKED_RESOURCES.has(req.resourceType())) req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });
    // Native alert/confirm age checks ("Are you over 18?") block the page until answered.
    page.on('dialog', dialog => { dialog.accept().catch(() => {}); });

    // A headed Chrome of the real installed version, client hints included:
    // headless Chromium otherwise says "HeadlessChrome" in both, which is
    // exactly what bot checks look for. yt-dlp presents the same identity.
    const id = browserIdentity(Number((await browser.version()).match(/\/(\d+)/)?.[1]));
    await page.setUserAgent({
      userAgent: id.userAgent,
      userAgentMetadata: {
        brands: id.brands,
        platform: id.platform,
        platformVersion: '',
        architecture: process.arch.startsWith('arm') ? 'arm' : 'x86',
        model: '',
        mobile: false,
      },
    });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitOutChallenge(page);
    await clickGates(page, url);

    // Every domain the visit touched: logins and consent often live on another
    // host than the video page (e.g. consent.youtube.com).
    const cookies = await browser.cookies();
    fs.writeFileSync(COOKIES_PATH, mergeCookies(existing, cookies, host), { mode: 0o600 });
  } finally {
    clearTimeout(killTimer);
    await browser.close().catch(() => {});
  }
}
