/* Runnable playability tests — `npx tsx tests/health.test.ts` (no framework).
   Covers classifyHealth(), which decides whether a video in the library will
   actually play in a browser and what repairing it would involve, plus the MP4
   box walk behind the "index at the end of the file" finding. */
import assert from 'assert';
import { classifyHealth, healthOf, readTopLevelBoxes, boxesAreFastStart, type ByteReader } from '../src/services/health';
import type { VideoItem } from '../src/types';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

/** Builds a fake MP4 from a list of [type, size] boxes. */
function boxReader(boxes: Array<[string, number]>): { read: ByteReader; size: number } {
  let total = 0;
  for (const [, size] of boxes) total += size;
  const buf = Buffer.alloc(total);
  let offset = 0;
  for (const [type, size] of boxes) {
    buf.writeUInt32BE(size, offset);
    buf.write(type, offset + 4, 'latin1');
    offset += size;
  }
  return {
    size: total,
    read: (at, length) => (at >= total ? null : buf.subarray(at, Math.min(total, at + length))),
  };
}

(async () => {
  await test('classifyHealth: a faststart H.264/AAC MP4 is fine', () => {
    const h = classifyHealth({ ext: '.mp4', vcodec: 'h264', acodec: 'aac', faststart: true, duration: 600 });
    assert.equal(h.level, 'ok');
    assert.equal(h.plan, 'none');
    assert.deepEqual(h.issues, []);
  });

  await test('classifyHealth: H.264/AAC in an MKV only needs a remux', () => {
    const h = classifyHealth({ ext: '.mkv', vcodec: 'h264', acodec: 'aac', duration: 600 });
    assert.equal(h.level, 'broken');
    assert.equal(h.plan, 'remux');
    assert.match(h.issues[0] ?? '', /MKV/);
  });

  await test('classifyHealth: an MP4 with the index at the end is a remux, not an encode', () => {
    const h = classifyHealth({ ext: '.mp4', vcodec: 'h264', acodec: 'aac', faststart: false, duration: 600 });
    assert.equal(h.level, 'warn');
    assert.equal(h.plan, 'remux');
  });

  await test('classifyHealth: HEVC and AV1 need a re-encode', () => {
    for (const vcodec of ['hevc', 'mpeg4', 'wmv3']) {
      const h = classifyHealth({ ext: '.mp4', vcodec, acodec: 'aac', faststart: true, duration: 600 });
      assert.equal(h.level, 'broken', vcodec);
      assert.equal(h.plan, 'transcode', vcodec);
    }
  });

  await test('classifyHealth: VP9 plays somewhere, so it only warns', () => {
    const h = classifyHealth({ ext: '.webm', vcodec: 'vp9', acodec: 'opus', duration: 600 });
    assert.equal(h.level, 'warn');
    assert.equal(h.plan, 'transcode');
  });

  await test('classifyHealth: AC-3 audio alone is enough to break a file', () => {
    const h = classifyHealth({ ext: '.mp4', vcodec: 'h264', acodec: 'ac3', faststart: true, duration: 600 });
    assert.equal(h.level, 'broken');
    assert.equal(h.plan, 'transcode');
    assert.match(h.issues[0] ?? '', /AC3/);
  });

  await test('classifyHealth: no audio track is not a fault', () => {
    const h = classifyHealth({ ext: '.mp4', vcodec: 'h264', acodec: '', faststart: true, duration: 600 });
    assert.equal(h.level, 'ok');
  });

  await test('classifyHealth: an unreadable file is broken but still worth a repair', () => {
    const h = classifyHealth({ ext: '.mp4' });
    assert.equal(h.level, 'broken');
    assert.equal(h.plan, 'transcode');
  });

  await test('classifyHealth: a zero duration means the download was cut short', () => {
    const h = classifyHealth({ ext: '.mp4', vcodec: 'h264', acodec: 'aac', faststart: true, duration: 0 });
    assert.equal(h.level, 'broken');
    assert.equal(h.plan, 'transcode');
  });

  await test('healthOf: a video nobody has probed has no verdict at all', () => {
    const unprobed = {
      id: 'a', name: 'clip', ext: '.mp4', relPath: 'clip.mp4', absPath: '/tmp/clip.mp4',
      folder: '', size: 100, addedAt: 0,
    } as VideoItem;
    // "Not looked at yet" must never be reported as "damaged" — a freshly
    // repaired file passes through this state on its way back into the library.
    assert.equal(healthOf(unprobed), undefined);
    assert.equal(healthOf({ ...unprobed, probedAt: Date.now(), vcodec: 'h264', acodec: 'aac', faststart: true, duration: 10 })?.level, 'ok');
  });

  await test('healthOf: probed with no video track IS damaged', () => {
    const probed = {
      id: 'a', name: 'clip', ext: '.mp4', relPath: 'clip.mp4', absPath: '/tmp/clip.mp4',
      folder: '', size: 100, addedAt: 0, probedAt: Date.now(),
    } as VideoItem;
    assert.equal(healthOf(probed)?.level, 'broken');
  });

  await test('readTopLevelBoxes: walks a faststart file', () => {
    const { read, size } = boxReader([['ftyp', 32], ['moov', 2048], ['mdat', 4096]]);
    const boxes = readTopLevelBoxes(read, size);
    assert.deepEqual(boxes, ['ftyp', 'moov', 'mdat']);
    assert.equal(boxesAreFastStart(boxes), true);
  });

  await test('readTopLevelBoxes: spots an index parked after the media', () => {
    const { read, size } = boxReader([['ftyp', 32], ['mdat', 4096], ['moov', 2048]]);
    assert.equal(boxesAreFastStart(readTopLevelBoxes(read, size)), false);
  });

  await test('boxesAreFastStart: no moov at all is not faststart', () => {
    assert.equal(boxesAreFastStart(['ftyp', 'mdat']), false);
  });

  await test('readTopLevelBoxes: stops rather than looping on a malformed size', () => {
    const buf = Buffer.alloc(64);
    buf.writeUInt32BE(0, 0);          // "to end of file"
    buf.write('ftyp', 4, 'latin1');
    const boxes = readTopLevelBoxes((at, len) => (at >= 64 ? null : buf.subarray(at, at + len)), 64);
    assert.deepEqual(boxes, ['ftyp']);
  });

  console.log(`\n${passed} passed`);
})();
