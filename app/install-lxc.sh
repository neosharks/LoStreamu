#!/usr/bin/env bash
# StreamVault installer for a Debian 12 LXC (run as root inside the container).
# Usage: ./install-lxc.sh
set -euo pipefail

APP_DIR="/opt/streamvault"
SVC_USER="streamvault"

echo "==> Installing system packages (node, ffmpeg, yt-dlp)..."
apt-get update -y
apt-get install -y curl ca-certificates ffmpeg unzip python3
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
# yt-dlp: install the standalone binary (self-updating, no pip needed)
if ! command -v yt-dlp >/dev/null 2>&1; then
  curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  chmod a+rx /usr/local/bin/yt-dlp
fi
echo "    node $(node --version), ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}'), yt-dlp $(yt-dlp --version)"

# This script expects to be run from inside the unpacked streamvault directory,
# OR for the app to already be at $APP_DIR.
if [ -f "./server.js" ] && [ "$(pwd)" != "$APP_DIR" ]; then
  echo "==> Copying app to $APP_DIR ..."
  mkdir -p "$APP_DIR"
  cp -r ./* "$APP_DIR"/
fi

cd "$APP_DIR"

echo "==> Installing node dependencies..."
npm install --omit=dev

echo "==> Creating service user '$SVC_USER'..."
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

# Generate config.json on first run if missing
if [ ! -f "$APP_DIR/config.json" ]; then
  echo "==> Generating initial config.json..."
  node server.js &
  SVPID=$!
  sleep 2
  kill $SVPID 2>/dev/null || true
  wait $SVPID 2>/dev/null || true
fi

mkdir -p "$APP_DIR/media" "$APP_DIR/thumbnails"
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"

echo "==> Installing systemd service..."
cp "$APP_DIR/streamvault.service" /etc/systemd/system/streamvault.service
systemctl daemon-reload
systemctl enable streamvault

echo ""
echo "============================================================"
echo " Almost done. Set your login before starting:"
echo ""
echo "   cd $APP_DIR"
echo "   sudo -u $SVC_USER npm run set-password you@example.com 'your-password'"
echo ""
echo " Then start the service:"
echo "   systemctl start streamvault"
echo "   systemctl status streamvault"
echo ""
echo " Reach it at:  http://<this-LXC-ip>:8080"
echo "============================================================"
