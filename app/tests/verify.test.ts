/* Runnable verify tests — `npx tsx tests/verify.test.ts` (no framework).
   Covers classifyProbe(), which decides whether a just-downloaded file is a
   real, playable video from its ffprobe JSON. A file that fails this is deleted
   and re-downloaded instead of landing in the library as an unplayable item. */
import assert from 'assert';
import { classifyProbe } from '../src/services/media';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

(async () => {
  await test('classifyProbe: ok for a real video with duration', () => {
    const probe = {
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: { duration: '212.5' },
    };
    assert.deepEqual(classifyProbe(probe), { ok: true });
  });

  await test('classifyProbe: ok when duration lives on the video stream', () => {
    const probe = {
      streams: [{ codec_type: 'video', codec_name: 'h264', duration: '90.0' }],
      format: {},
    };
    assert.equal(classifyProbe(probe).ok, true);
  });

  await test('classifyProbe: rejects audio-only (no video track)', () => {
    const probe = { streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: { duration: '180' } };
    const v = classifyProbe(probe);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'no video track');
  });

  await test('classifyProbe: rejects zero / missing duration', () => {
    assert.equal(classifyProbe({ streams: [{ codec_type: 'video' }], format: { duration: '0' } }).ok, false);
    assert.equal(classifyProbe({ streams: [{ codec_type: 'video' }], format: {} }).ok, false);
  });

  await test('classifyProbe: rejects empty / malformed probe output', () => {
    assert.equal(classifyProbe({}).ok, false);
    assert.equal(classifyProbe({ streams: [] }).ok, false);
    assert.equal(classifyProbe(null).ok, false);
    assert.equal(classifyProbe('garbage').ok, false);
  });

  console.log(`\n${passed} passed`);
})();
