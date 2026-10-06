/* Runnable auth tests — `npx tsx tests/auth.test.ts` (no framework).
   Covers the PIN-login rules that have no HTTP surface of their own: the PIN
   policy, the failed-attempt lockout curve, trusted-device matching, and the
   legacy-layout migration that moves a pre-split install's data into DATA_DIR,
   and the boot cleanup that deletes what the removed face scanner left behind.

   SV_DATA_DIR is set before importing the app so the whole suite reads and
   writes a throwaway directory, never the developer's real data. */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-auth-'));
process.env['SV_DATA_DIR'] = TMP;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name, '\n  ', (e as Error).message); process.exitCode = 1; }
}

(async () => {
  const users = await import('../src/services/users');
  const config = await import('../src/config');

  await test('validatePin: accepts a plain 6-digit PIN', () => {
    assert.equal(users.validatePin('407912'), null);
    assert.equal(users.validatePin('900318'), null);
  });

  await test('validatePin: rejects anything that is not exactly 6 digits', () => {
    for (const bad of ['12345', '1234567', '12a456', '', '  1234', null, 123456]) {
      assert.ok(users.validatePin(bad as unknown), `expected rejection: ${String(bad)}`);
    }
  });

  await test('validatePin: rejects repeated and consecutive runs', () => {
    for (const weak of ['111111', '000000', '123456', '456789', '654321', '987654']) {
      assert.ok(users.validatePin(weak), `expected rejection: ${weak}`);
    }
    // A run that only *starts* like a sequence is still fine.
    assert.equal(users.validatePin('123459'), null);
  });

  await test('lockDuration: first misses are free, then the window doubles to a cap', () => {
    assert.equal(users.lockDuration(1), 0);
    assert.equal(users.lockDuration(4), 0);
    assert.equal(users.lockDuration(5), 30_000);
    assert.equal(users.lockDuration(6), 60_000);
    assert.equal(users.lockDuration(7), 120_000);
    assert.equal(users.lockDuration(20), 15 * 60_000, 'capped at 15 minutes');
  });

  await test('createUser + verifyPin: the PIN is hashed, not stored', async () => {
    const user = await users.createUser({ name: 'Ada', email: 'Ada@Example.COM', pin: '407912', isAdmin: true });
    assert.ok(user.pinHash.startsWith('$2'), 'expected a bcrypt hash');
    assert.ok(!user.pinHash.includes('407912'));
    assert.equal(user.email, 'ada@example.com', 'email is normalised to lowercase');
    assert.equal(await users.verifyPin(user, '407912'), true);
    assert.equal(await users.verifyPin(user, '407913'), false);
  });

  await test('hasAccounts + findUserByEmail: lookups are case-insensitive', () => {
    assert.equal(users.hasAccounts(), true);
    assert.ok(users.findUserByEmail('ADA@EXAMPLE.com'));
    assert.equal(users.findUserByEmail('nobody@example.com'), undefined);
  });

  await test('accounts persist to DATA_DIR, not the app tree', () => {
    const stored = JSON.parse(fs.readFileSync(path.join(TMP, 'users.json'), 'utf8'));
    assert.equal(stored.version, 2);
    assert.equal(stored.users.length, 1);
    assert.equal(config.USERS_PATH, path.join(TMP, 'users.json'));
  });

  await test('recordFailure locks the account, clearFailures releases it', () => {
    const user = users.findUserByEmail('ada@example.com')!;
    for (let i = 0; i < 4; i++) users.recordFailure(user);
    assert.equal(users.lockRemaining(user), 0, '4 misses must not lock');
    const retryAfter = users.recordFailure(user);
    assert.ok(retryAfter > 0 && retryAfter <= 30, `expected a ~30s lock, got ${retryAfter}`);
    assert.ok(users.lockRemaining(user) > 0);
    users.clearFailures(user);
    assert.equal(users.lockRemaining(user), 0);
    assert.equal(user.failedAttempts, 0);
  });

  await test('trustDevice: raw token stays out of the store, only its hash is kept', () => {
    const user = users.findUserByEmail('ada@example.com')!;
    const token = users.trustDevice(user, 'Mozilla/5.0 (Macintosh) Safari/605');
    assert.equal(user.devices.length, 1);
    assert.equal(user.devices[0]!.hash, users.hashDeviceToken(token));
    assert.ok(!JSON.stringify(user.devices).includes(token), 'raw token must never be persisted');
    assert.equal(users.isTrustedDevice(user, token), true);
    assert.equal(users.isTrustedDevice(user, 'some-other-token'), false);
    assert.equal(users.isTrustedDevice(user, undefined), false, 'a browser with no cookie is untrusted');
  });

  await test('forgetDevices: every browser drops back to email + PIN', () => {
    const user = users.findUserByEmail('ada@example.com')!;
    const token = users.trustDevice(user, 'curl/8');
    users.forgetDevices(user);
    assert.equal(user.devices.length, 0);
    assert.equal(users.isTrustedDevice(user, token), false);
  });

  await test('profileCard: the login screen never sees emails or PIN state', () => {
    const user = users.findUserByEmail('ada@example.com')!;
    const card = users.profileCard(user, undefined);
    const keys = Object.keys(card).sort();
    assert.deepEqual(keys, ['avatar', 'id', 'isAdmin', 'lockedFor', 'name', 'needsEmail']);
    assert.equal(card.needsEmail, true, 'an unknown browser must be asked for the email');
    assert.ok(!JSON.stringify(card).includes('example.com'));
    assert.ok(!JSON.stringify(card).includes('$2'));
  });

  await test('migrateLegacyData: pre-split files move into the data dir and merge folders', () => {
    // Stage a fake legacy install — a throwaway app tree, never the real one:
    // migrateLegacyData() *moves* files, so pointing it at APP_DIR would carry
    // the developer's own media and config away.
    const legacyApp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-legacy-'));
    fs.writeFileSync(path.join(legacyApp, 'config.json'), JSON.stringify({ port: 8080, mediaDir: path.join(legacyApp, 'media') }));
    fs.mkdirSync(path.join(legacyApp, 'media', 'films'), { recursive: true });
    fs.writeFileSync(path.join(legacyApp, 'media', 'films', 'old.mp4'), 'x');
    // The target media dir already exists (the installer creates it), which must
    // not stop the old contents from coming across.
    fs.mkdirSync(path.join(TMP, 'media'), { recursive: true });

    try {
      const moved = config.migrateLegacyData(legacyApp);
      assert.ok(moved.includes('media'), `expected media to migrate, got ${moved.join(',')}`);
      assert.ok(moved.includes('config.json'), 'config.json migrates too');
      assert.ok(fs.existsSync(path.join(TMP, 'media', 'films', 'old.mp4')), 'video moved into DATA_DIR');
      assert.ok(!fs.existsSync(path.join(legacyApp, 'media', 'films', 'old.mp4')), 'video no longer in the app tree');
      const migratedCfg = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'));
      assert.equal(migratedCfg.mediaDir, path.join(TMP, 'media'), 'mediaDir repointed at the data dir');
    } finally {
      fs.rmSync(legacyApp, { recursive: true, force: true });
    }
  });

  await test('removeFaceData: face index, crops and models go; everything else stays', () => {
    // A throwaway app tree again — the real one may hold a developer's own
    // face data, and this deletes it.
    const legacyApp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-legacy-'));
    for (const dir of [TMP, legacyApp]) {
      fs.writeFileSync(path.join(dir, 'faces.json'), '{}');
      fs.mkdirSync(path.join(dir, 'faces'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'faces', 'abcdef12.jpg'), 'x');
      fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'models', 'large-recognition.onnx'), 'x');
    }
    fs.writeFileSync(path.join(TMP, 'favorites.json'), '{}');
    // Same-named source directories must survive: only top-level entries go.
    fs.mkdirSync(path.join(legacyApp, 'src', 'faces'), { recursive: true });

    try {
      const removed = config.removeFaceData([TMP, legacyApp]);
      assert.equal(removed.length, 6, `expected 6 removals, got ${removed.join(',')}`);
      for (const dir of [TMP, legacyApp]) {
        for (const name of ['faces.json', 'faces', 'models']) {
          assert.ok(!fs.existsSync(path.join(dir, name)), `${name} left in ${dir}`);
        }
      }
      assert.ok(fs.existsSync(path.join(TMP, 'favorites.json')), 'unrelated data was deleted');
      assert.ok(fs.existsSync(path.join(TMP, 'media', 'films', 'old.mp4')), 'media was deleted');
      assert.ok(fs.existsSync(path.join(legacyApp, 'src', 'faces')), 'a nested faces/ was deleted');
      assert.deepEqual(config.removeFaceData([TMP, legacyApp]), [], 'a second boot has nothing to remove');
    } finally {
      fs.rmSync(legacyApp, { recursive: true, force: true });
    }
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
})();
