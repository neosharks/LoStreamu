/* Runnable browser-identity tests — `npx tsx tests/browser-identity.test.ts` (no framework).
   Covers the User-Agent and client hints the cookie browser and yt-dlp share:
   they must read as one ordinary headed Chrome, never as HeadlessChrome. */
import assert from 'assert';
import { browserIdentity, clientHintHeaders } from '../src/services/browserIdentity';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

(async () => {
  await test('browserIdentity: Chrome\'s reduced User-Agent for the host OS', () => {
    assert.equal(browserIdentity(157, 'linux').userAgent,
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36');
    assert.match(browserIdentity(157, 'darwin').userAgent, /\(Macintosh; Intel Mac OS X 10_15_7\)/);
    assert.match(browserIdentity(157, 'win32').userAgent, /\(Windows NT 10\.0; Win64; x64\)/);
    assert.ok(!/headless/i.test(browserIdentity(157).userAgent));
  });

  await test('clientHintHeaders: agree with the User-Agent\'s version and platform', () => {
    const h = clientHintHeaders(browserIdentity(157, 'linux'));
    assert.equal(h['Sec-CH-UA'], '"Chromium";v="157", "Google Chrome";v="157", "Not_A Brand";v="24"');
    assert.equal(h['Sec-CH-UA-Platform'], '"Linux"');
    assert.equal(h['Sec-CH-UA-Mobile'], '?0');
  });

  console.log(`\n${passed} passed`);
})();
