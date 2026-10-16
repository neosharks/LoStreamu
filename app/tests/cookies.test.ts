/* Runnable cookie-jar tests — `npx tsx tests/cookies.test.ts` (no framework).
   Covers merging browser cookies into the shared cookies.txt without dropping
   other sites' cookies, and converting JSON exports yt-dlp would reject. */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mergeCookies, jsonToCookies, prepareCookiesFile, netscapeLine } from '../src/services/cookieJar';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

const entries = (jar: string) => jar.split('\n').filter(l => l && !l.startsWith('# '));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-cookies-'));

const EXISTING = [
  '# Netscape HTTP Cookie File',
  '# This is a generated file! Do not edit.',
  '',
  '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tLOGIN_INFO\tyt-login',
  '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tyt-sid',
  '.example.com\tTRUE\t/\tFALSE\t1893456000\tage_ok\told',
].join('\n');

(async () => {
  await test('mergeCookies: keeps every other site\'s cookies', () => {
    const jar = mergeCookies(EXISTING, [{ name: 'cf_clearance', value: 'x', domain: 'other.org', expires: 1893456000 }]);
    assert.ok(jar.includes('\tLOGIN_INFO\tyt-login'), 'YouTube login kept');
    assert.ok(jar.includes('#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tyt-sid'), 'HttpOnly entry kept verbatim');
    assert.ok(jar.includes('.other.org\tTRUE\t/\tFALSE\t1893456000\tcf_clearance\tx'), 'new cookie added');
    assert.equal(entries(jar).length, 4);
  });

  await test('mergeCookies: a fresh cookie replaces its own stale entry only', () => {
    const jar = mergeCookies(EXISTING, [{ name: 'age_ok', value: 'new', domain: 'example.com', path: '/', expires: 1893456000 }]);
    assert.ok(jar.includes('\tage_ok\tnew'));
    assert.ok(!jar.includes('\tage_ok\told'));
    assert.equal(entries(jar).length, 3);
  });

  await test('mergeCookies: writes a Netscape header and drops old comments/blank lines', () => {
    const jar = mergeCookies(EXISTING, []);
    assert.ok(jar.startsWith('# Netscape HTTP Cookie File\n'));
    assert.ok(!jar.includes('Do not edit'));
    assert.ok(!jar.includes('\n\n'));
  });

  await test('mergeCookies: drops malformed lines yt-dlp would skip anyway', () => {
    const jar = mergeCookies('not a cookie line\n.a.com\tTRUE\t/\n', []);
    assert.equal(entries(jar).length, 0);
  });

  await test('netscapeLine: session cookies get a future expiry, domain is dotted', () => {
    const f = netscapeLine({ name: 'n', value: 'v', domain: 'site.com', secure: true, expires: -1 }).split('\t');
    assert.equal(f.length, 7);
    assert.equal(f[0], '.site.com');
    assert.equal(f[3], 'TRUE');
    assert.ok(Number(f[4]) > Date.now() / 1000);
  });

  await test('jsonToCookies: reads Cookie-Editor style arrays and {cookies: [...]} wrappers', () => {
    const list = [{ domain: '.vimeo.com', name: 'vuid', value: '1', path: '/', secure: true, expirationDate: 1893456000.5 }];
    for (const text of [JSON.stringify(list), JSON.stringify({ cookies: list })]) {
      const c = jsonToCookies(text)!;
      assert.equal(c.length, 1);
      assert.equal(c[0].name, 'vuid');
      assert.equal(c[0].expires, 1893456000.5);
    }
    assert.equal(jsonToCookies('{"foo": 1}'), null);
    assert.equal(jsonToCookies('nope'), null);
  });

  await test('prepareCookiesFile: missing file → not passed to yt-dlp', () => {
    assert.equal(prepareCookiesFile(path.join(tmp, 'missing.txt')), false);
  });

  await test('prepareCookiesFile: Netscape file is used untouched', () => {
    const f = path.join(tmp, 'netscape.txt');
    fs.writeFileSync(f, EXISTING);
    assert.equal(prepareCookiesFile(f), true);
    assert.equal(fs.readFileSync(f, 'utf8'), EXISTING);
  });

  await test('prepareCookiesFile: JSON export is converted in place', () => {
    const f = path.join(tmp, 'export.txt');
    fs.writeFileSync(f, '﻿' + JSON.stringify([{ domain: '.vimeo.com', name: 'vuid', value: '1', secure: true, expirationDate: 1893456000 }]));
    assert.equal(prepareCookiesFile(f), true);
    const jar = fs.readFileSync(f, 'utf8');
    assert.ok(jar.startsWith('# Netscape HTTP Cookie File\n'));
    assert.ok(jar.includes('.vimeo.com\tTRUE\t/\tTRUE\t1893456000\tvuid\t1'));
  });

  await test('prepareCookiesFile: unreadable JSON is ignored, not passed to yt-dlp', () => {
    const f = path.join(tmp, 'broken.txt');
    fs.writeFileSync(f, '[{"broken"');
    assert.equal(prepareCookiesFile(f), false);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
})();
