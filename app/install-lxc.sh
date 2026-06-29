#!/usr/bin/env bash
# StreamVault v2 — installer for Debian 12 LXC (run as root inside the container).
#
# Can also be re-run to upgrade an existing install.
# Files already in /opt/streamvault are upgraded in-place; config.json and
# secrets.json are never overwritten.
set -euo pipefail

# Ensure /usr/local/bin is always in PATH — pct exec gives a minimal environment.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

APP_DIR="/opt/streamvault"
SVC_USER="streamvault"
SVC_FILE="/etc/systemd/system/streamvault.service"
LOG_FILE="/var/log/streamvault-install.log"
SECONDS=0

# ── Colour helpers ────────────────────────────────────────────────────────────

BOLD='\033[1m'; DIM='\033[2m'
GREEN='\033[0;32m'; CYAN='\033[0;36m'
YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'

step()   { echo; echo -e "${BOLD}${CYAN}══▶ $*${RESET}"; }
ok()     { echo -e "  ${GREEN}✓${RESET} $*"; }
info()   { echo -e "  ${YELLOW}→${RESET} $*"; }
detail() { echo -e "  ${DIM}  $*${RESET}"; }
err()    { echo -e "  ${RED}✗ $*${RESET}" >&2; }
die()    { err "$*"; echo; echo "  Full log: $LOG_FILE"; exit 1; }

# Run a command and tee its output to both the terminal (with a prefix) and
# the log file. If the command fails, print a clean error and exit.
run() {
  local label="$1"; shift
  echo -e "  ${DIM}$ $*${RESET}"
  if ! "$@" 2>&1 | tee -a "$LOG_FILE" | sed 's/^/    /'; then
    die "'$label' failed — see $LOG_FILE for full output"
  fi
}

# Like run() but only writes to the log (quiet on success, noisy on failure).
run_q() {
  local label="$1"; shift
  if ! "$@" >>"$LOG_FILE" 2>&1; then
    err "'$label' failed — last 20 lines of log:"
    tail -20 "$LOG_FILE" | sed 's/^/    /' >&2
    die "Aborting."
  fi
}

# ── Initialise log ────────────────────────────────────────────────────────────

mkdir -p /var/log
exec > >(tee -a "$LOG_FILE") 2>&1

echo
echo "╔══════════════════════════════════════════════════╗"
echo "║   StreamVault v2  ·  Installer / Upgrader       ║"
echo "╚══════════════════════════════════════════════════╝"
echo "  Date  : $(date)"
echo "  Host  : $(hostname)"
echo "  Log   : $LOG_FILE"
echo

# ── Step 0: Working directory ─────────────────────────────────────────────────
# The archive is extracted to /opt/streamvault and this script lives there.
# If invoked from elsewhere (e.g. a git clone), copy the files first.

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$SRC_DIR" != "$APP_DIR" ]; then
  step "Copying app source from $SRC_DIR → $APP_DIR ..."
  mkdir -p "$APP_DIR"
  rsync -a --delete \
    --exclude=node_modules/ --exclude=dist/ \
    --exclude=client/node_modules/ --exclude=client/dist/ \
    --exclude=config.json --exclude=secrets.json --exclude=meta-cache.json \
    --exclude=media/ --exclude=thumbnails/ --exclude=server.log --exclude=yt-dlp \
    "$SRC_DIR/" "$APP_DIR/"
  COPIED=$(find "$APP_DIR" -not -path '*/node_modules/*' -not -path '*/dist/*' | wc -l)
  ok "$COPIED entries synced to $APP_DIR"
fi

cd "$APP_DIR"
info "Working directory: $(pwd)"

# ── Step 1: apt packages ──────────────────────────────────────────────────────

step "Updating apt package lists..."
apt-get update -y 2>&1 | grep -E "^(Get|Hit|Ign|Err)" | head -20 || true
ok "Package lists updated"

step "Installing system packages: curl, ca-certificates, rsync, ffmpeg, python3, unzip, chromium..."
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  curl ca-certificates rsync ffmpeg python3 unzip chromium 2>&1
ok "System packages installed"

# ── Step 2: Node.js ───────────────────────────────────────────────────────────

