/* Runnable filter tests — `npx tsx tests/ytdlp-filter.test.ts` (no framework).
   Covers the duration filter's YouTube exemption: YouTube URLs of any length
   are allowed (no --match-filter), everything else keeps the 10-min minimum. */
import assert from 'assert';
import { isYouTubeUrl, ytFilterArgs, MIN_DURATION_SEC } from '../src/services/ytdlp';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

const YT = [
  'https://www.youtube.com/watch?v=54fea7wuV6s',
  'https://youtube.com/watch?v=abc',
  'https://m.youtube.com/watch?v=abc',
  'https://music.youtube.com/watch?v=abc',
  'https://youtu.be/54fea7wuV6s',
  'https://www.youtube-nocookie.com/embed/abc',
  'https://www.youtube.com/watch?v=54fea7wuV6s&list=RD54fea7wuV6s&start_radio=1', // the reported URL
];

const NON_YT = [
  'https://vimeo.com/123456',
  'https://www.dailymotion.com/video/x123',
  'https://example.com/video.mp4',
  'https://notyoutube.com/watch?v=abc',       // must not match by substring
  'https://youtube.com.evil.com/watch?v=abc', // host suffix spoof must not match
  'not a url at all',
];

(async () => {
  await test('isYouTubeUrl: true for every YouTube host/short-link form', () => {
    for (const u of YT) assert.equal(isYouTubeUrl(u), true, `expected YouTube: ${u}`);
  });

  await test('isYouTubeUrl: false for non-YouTube and spoofed hosts', () => {
    for (const u of NON_YT) assert.equal(isYouTubeUrl(u), false, `expected non-YouTube: ${u}`);
  });

  await test('ytFilterArgs: no duration filter for YouTube (any length)', () => {
    for (const u of YT) assert.deepEqual(ytFilterArgs(u), [], `expected empty args: ${u}`);
  });

  await test('ytFilterArgs: 10-min minimum kept for non-YouTube', () => {
    for (const u of NON_YT) {
      assert.deepEqual(
        ytFilterArgs(u),
        ['--match-filter', `duration >= ${MIN_DURATION_SEC}`],
        `expected duration filter: ${u}`,
      );
    }
  });

  console.log(`\n${passed} passed`);
})();
