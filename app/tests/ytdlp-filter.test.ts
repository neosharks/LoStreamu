/* Runnable filter tests — `npx tsx tests/ytdlp-filter.test.ts` (no framework).
   Covers the duration filter's YouTube exemption: YouTube URLs of any length
   are allowed (no --match-filter), everything else keeps the 10-min minimum. */
import assert from 'assert';
import { isYouTubeUrl, ytFilterArgs, ytFormatArgs, MIN_DURATION_SEC } from '../src/services/ytdlp';

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

  await test('ytFormatArgs: prefers browser-safe codecs, mp4 container, faststart', () => {
    const args = ytFormatArgs();
    const flag = (name: string) => args[args.indexOf(name) + 1];
    // Format ladder leads with an H.264 (avc1) + AAC (m4a) mp4 pick.
    assert.ok(flag('-f').startsWith('bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]'), 'H.264/AAC preferred first');
    // Sort also biases toward h264 / aac / mp4 when the site offers a choice.
    assert.equal(flag('-S'), 'vcodec:h264,acodec:aac,ext:mp4');
    // Always land in an mp4 container.
    assert.equal(flag('--merge-output-format'), 'mp4');
    assert.equal(flag('--remux-video'), 'mp4');
    // moov atom up front so progressive playback starts at byte 0.
    assert.ok(flag('--postprocessor-args').includes('+faststart'), 'faststart applied');
  });

  console.log(`\n${passed} passed`);
})();
