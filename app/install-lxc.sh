#!/usr/bin/env bash
# StreamVault v2 installer for a Debian 12 LXC (run as root inside the container).
set -euo pipefail

APP_DIR="/opt/streamvault"
SVC_USER="streamvault"

echo "==> Installing system packages (node 20, ffmpeg, yt-dlp)..."
apt-get update -y
apt-get install -y curl ca-certificates ffmpeg unzip python3
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
# Always fetch the latest yt-dlp so re-running the script upgrades it.
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
echo "    node $(node --version), ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}'), yt-dlp $(yt-dlp --version)"

# Keep yt-dlp current with a daily systemd timer.
echo "==> Scheduling daily yt-dlp updates..."
cat >/etc/systemd/system/yt-dlp-update.service <<'UNIT'
[Unit]
Description=Update yt-dlp to latest release
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/yt-dlp -U
UNIT
cat >/etc/systemd/system/yt-dlp-update.timer <<'UNIT'
[Unit]
Description=Daily yt-dlp self-update
[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now yt-dlp-update.timer || true

# Copy app files if running from an unpacked tarball/clone directory.
if [ -f "./package.json" ] && [ "$(pwd)" != "$APP_DIR" ]; then
  echo "==> Copying app to $APP_DIR ..."
  mkdir -p "$APP_DIR"
  cp -r ./* "$APP_DIR"/
fi

cd "$APP_DIR"

echo "==> Installing server dependencies (including build tools)..."
# Full install needed so TypeScript compiler (tsc) is available for the build.
npm install

echo "==> Building TypeScript server..."
npm run build:server

echo "==> Building React client..."
if [ -d "client" ]; then
  cd client
  npm install
  npm run build
  cd "$APP_DIR"
  # Remove client node_modules — only the built dist/ is needed at runtime.
  rm -rf client/node_modules
fi

echo "==> Pruning server dev dependencies (tsc no longer needed at runtime)..."
npm prune --production

echo "==> Creating service user '$SVC_USER'..."
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

echo "==> Generating secrets and initial config..."
# Secrets are generated automatically by the server on first start.
# Seed a default config if none exists.
if [ ! -f "$APP_DIR/config.json" ]; then
  cat >"$APP_DIR/config.json" <<JSON
{
  "port": 8080,
  "email": "",
  "passwordHash": "",
  "mediaDir": "$APP_DIR/media"
}
JSON
fi

mkdir -p "$APP_DIR/media" "$APP_DIR/thumbnails"
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"

echo "==> Installing systemd service..."
cp "$APP_DIR/streamvault.service" /etc/systemd/system/streamvault.service
systemctl daemon-reload
systemctl enable streamvault

# Restart if already running (upgrade path); otherwise user starts manually.
if systemctl is-active --quiet streamvault 2>/dev/null; then
  echo "==> Restarting StreamVault service..."
  systemctl restart streamvault
fi

echo ""
echo "============================================================"
echo " StreamVault v2 installed!"
echo ""
echo " Start:  systemctl start streamvault"
echo " Status: systemctl status streamvault"
echo ""
echo " Open http://<this-LXC-ip>:8080 and create your account"
echo " on the first visit (signup screen shows until an account"
echo " exists and is then locked)."
echo "============================================================"
