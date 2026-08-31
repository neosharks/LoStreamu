/* Runnable folder-tree tests — `npx tsx tests/library.test.ts`.
   The tree used to be derived from where videos live, so a folder you had just
   created did not exist as far as the UI was concerned. It is now built from the
   directories on disk, which is what these cover.

   SV_DATA_DIR points at a throwaway directory so the developer's own media is
   never touched. */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-library-'));
process.env['SV_DATA_DIR'] = TMP;

const MEDIA = path.join(TMP, 'media');

function mkdirs(...rel: string[]) {
  for (const r of rel) fs.mkdirSync(path.join(MEDIA, r), { recursive: true });
}
// A one-byte file is skipped as a zero-byte husk, so give the fakes some content.
function mkvideo(rel: string) {
  fs.mkdirSync(path.dirname(path.join(MEDIA, rel)), { recursive: true });
  fs.writeFileSync(path.join(MEDIA, rel), 'x'.repeat(64));
}

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

(async () => {
  const { loadConfig, ensureDataDirs } = await import('../src/config');
  ensureDataDirs();
  loadConfig();
  const lib = await import('../src/services/library');

  mkdirs('Movies/2024', 'Movies/2023', 'Shows', 'Empty/Deeper');
  mkvideo('Movies/2024/first.mp4');
  mkvideo('Movies/2024/second.mkv');
  mkvideo('Shows/pilot.mp4');
  mkvideo('loose.mp4');
  fs.writeFileSync(path.join(MEDIA, 'Movies', 'notes.txt'), 'not a video');
  lib.rescan();

  const tree = lib.buildTree();
  const child = (node: any, name: string) => node.children.find((c: any) => c.name === name);

  test('the scan finds only real video files', () => {
    const names = lib.getLibrary().map(v => v.name).sort();
    assert.deepEqual(names, ['first', 'loose', 'pilot', 'second']);
  });

  test('folders holding no videos still appear in the tree', () => {
    const empty = child(tree, 'Empty');
    assert.ok(empty, 'Empty must be in the tree — you just created it');
    assert.equal(empty.totalCount, 0);
    assert.ok(child(empty, 'Deeper'), 'nested empty folders survive too');
  });

  test('counts roll up from the leaves', () => {
    const movies = child(tree, 'Movies');
    assert.equal(child(movies, '2024').videoCount, 2);
    assert.equal(child(movies, '2023').videoCount, 0);
    assert.equal(movies.videoCount, 0, 'notes.txt is not a video');
    assert.equal(movies.totalCount, 2, 'subfolder videos roll up');
    assert.equal(tree.videoCount, 1, 'loose.mp4 sits at the root');
    assert.equal(tree.totalCount, 4);
  });

  test('children are sorted by name, so the sidebar order is stable', () => {
    assert.deepEqual(tree.children.map((c: any) => c.name), ['Empty', 'Movies', 'Shows']);
    assert.deepEqual(child(tree, 'Movies').children.map((c: any) => c.name), ['2023', '2024']);
  });

  test('listAllFolders reports every directory, slash-separated', () => {
    assert.deepEqual(lib.listAllFolders(), [
      'Empty', 'Empty/Deeper', 'Movies', 'Movies/2023', 'Movies/2024', 'Shows',
    ]);
  });

  test('a folder emptied by a move keeps its place in the tree', () => {
    fs.renameSync(path.join(MEDIA, 'Shows', 'pilot.mp4'), path.join(MEDIA, 'Movies', '2023', 'pilot.mp4'));
    lib.rescan();
    const after = lib.buildTree();
    assert.ok(child(after, 'Shows'), 'Shows must not vanish just because it is empty');
    assert.equal(child(after, 'Shows').totalCount, 0);
    assert.equal(child(child(after, 'Movies'), '2023').videoCount, 1);
  });

  test('video folder paths use forward slashes', () => {
    assert.ok(lib.getLibrary().every(v => !v.folder.includes('\\')));
    assert.deepEqual(
      lib.getLibrary().filter(v => v.name === 'loose').map(v => v.folder),
      [''],
      'a root-level video has an empty folder path',
    );
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
})();
