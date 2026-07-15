/* Runnable preview-layout tests — `npx tsx tests/preview.test.ts` (no framework).
   Covers the sprite grid math: tile cap, interval scaling, and aspect-derived
   tile height (always even for yuv420p). */
import assert from 'assert';
import { computePreviewLayout } from '../src/services/preview';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

(async () => {
  await test('short video (2 min): dense 2s interval, one row', () => {
    const m = computePreviewLayout(120, 1920, 1080);
    assert.equal(m.interval, 2, '2s interval');
    assert.equal(m.count, 60, '60 tiles');
    assert.equal(m.cols, 10);
    assert.equal(m.rows, 6);
    assert.equal(m.tileW, 160);
    assert.equal(m.tileH, 90, '16:9 -> 90');
  });

  await test('long video (1 h): interval scales so tiles stay capped at 100', () => {
    const m = computePreviewLayout(3600, 1920, 1080);
    assert.ok(m.count <= 100, `count ${m.count} <= 100`);
    assert.equal(m.interval, 36, 'ceil(3600/100)=36');
    assert.equal(m.cols, 10);
  });

  await test('portrait video: taller tile, still even', () => {
    const m = computePreviewLayout(600, 1080, 1920); // 9:16
    assert.equal(m.tileH % 2, 0, 'tileH even');
    assert.ok(m.tileH > m.tileW, 'portrait taller than wide');
  });

  await test('unknown dimensions default to 16:9', () => {
    const m = computePreviewLayout(600);
    assert.equal(m.tileH, 90);
  });

  await test('grid always covers the tile count', () => {
    for (const d of [30, 300, 1234, 7200]) {
      const m = computePreviewLayout(d, 1280, 720);
      assert.ok(m.cols * m.rows >= m.count, `grid fits count for ${d}s`);
    }
  });

  console.log(`\n${passed} passed`);
})();
