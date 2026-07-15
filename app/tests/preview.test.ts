/* Runnable preview-layout tests — `npx tsx tests/preview.test.ts` (no framework).
   Covers the frame-sampling math: frame cap, interval scaling, bucket coverage,
   and aspect-derived tile height (always even for the JPEG encoder). */
import assert from 'assert';
import { computePreviewLayout } from '../src/services/preview';

const MAX_FRAMES = 60;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

(async () => {
  await test('short video (2 min): 2s buckets', () => {
    const m = computePreviewLayout(120, 1920, 1080);
    assert.equal(m.interval, 2);
    assert.equal(m.count, 60);
    assert.equal(m.tileW, 160);
    assert.equal(m.tileH, 90, '16:9 -> 90');
  });

  await test('long video (47 min): frames stay capped, interval scales', () => {
    const m = computePreviewLayout(2857, 1920, 1080);
    assert.ok(m.count <= MAX_FRAMES, `count ${m.count} <= ${MAX_FRAMES}`);
    assert.equal(m.interval, Math.ceil(2857 / MAX_FRAMES), 'interval = ceil(dur/cap)');
  });

  await test('portrait video: taller tile, still even', () => {
    const m = computePreviewLayout(600, 1080, 1920);
    assert.equal(m.tileH % 2, 0, 'tileH even');
    assert.ok(m.tileH > m.tileW, 'portrait taller than wide');
  });

  await test('unknown dimensions default to 16:9', () => {
    assert.equal(computePreviewLayout(600).tileH, 90);
  });

  await test('buckets always cover the whole video, count never exceeds cap', () => {
    for (const d of [30, 120, 300, 1234, 2857, 7200]) {
      const m = computePreviewLayout(d, 1280, 720);
      assert.ok(m.count <= MAX_FRAMES, `count<=cap for ${d}s`);
      assert.ok(m.count * m.interval >= d, `buckets cover ${d}s`);
    }
  });

  console.log(`\n${passed} passed`);
})();
