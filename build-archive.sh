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

tar -czf "$OUT" \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./client/node_modules' \
  --exclude='./client/dist' \
  --exclude='./config.json' \
  --exclude='./secrets.json' \
  --exclude='./meta-cache.json' \
  --exclude='./server.log' \
  --exclude='./cookies.txt' \
  --exclude='./yt-dlp' \
  --exclude='./thumbnails' \
  --exclude='./media' \
  -C "$SRC" .

echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "Entries packed:"
tar -tzf "$OUT" | grep -vE '/[^/]+/' | sed 's/^/  /'
