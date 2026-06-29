#!/usr/bin/env bash

# StreamVault — Proxmox VE helper script
# Creates a Debian 12 LXC, installs Node.js + ffmpeg + yt-dlp, deploys
# StreamVault, and starts it as a systemd service.
#
# Usage (run in the Proxmox VE host shell):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/thakursat/hosted-video-streamer/main/streamvault.sh)"
#
# Defaults: 2 vCPU, 8 GB RAM, 200 GB disk, unprivileged, DHCP.
# Override any default by exporting a var before running, e.g.:
#   CT_RAM=4096 CT_DISK=100 bash -c "$(curl -fsSL .../streamvault.sh)"

set -euo pipefail

# ---- EDIT THIS after you push to GitHub -----------------------------------
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/thakursat/hosted-video-streamer/main}"
APP_ARCHIVE_URL="${APP_ARCHIVE_URL:-$REPO_RAW/streamvault-app.tar.gz}"
# ---------------------------------------------------------------------------

APP="StreamVault"
APP_PORT="8080"

# ---- Configurable defaults (override via environment) ----------------------
CT_ID="${CT_ID:-}"                       # auto-picked if empty
CT_HOSTNAME="${CT_HOSTNAME:-streamvault}"
CT_CPU="${CT_CPU:-2}"
CT_RAM="${CT_RAM:-8192}"                  # MB  -> 8 GB
CT_DISK="${CT_DISK:-200}"                 # GB  -> 200 GB
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
CT_NET="${CT_NET:-dhcp}"                  # 'dhcp' or e.g. 192.168.1.50/24
CT_GW="${CT_GW:-}"                        # gateway when using a static IP
CT_UNPRIVILEGED="${CT_UNPRIVILEGED:-1}"
CT_STORAGE="${CT_STORAGE:-}"             # auto-detected if empty
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
OS_TEMPLATE_PREFIX="debian-12-standard"

# ---- Pretty output ---------------------------------------------------------
RD=$'\033[01;31m'; GN=$'\033[1;92m'; YW=$'\033[33m'; BL=$'\033[36m'; CL=$'\033[m'
CM="${GN}✓${CL}"; CROSS="${RD}✗${CL}"; INFO="${BL}ℹ${CL}"
msg_info() { echo -e " ${YW}➤${CL} $1"; }
msg_ok()   { echo -e " ${CM} $1"; }
msg_err()  { echo -e " ${CROSS} ${RD}$1${CL}"; }
die()      { msg_err "$1"; exit 1; }

