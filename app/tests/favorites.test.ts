/* Runnable favourites tests — `npx tsx tests/favorites.test.ts` (no framework).
   Stars are stored per profile and keyed by relative path, so the awkward cases
   are the ones where a path changes underneath them: rename, move, repair into a
   new extension, and a move onto a path the profile had already starred.

   SV_DATA_DIR points at a throwaway directory so the developer's own stars are
   never touched. */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-fav-'));
process.env['SV_DATA_DIR'] = TMP;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

(async () => {
  const fav = await import('../src/services/favorites');
  const ALICE = 'user-alice';
  const BOB = 'user-bob';

  await test('setFavorite: stars and unstars for one profile only', () => {
    fav.setFavorite(ALICE, 'Clips/one.mp4', true);
    assert.equal(fav.isFavorite(ALICE, 'Clips/one.mp4'), true);
    assert.equal(fav.isFavorite(BOB, 'Clips/one.mp4'), false);
    fav.setFavorite(ALICE, 'Clips/one.mp4', false);
    assert.equal(fav.isFavorite(ALICE, 'Clips/one.mp4'), false);
  });

  await test('setFavorite: starring twice does not duplicate the entry', () => {
    fav.setFavorite(ALICE, 'Clips/two.mp4', true);
    fav.setFavorite(ALICE, 'Clips/two.mp4', true);
    assert.deepEqual(fav.listFavorites(ALICE).filter(p => p === 'Clips/two.mp4').length, 1);
  });

  await test('rekeyFavorite: a star follows the video through a rename', () => {
    fav.setFavorite(ALICE, 'Clips/three.mkv', true);
    fav.setFavorite(BOB, 'Clips/three.mkv', true);
    fav.rekeyFavorite('Clips/three.mkv', 'Clips/three.mp4');
    for (const user of [ALICE, BOB]) {
      assert.equal(fav.isFavorite(user, 'Clips/three.mp4'), true, user);
      assert.equal(fav.isFavorite(user, 'Clips/three.mkv'), false, user);
    }
  });

  await test('rekeyFavorite: moving onto an already-starred path leaves one entry', () => {
    fav.setFavorite(ALICE, 'A/dup.mp4', true);
    fav.setFavorite(ALICE, 'B/dup.mp4', true);
    fav.rekeyFavorite('A/dup.mp4', 'B/dup.mp4');
    assert.equal(fav.listFavorites(ALICE).filter(p => p === 'B/dup.mp4').length, 1);
    assert.equal(fav.isFavorite(ALICE, 'A/dup.mp4'), false);
  });

  await test('rekeyFavorite: a path nobody starred changes nothing', () => {
    const before = fav.listFavorites(ALICE).length;
    fav.rekeyFavorite('Nowhere/x.mp4', 'Nowhere/y.mp4');
    assert.equal(fav.listFavorites(ALICE).length, before);
  });

  await test('forgetFavorite: a deleted video loses its star everywhere', () => {
    fav.setFavorite(ALICE, 'Clips/gone.mp4', true);
    fav.setFavorite(BOB, 'Clips/gone.mp4', true);
    fav.forgetFavorite('Clips/gone.mp4');
    assert.equal(fav.isFavorite(ALICE, 'Clips/gone.mp4'), false);
    assert.equal(fav.isFavorite(BOB, 'Clips/gone.mp4'), false);
  });

  await test('pruneFavorites: drops stars whose video is no longer on disk', () => {
    fav.setFavorite(ALICE, 'Keep/here.mp4', true);
    fav.setFavorite(ALICE, 'Lost/missing.mp4', true);
    const removed = fav.pruneFavorites(new Set(['Keep/here.mp4']));
    assert.ok(removed >= 1);
    assert.deepEqual(fav.listFavorites(ALICE), ['Keep/here.mp4']);
  });

  await test('stars survive a restart', async () => {
    fav.setFavorite(BOB, 'Clips/persist.mp4', true);
    fav.resetFavoritesCache();
    assert.equal(fav.isFavorite(BOB, 'Clips/persist.mp4'), true);
  });

  console.log(`\n${passed} passed`);
})();