step "Checking Node.js..."
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node --version)
  ok "Node.js already installed: $NODE_VER"
  # Upgrade if it's too old (need 18+).
  MAJOR="${NODE_VER//[!0-9.]*/}"; MAJOR="${MAJOR%%.*}"; MAJOR="${MAJOR#v}"
  if [ "${MAJOR:-0}" -lt 18 ]; then
    info "Node.js $NODE_VER is too old (need 18+). Installing Node.js 20..."
    run_q "NodeSource setup" bash -c "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -"
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs 2>&1
    hash -r 2>/dev/null || true
    ok "Node.js upgraded: $(node --version)"
  fi
else
  info "Node.js not found — installing Node.js 20 (NodeSource)..."
  echo "  Downloading NodeSource setup script..."
  curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh
  echo "  Running NodeSource setup (adds apt repo)..."
  bash /tmp/nodesource_setup.sh 2>&1 | grep -v "^$"
  rm -f /tmp/nodesource_setup.sh
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs 2>&1
  hash -r 2>/dev/null || true
  ok "Node.js installed: $(node --version), npm: $(npm --version)"
fi

# ── Step 3: yt-dlp ───────────────────────────────────────────────────────────

step "Installing/updating yt-dlp..."
YTDLP_OLD=""
if command -v yt-dlp >/dev/null 2>&1; then
  YTDLP_OLD="$(yt-dlp --version 2>/dev/null || echo 'unknown')"
  info "Current version: $YTDLP_OLD"
fi
mkdir -p /usr/local/bin
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
hash -r 2>/dev/null || true  # clear bash's command cache
YTDLP_NEW="$(/usr/local/bin/yt-dlp --version)"
if [ "$YTDLP_OLD" = "$YTDLP_NEW" ]; then
  ok "yt-dlp already at latest: $YTDLP_NEW"
else
  ok "yt-dlp updated: ${YTDLP_OLD:-none} → $YTDLP_NEW"
fi

# ── Version table ─────────────────────────────────────────────────────────────

echo
echo "  ┌──────────────────────────────────────────────┐"
printf "  │  node     %-36s│\n" "$(node --version)"
printf "  │  npm      %-36s│\n" "$(npm --version)"
printf "  │  ffmpeg   %-36s│\n" "$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
printf "  │  ffprobe  %-36s│\n" "$(ffprobe -version 2>/dev/null | head -1 | awk '{print $3}')"
printf "  │  yt-dlp   %-36s│\n" "$YTDLP_NEW"
echo "  └──────────────────────────────────────────────┘"

# ── Step 4: Daily yt-dlp auto-update timer ────────────────────────────────────

step "Setting up daily yt-dlp auto-update timer..."
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
systemctl enable --now yt-dlp-update.timer >/dev/null 2>&1 || true
ok "yt-dlp-update.timer enabled (runs daily)"

# ── Step 5: Server npm dependencies ──────────────────────────────────────────

step "Installing server npm dependencies (full — TypeScript compiler needed)..."
info "This may take a minute on first install..."
npm install 2>&1
TOTAL_PKGS=$(ls node_modules 2>/dev/null | wc -l | tr -d ' ')
ok "$TOTAL_PKGS packages installed in node_modules/"

# ── Step 6: Compile TypeScript server ────────────────────────────────────────

step "Compiling TypeScript server → dist/ ..."
npm run build:server 2>&1
JS_COUNT=$(find dist -name '*.js' 2>/dev/null | wc -l | tr -d ' ')
ok "TypeScript compiled: $JS_COUNT .js files in dist/"
info "Entry point: dist/index.js"

# ── Step 7: Build React client ────────────────────────────────────────────────

if [ -d "client" ] && [ -f "client/package.json" ]; then
  step "Installing React client dependencies..."
  cd client
  npm install 2>&1
  CLIENT_PKGS=$(ls node_modules 2>/dev/null | wc -l | tr -d ' ')
  ok "$CLIENT_PKGS packages installed in client/node_modules/"

  step "Building React client (Vite)..."
  npm run build 2>&1
  cd "$APP_DIR"

  BUILT_FILES=$(find client/dist -type f 2>/dev/null | wc -l | tr -d ' ')
  BUILT_SIZE=$(du -sh client/dist 2>/dev/null | cut -f1 || echo '?')
  ok "React client built: $BUILT_FILES files, $BUILT_SIZE in client/dist/"

  step "Removing client/node_modules/ to free disk space..."
  CLIENT_SIZE=$(du -sh client/node_modules 2>/dev/null | cut -f1 || echo '?')
  rm -rf client/node_modules
  ok "Freed ~$CLIENT_SIZE from client/node_modules/"
