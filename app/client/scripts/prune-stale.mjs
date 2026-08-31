// Removes source files that earlier releases shipped and this one no longer has.
//
// The in-app updater unpacks a tarball over the existing install, and tar only
// ever adds files. A component deleted upstream therefore survives on disk, and
// `tsc -b` type-checks everything under src/ — so one orphan importing a removed
// API fails the whole client build, which is exactly what broke the 2.3 → 2.4
// update. Running as npm's `prebuild` means even an *old* updater picks this up,
// because it builds with the new package.json that came out of the tarball.
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REMOVED = [
  // 2.4.0 — password login replaced by PIN profiles. Both of these called
  // authApi.changePassword, which no longer exists.
  'src/components/AccountModal.tsx',
  'src/components/StatsModal.tsx',
];

for (const rel of REMOVED) {
  const abs = join(clientRoot, rel);
  if (!existsSync(abs)) continue;
  rmSync(abs, { force: true });
  console.log(`prune-stale: removed ${rel}`);
}
