#!/usr/bin/env bash
# Rebuilds streamvault-app.tar.gz from the app/ directory.
# Run from the repo root after changing app code.
set -euo pipefail
cd "$(dirname "$0")"

OUT="streamvault-app.tar.gz"
SRC="app"

[ -d "$SRC" ] || { echo "Missing ./$SRC directory"; exit 1; }

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