fi

# ── Step 8: Prune server dev dependencies ────────────────────────────────────

step "Pruning server dev dependencies (TypeScript not needed at runtime)..."
SIZE_BEFORE=$(du -sh node_modules 2>/dev/null | cut -f1 || echo '?')
npm prune --production 2>&1
SIZE_AFTER=$(du -sh node_modules 2>/dev/null | cut -f1 || echo '?')
ok "node_modules pruned: $SIZE_BEFORE → $SIZE_AFTER"

# ── Step 9: Service user ──────────────────────────────────────────────────────

step "Checking service user '$SVC_USER'..."
if id "$SVC_USER" >/dev/null 2>&1; then
  ok "User '$SVC_USER' already exists (uid=$(id -u "$SVC_USER"))"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  ok "System user '$SVC_USER' created (no home, no login shell)"
fi

# Allow the service user to install chromium without a password (needed for in-app updates)
SUDOERS_FILE="/etc/sudoers.d/streamvault"
cat >"$SUDOERS_FILE" <<SUDOERS
streamvault ALL=(ALL) NOPASSWD: /usr/bin/apt-get install -y --no-install-recommends chromium
SUDOERS
chmod 440 "$SUDOERS_FILE"
ok "Sudoers rule written: streamvault can install chromium"

# ── Step 10: Config and directories ──────────────────────────────────────────

step "Setting up config and data directories..."
mkdir -p "$APP_DIR/media" "$APP_DIR/thumbnails"
ok "Directories ready: media/  thumbnails/"

if [ ! -f "$APP_DIR/config.json" ]; then
  cat >"$APP_DIR/config.json" <<JSON
{
  "port": 8080,
  "email": "",
  "passwordHash": "",
  "mediaDir": "$APP_DIR/media"
}
JSON
  ok "Created default config.json  (port 8080, media → $APP_DIR/media)"
else
  ok "config.json already exists — not overwritten"
fi

step "Setting ownership $SVC_USER:$SVC_USER on $APP_DIR ..."
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"
ok "Ownership set"

# ── Step 11: systemd service ──────────────────────────────────────────────────

step "Installing streamvault.service..."
if [ -f "$APP_DIR/streamvault.service" ]; then
  cp "$APP_DIR/streamvault.service" "$SVC_FILE"
  ok "Copied $APP_DIR/streamvault.service → $SVC_FILE"
else
  # Write inline if the file wasn't packed in the archive (shouldn't happen).
  cat >"$SVC_FILE" <<UNIT
[Unit]
Description=StreamVault video streaming server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/dist/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
UNIT
  info "streamvault.service not found in archive — wrote inline fallback"
fi
systemctl daemon-reload
systemctl enable streamvault
ok "streamvault.service enabled"

# Restart if already running (upgrade path).
if systemctl is-active --quiet streamvault 2>/dev/null; then
  step "Restarting running StreamVault service (upgrade)..."
  systemctl restart streamvault
  sleep 2
  if systemctl is-active --quiet streamvault; then
    ok "Service restarted successfully"
    systemctl status streamvault --no-pager -l 2>&1 | head -8 | sed 's/^/    /'
  else
    err "Service failed to restart!"
    journalctl -u streamvault -n 30 --no-pager 2>&1 | sed 's/^/    /'
    die "Check the logs above and fix before starting."
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────

LXC_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<this-container-ip>')"
ELAPSED=$SECONDS

echo
echo -e "${BOLD}${GREEN}"
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║       StreamVault v2  —  Install complete  ✓     ║"
echo "  ╠═══════════════════════════════════════════════════╣"
printf "  ║  Time   : %-40s║\n" "${ELAPSED}s"
printf "  ║  App dir: %-40s║\n" "$APP_DIR"
printf "  ║  Log    : %-40s║\n" "$LOG_FILE"
echo "  ╠═══════════════════════════════════════════════════╣"
printf "  ║  URL    : http://%-33s║\n" "${LXC_IP}:8080"
echo "  ╚═══════════════════════════════════════════════════╝"
echo -e "${RESET}"
echo "  Next steps:"
echo "    systemctl start streamvault"
echo "    systemctl status streamvault"
echo "    journalctl -u streamvault -f      # live logs"
echo
echo "  Open http://${LXC_IP}:8080 — you will be prompted to create"
echo "  your account on the first visit."
echo
echo "  Full install log saved to: $LOG_FILE"
echo
