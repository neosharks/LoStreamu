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
  --exclude='./config.json' \
  --exclude='./secrets.json' \
  --exclude='./server.log' \
  --exclude='./cookies.txt' \
  --exclude='./.git' \
  -C "$SRC" .

echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo "Top-level entries:"
tar -tzf "$OUT" | grep -vE '/.+/' | sed 's/^/  /'
