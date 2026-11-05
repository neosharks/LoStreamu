/* Runnable download-settings tests — `npx tsx tests/downloads-settings.test.ts`
   (no framework). Covers the minimum-length setting behind the Downloads page
   and the scrub that keeps source titles out of the saved queue file.

   SV_DATA_DIR is set before importing the app so the suite reads and writes a
   throwaway directory, never the developer's real data. */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-dlsettings-'));
process.env['SV_DATA_DIR'] = TMP;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

(async () => {
  const config = await import('../src/config');
  const { loadQueue } = await import('../src/services/download/persistence');

  await test('getMinDurationSec: defaults to 5 minutes when config.json has no value', () => {
    config.loadConfig();
    assert.equal(config.getMinDurationSec(), 300);
  });

  await test('getMinDurationSec: follows the saved setting, 0 disables the filter', () => {
    config.saveConfig({ minDurationMin: 12 });
    assert.equal(config.getMinDurationSec(), 720);
    assert.equal(JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8')).minDurationMin, 12);
    config.saveConfig({ minDurationMin: 0 });
    assert.equal(config.getMinDurationSec(), 0);
    config.saveConfig({ minDurationMin: 5 });
  });

  await test('loadQueue: replaces stored source titles with the file name', () => {
    fs.writeFileSync(config.QUEUE_PATH, JSON.stringify({
      version: 1,
      order: ['q1', 'q2'],
      items: [
        { id: 'q1', url: 'u1', folder: '', destAbs: '/x', filename: 'a1b2c3', title: 'Original Title',
          uploader: 'Some Channel', groupId: 'g', groupTitle: 'My Playlist', state: 'queued', progress: 0, attempts: 0, createdAt: 1 },
        { id: 'q2', url: 'u2', folder: '', destAbs: '/x', title: 'Another Title', state: 'downloading', progress: 40, attempts: 1, createdAt: 2 },
      ],
    }));
    const { items } = loadQueue();
    assert.equal(items[0].title, 'a1b2c3');
    assert.equal(items[1].title, 'q2', 'falls back to the id when no file name was stored');
    assert.equal(items[1].state, 'queued', 'mid-flight items still resume');
    const raw = JSON.stringify(items);
    for (const leaked of ['Original Title', 'Some Channel', 'My Playlist', 'Another Title']) {
      assert.ok(!raw.includes(leaked), `source name leaked: ${leaked}`);
    }
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
})();
