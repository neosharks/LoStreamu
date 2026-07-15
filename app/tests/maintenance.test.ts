/* Runnable maintenance tests — `npx tsx tests/maintenance.test.ts` (no framework).
   Covers the junk-file classifier that decides what cleanJunk() deletes: yt-dlp
   temp/partial leftovers are junk; real media and the download archive are not. */
import assert from 'assert';
import { isJunkFile } from '../src/services/maintenance';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

const JUNK = [
  'video.mp4.part',           // interrupted download
  'video.f137.mp4.ytdl',      // yt-dlp resume state
  'clip.temp',
  'clip.tmp',
  'clip.download',
  'video.mp4.part-Frag123',   // DASH fragment leftover
  'VIDEO.MP4.PART',           // case-insensitive
];

const KEEP = [
  'movie.mp4',                // real video
  'clip.mkv',
  '.downloaded.txt',          // yt-dlp archive — intentional, must survive
  '.gitkeep',
  'notes.txt',
  'thumbnail.jpg',
  'partly-cloudy.mp4',        // "part" as a substring must NOT trigger
];

(async () => {
  await test('isJunkFile: true for yt-dlp temp/partial leftovers', () => {
    for (const n of JUNK) assert.equal(isJunkFile(n), true, `expected junk: ${n}`);
  });

  await test('isJunkFile: false for real media, archives and dotfiles', () => {
    for (const n of KEEP) assert.equal(isJunkFile(n), false, `expected kept: ${n}`);
  });

  console.log(`\n${passed} passed`);
})();
