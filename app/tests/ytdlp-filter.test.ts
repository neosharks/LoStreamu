/* Runnable filter tests — `npx tsx tests/ytdlp-filter.test.ts` (no framework).
   Covers the duration filter's YouTube exemption: YouTube URLs of any length
   are allowed (no --match-filter), everything else keeps the configured minimum
   (5 minutes by default, set from the Downloads page). */
import assert from 'assert';
import {
  isYouTubeUrl, ytFilterArgs, ytFormatArgs, availableImpersonateTargets, supportsJsRuntimes,
  ytNetArgs, ytSpeedArgs, ytErrorMessage, parsePlaylistLine, filteredOutMessage, isAlreadyArchived,
  isImpersonationTlsError, isClientRejected, tryClients, netHint,
} from '../src/services/ytdlp';

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

  await test('ytFilterArgs: 5-min default minimum kept for non-YouTube', () => {
    for (const u of NON_YT) {
      assert.deepEqual(ytFilterArgs(u), ['--match-filter', 'duration >= 300'], `expected duration filter: ${u}`);
    }
  });

  await test('ytFilterArgs: honours a configured minimum, 0 turns the filter off', () => {
    assert.deepEqual(ytFilterArgs('https://vimeo.com/1', 600), ['--match-filter', 'duration >= 600']);
    assert.deepEqual(ytFilterArgs('https://vimeo.com/1', 0), []);
    assert.deepEqual(ytFilterArgs('https://youtu.be/abc', 600), [], 'YouTube stays exempt');
  });

  await test('filteredOutMessage: names the minimum that skipped the video', () => {
    assert.equal(filteredOutMessage(300), 'Skipped — shorter than 5 minutes');
    assert.equal(filteredOutMessage(60), 'Skipped — shorter than 1 minute');
    assert.equal(filteredOutMessage(), 'Skipped — shorter than 5 minutes', 'default is 5 minutes');
  });

  await test('isAlreadyArchived: spots yt-dlp skipping a video its archive lists', () => {
    assert.equal(isAlreadyArchived('[download] abc123: has already been recorded in the archive'), true);
    assert.equal(isAlreadyArchived('[download]  42.0% of 10.00MiB at 1.00MiB/s ETA 00:05'), false);
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

  await test('availableImpersonateTargets: usable browsers, best first', () => {
    const header = '[info] Available impersonate targets\nClient          OS           Source\n--------------------------------------\n';
    assert.deepEqual(availableImpersonateTargets(header +
      'Firefox-135     Macos-14     curl_cffi\nSafari-18.0     Ios-18.0     curl_cffi\nChrome-136      Macos-15     curl_cffi\nTor-14.5        Macos-14     curl_cffi\n'),
      ['chrome', 'safari', 'firefox']);
    // curl-cffi missing / unsupported version: yt-dlp still lists targets, marked unavailable.
    assert.deepEqual(availableImpersonateTargets(header + 'Chrome         -            curl_cffi (unavailable)\nSafari         -            curl_cffi (unavailable)\n'), []);
    assert.deepEqual(availableImpersonateTargets(header + 'Safari-18.0     Ios-18.0     curl_cffi\n'), ['safari']);
    assert.deepEqual(availableImpersonateTargets(''), []);
  });

  await test('supportsJsRuntimes: only yt-dlp releases that know --js-runtimes', () => {
    assert.equal(supportsJsRuntimes('2026.08.19'), true);
    assert.equal(supportsJsRuntimes('2025.11.12'), true);
    assert.equal(supportsJsRuntimes('2025.11.12.233212'), true); // nightly build suffix
    assert.equal(supportsJsRuntimes('2025.10.22'), false);
    assert.equal(supportsJsRuntimes(''), false);
  });

  await test('request pacing: downloads sleep between requests, probes do not', () => {
    // A playlist probe pages through 100 entries per request; sleeping on each
    // page pushed big playlists past the probe timeout ("stuck on fetching info").
    assert.ok(ytSpeedArgs().includes('--sleep-requests'));
    assert.ok(!ytNetArgs().includes('--sleep-requests'));
  });

  await test('isImpersonationTlsError: spots curl-cffi TLS handshake failures only', () => {
    // The reported error: curl-cffi's impersonated handshake rejected by the site.
    assert.equal(isImpersonationTlsError('ERROR: [generic] Unable to download webpage: Failed to perform, curl: (35) . See https://curl.se/libcurl/c/libcurl-errors.html first for more details.'), true);
    assert.equal(isImpersonationTlsError('ERROR: Unable to download webpage: Failed to perform, curl: (28) Operation timed out'), false);
    assert.equal(isImpersonationTlsError('ERROR: [Errno 104] Connection reset by peer'), false);
    assert.equal(isImpersonationTlsError(undefined), false);
  });

  await test('ytNetArgs: plain yt-dlp (null client) does not impersonate', () => {
    assert.ok(!ytNetArgs(null).includes('--impersonate'));
  });

  await test('isClientRejected: TLS handshake failures and 403s only', () => {
    assert.equal(isClientRejected('ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden'), true);
    assert.equal(isClientRejected('ERROR: Unable to download webpage: Failed to perform, curl: (35) '), true);
    assert.equal(isClientRejected('ERROR: Unsupported URL: https://example.com'), false);
    assert.equal(isClientRejected(undefined), false);
  });

  await test('tryClients: moves past rejected clients, stops at the first that works', async () => {
    const tried: (string | null)[] = [];
    const replies: Record<string, string | undefined> = {
      chrome: 'ERROR: Failed to perform, curl: (35) ',
      safari: 'ERROR: HTTP Error 403: Forbidden',
    };
    const { result, client } = await tryClients(
      async c => { tried.push(c); return replies[String(c)]; }, r => r, ['chrome', 'safari', 'edge', null],
    );
    assert.deepEqual(tried, ['chrome', 'safari', 'edge']);
    assert.equal(result, undefined);
    assert.equal(client, 'edge');
  });

  await test('tryClients: a non-client error is final, not retried', async () => {
    const tried: (string | null)[] = [];
    const { result } = await tryClients(
      async c => { tried.push(c); return 'ERROR: Unsupported URL'; }, r => r, ['chrome', null],
    );
    assert.deepEqual(tried, ['chrome']);
    assert.equal(result, 'ERROR: Unsupported URL');
  });

  await test('tryClients: all rejected → retry with the last client the site answered', async () => {
    const replies: Record<string, string> = {
      chrome: 'ERROR: HTTP Error 403: Forbidden',
      safari: 'ERROR: Failed to perform, curl: (35) ',
      null: 'ERROR: Failed to perform, curl: (35) ',
    };
    const { client } = await tryClients(async c => replies[String(c)], r => r, ['chrome', 'safari', null]);
    assert.equal(client, 'chrome');
  });

  await test('netHint: explains a TLS handshake failure', () => {
    assert.match(netHint('ERROR: Unable to download webpage: Failed to perform, curl: (35) '), /TLS handshake failed/);
  });

  await test('ytErrorMessage: surfaces yt-dlp\'s ERROR line, not the echoed command', () => {
    const err = Object.assign(
      new Error('Command failed: yt-dlp -J --flat-playlist --no-warnings --cookies /x/cookies.txt --no-check-certificates https://y\nERROR: [youtube:tab] PLx: The playlist does not exist.\n'),
      { stderr: 'ERROR: [youtube:tab] PLx: The playlist does not exist.\n' },
    );
    assert.equal(ytErrorMessage(err), 'ERROR: [youtube:tab] PLx: The playlist does not exist.');
    assert.equal(ytErrorMessage(Object.assign(new Error('Command failed: yt-dlp -J x\n'), { killed: true, stderr: '' })), 'yt-dlp timed out');
    assert.equal(ytErrorMessage({ stderr: 'Python 3.8 is no longer supported\n', message: 'yt-dlp exited with code 1' }), 'Python 3.8 is no longer supported');
  });

  await test('parsePlaylistLine: reads a flat entry, skips non-entries', () => {
    const p = parsePlaylistLine(JSON.stringify({
      playlist_index: 3, playlist_title: 'Mix &amp; Match', title: 'A &quot;B&quot;',
      url: 'https://www.youtube.com/watch?v=abc', duration: 61, thumbnails: [{ url: 'https://i/t.jpg' }],
    }))!;
    assert.deepEqual(p.entry, { index: 3, title: 'A "B"', url: 'https://www.youtube.com/watch?v=abc', duration: 61, thumbnail: 'https://i/t.jpg' });
    assert.equal(p.playlistTitle, 'Mix & Match');
    assert.equal(parsePlaylistLine(JSON.stringify({ id: 'abc', title: 'single video' })), null);
    assert.equal(parsePlaylistLine('[youtube] not json'), null);
    assert.equal(parsePlaylistLine(''), null);
  });

  console.log(`\n${passed} passed`);
})();