header() {
  clear
  cat <<'EOF'
   ____  _                            __     __          _ _
  / ___|| |_ _ __ ___  __ _ _ __ ___  \ \   / /_ _ _   _| | |_
  \___ \| __| '__/ _ \/ _` | '_ ` _ \  \ \ / / _` | | | | | __|
   ___) | |_| | |  __/ (_| | | | | | |  \ V / (_| | |_| | | |_
  |____/ \__|_|  \___|\__,_|_| |_| |_|   \_/ \__,_|\__,_|_|\__|

  Self-hosted, auth-gated video streaming  ·  Proxmox VE LXC installer
EOF
  echo
}

# ---- Pre-flight ------------------------------------------------------------
header
[ "$(id -u)" -eq 0 ] || die "Run this on the Proxmox host as root."
command -v pct >/dev/null 2>&1 || die "pct not found — this must run on a Proxmox VE host."
command -v pveam >/dev/null 2>&1 || die "pveam not found — this must run on a Proxmox VE host."

# Pick a free CT ID if none given.
if [ -z "$CT_ID" ]; then
  CT_ID="$(pvesh get /cluster/nextid 2>/dev/null || echo 100)"
fi
msg_info "Using container ID ${BL}${CT_ID}${CL}"

# Auto-detect a storage that supports rootdir if not specified.
if [ -z "$CT_STORAGE" ]; then
  CT_STORAGE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR==2{print $1}')"
  [ -n "$CT_STORAGE" ] || die "No storage supporting container rootfs found. Set CT_STORAGE."
fi
msg_ok "Container storage: ${BL}${CT_STORAGE}${CL}"

# ---- Ensure OS template -----------------------------------------------------
msg_info "Checking for a Debian 12 template"
pveam update >/dev/null 2>&1 || true
TEMPLATE="$(pveam available --section system 2>/dev/null | awk -v p="$OS_TEMPLATE_PREFIX" '$2 ~ p {print $2}' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "Could not find a $OS_TEMPLATE_PREFIX template via pveam."
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  msg_info "Downloading template $TEMPLATE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null 2>&1 || die "Template download failed."
fi
TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
msg_ok "Template ready: ${BL}${TEMPLATE}${CL}"

# ---- Build network argument -------------------------------------------------
if [ "$CT_NET" = "dhcp" ]; then
  NET0="name=eth0,bridge=${CT_BRIDGE},ip=dhcp"
else
  NET0="name=eth0,bridge=${CT_BRIDGE},ip=${CT_NET}"
  [ -n "$CT_GW" ] && NET0="${NET0},gw=${CT_GW}"
fi

# ---- Create container -------------------------------------------------------
msg_info "Creating LXC ${CT_ID} (${CT_CPU} vCPU, ${CT_RAM} MB RAM, ${CT_DISK} GB disk)"
pct create "$CT_ID" "$TEMPLATE_REF" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CT_CPU" \
  --memory "$CT_RAM" \
  --swap 512 \
  --rootfs "${CT_STORAGE}:${CT_DISK}" \
  --net0 "$NET0" \
  --unprivileged "$CT_UNPRIVILEGED" \
  --features nesting=1 \
  --onboot 1 \
  --description "StreamVault — deployed via helper script" >/dev/null \
  || die "pct create failed."
msg_ok "Container created"

msg_info "Starting container"
pct start "$CT_ID" >/dev/null || die "Failed to start container."
# Wait for network inside the container.
for i in $(seq 1 30); do
  pct exec "$CT_ID" -- bash -c "getent hosts deb.nodesource.com >/dev/null 2>&1" && break
  sleep 2
done
msg_ok "Container running"

# ---- Provision inside the container ----------------------------------------
run() { pct exec "$CT_ID" -- bash -c "$1"; }

msg_info "Installing base packages (this takes a few minutes)"
run "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl ca-certificates ffmpeg unzip tar >/dev/null" \
  || die "apt install failed."
msg_ok "Base packages installed"

msg_info "Installing Node.js 20 LTS"
run "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null" \
  || die "Node.js install failed."
msg_ok "Node.js installed"

msg_info "Installing yt-dlp"
run "curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp" \
  || die "yt-dlp install failed."
msg_ok "yt-dlp installed"

msg_info "Deploying StreamVault"
run "mkdir -p /opt/streamvault && curl -fsSL '${APP_ARCHIVE_URL}' -o /tmp/sv.tar.gz" \
  || die "Could not download app archive from ${APP_ARCHIVE_URL}"
# The archive packs the app files at its root, so extract straight into place.
run "tar -xzf /tmp/sv.tar.gz -C /opt/streamvault && rm -f /tmp/sv.tar.gz" \
  || die "Failed to unpack app archive."
run "[ -f /opt/streamvault/package.json ]" \
  || die "Archive did not contain package.json — check APP_ARCHIVE_URL."
run "cd /opt/streamvault && npm install --omit=dev --no-fund --no-audit >/dev/null 2>&1" \
  || die "npm install failed."
msg_ok "StreamVault deployed"

msg_info "Creating service user and systemd unit"
run "id streamvault >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin streamvault"
# Generate config.json on first run, then chown.
run "cd /opt/streamvault && (node server.js & SV=\$!; sleep 2; kill \$SV 2>/dev/null; wait \$SV 2>/dev/null; true)"
run "mkdir -p /opt/streamvault/media /opt/streamvault/thumbnails && chown -R streamvault:streamvault /opt/streamvault"
run "install -m 0644 /opt/streamvault/streamvault.service /etc/systemd/system/streamvault.service 2>/dev/null || true"
# If the unit isn't bundled, write one.
run "test -f /etc/systemd/system/streamvault.service || cat >/etc/systemd/system/streamvault.service <<'UNIT'
[Unit]
Description=StreamVault video streaming server
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=streamvault
Group=streamvault
WorkingDirectory=/opt/streamvault
ExecStart=/usr/bin/node /opt/streamvault/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT"
run "systemctl daemon-reload && systemctl enable --now streamvault >/dev/null 2>&1" \
  || die "Failed to start the service."
msg_ok "Service enabled and started"

# ---- Resolve IP -------------------------------------------------------------
IP=""
for i in $(seq 1 15); do
  IP="$(pct exec "$CT_ID" -- bash -c "hostname -I 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)"
  [ -n "$IP" ] && break
  sleep 2
done

# ---- Done -------------------------------------------------------------------
echo
msg_ok "${GN}${APP} installation complete!${CL}"
echo
echo -e " ${INFO} Access it at:  ${GN}http://${IP:-<container-ip>}:${APP_PORT}${CL}"
echo
echo -e " ${INFO} Default login: ${YW}admin@local${CL} / ${YW}changeme${CL}"
echo -e " ${INFO} ${RD}Change it now${CL} from the host:"
echo -e "      ${BL}pct exec ${CT_ID} -- bash -c \"cd /opt/streamvault && sudo -u streamvault npm run set-password you@example.com 'your-password'\"${CL}"
echo -e "      ${BL}pct exec ${CT_ID} -- systemctl restart streamvault${CL}"
echo
echo -e " ${INFO} Media is stored inside the container at ${BL}/opt/streamvault/media${CL}."
echo -e "      Use the in-app ${YW}+ Add videos${CL} button to download by link, or drop files in and Rescan."
echo
