/* Runnable range tests — `npx tsx tests/range.test.ts` (no framework).
   Covers resolveRange(), the byte-math behind the /stream/:id route: what the
   <video> element gets back for progressive play, seeks, suffix (moov) fetches,
   and every malformed/out-of-bounds request (which must 416, not a broken 206). */
import assert from 'assert';
import { resolveRange } from '../src/services/httpRange';

const TOTAL = 100 * 1024 * 1024;         // 100 MiB file
const CHUNK = 8 * 1024 * 1024;           // 8 MiB progressive cap

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

(async () => {
  await test('no Range header → full 200 response', () => {
    assert.deepEqual(resolveRange(undefined, TOTAL, CHUNK), { kind: 'full' });
  });

  await test('open-ended bytes=0- → first CHUNK only (progressive start)', () => {
    assert.deepEqual(resolveRange('bytes=0-', TOTAL, CHUNK), { kind: 'range', start: 0, end: CHUNK - 1 });
  });

  await test('open-ended mid-file seek is bounded to CHUNK', () => {
    const start = 50 * 1024 * 1024;
    assert.deepEqual(resolveRange(`bytes=${start}-`, TOTAL, CHUNK), { kind: 'range', start, end: start + CHUNK - 1 });
  });

  await test('explicit window is honoured and clamped to the file', () => {
    assert.deepEqual(resolveRange('bytes=500-999', TOTAL, CHUNK), { kind: 'range', start: 500, end: 999 });
    assert.deepEqual(resolveRange(`bytes=0-${TOTAL + 5000}`, TOTAL, CHUNK), { kind: 'range', start: 0, end: TOTAL - 1 });
  });

  await test('suffix bytes=-N → the last N bytes (trailing moov fetch)', () => {
    assert.deepEqual(resolveRange('bytes=-1048576', TOTAL, CHUNK), { kind: 'range', start: TOTAL - 1048576, end: TOTAL - 1 });
    // Suffix larger than the file clamps to the whole file.
    assert.deepEqual(resolveRange(`bytes=-${TOTAL + 10}`, TOTAL, CHUNK), { kind: 'range', start: 0, end: TOTAL - 1 });
  });

  await test('out-of-range / malformed → unsatisfiable (416)', () => {
    for (const h of ['bytes=999999999999-', 'bytes=abc-', 'bytes=-', 'bytes=10-5', 'bytes=', 'garbage', `bytes=${TOTAL}-`]) {
      assert.deepEqual(resolveRange(h, TOTAL, CHUNK), { kind: 'unsatisfiable' }, `expected 416 for "${h}"`);
    }
  });

  console.log(`\n${passed} passed`);
})();
