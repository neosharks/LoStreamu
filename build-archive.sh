#!/usr/bin/env bash
# Rebuilds streamvault-app.tar.gz from the app/ directory.
# Run from the repo root after changing app code.
set -euo pipefail
cd "$(dirname "$0")"

OUT="streamvault-app.tar.gz"
SRC="app"

[ -d "$SRC" ] || { echo "Missing ./$SRC directory"; exit 1; }

# Bump the patch version on every build so each deploy ships a new version.
# The in-app "update available" check (GET /app/version) compares this against
# the copy on GitHub main. Override the bump with NO_BUMP=1 ./build-archive.sh.
if [ "${NO_BUMP:-0}" != "1" ]; then
  ( cd "$SRC" && npm version patch --no-git-tag-version >/dev/null )
fi
VERSION=$(node -p "require('./$SRC/package.json').version")
echo "Version: $VERSION"

# Pack exactly what is committable, taken from git rather than from a list of
# --exclude patterns. Those patterns are unanchored in both GNU tar and bsdtar,
# so an exclude meant for the app's own data directory also matched source
# directories of the same name (./faces excluded src/services/faces, shipping a
# release that could not build). .gitignore already lists every runtime file, so
# asking git removes that whole class of mistake — and nothing untracked and
# ignored, such as a developer's own library or face index, can ever ship.
#   --cached  : tracked files
#   --others  : new files not yet committed, so a release can be built before the
#               commit lands
#   --exclude-standard : honour .gitignore
git -C "$SRC" ls-files --cached --others --exclude-standard -z \
  | tar -czf "$OUT" --null -T - -C "$SRC"

echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "Entries packed:"
tar -tzf "$OUT" | grep -vE '/[^/]+/' | sed 's/^/  /'
