#!/usr/bin/env bash

# StreamVault v2 — Proxmox VE helper script
# Creates a Debian 12 LXC and runs the app's own install-lxc.sh inside it.
#
# Usage (run in the Proxmox VE host shell):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/thakursat/hosted-video-streamer/refs/heads/main/streamvault.sh)"
#
# Defaults: 2 vCPU, 8 GB RAM, 200 GB disk, unprivileged, DHCP.
# Override any default by exporting a var before running, e.g.:
#   CT_RAM=4096 CT_DISK=100 bash -c "$(curl -fsSL .../streamvault.sh)"

set -euo pipefail

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/thakursat/hosted-video-streamer/refs/heads/main}"
APP_ARCHIVE_URL="${APP_ARCHIVE_URL:-$REPO_RAW/streamvault-app.tar.gz}"

APP="StreamVault"
APP_PORT="8080"

CT_ID="${CT_ID:-}"
CT_HOSTNAME="${CT_HOSTNAME:-streamvault}"
CT_CPU="${CT_CPU:-2}"
CT_RAM="${CT_RAM:-8192}"
CT_DISK="${CT_DISK:-200}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
CT_NET="${CT_NET:-dhcp}"
CT_GW="${CT_GW:-}"
CT_UNPRIVILEGED="${CT_UNPRIVILEGED:-1}"
CT_STORAGE="${CT_STORAGE:-}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
OS_TEMPLATE_PREFIX="debian-12-standard"

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

  v2  ·  TypeScript + React  ·  Proxmox VE LXC installer
EOF
  echo
}

# ── Pre-flight ────────────────────────────────────────────────────────────────

header
[ "$(id -u)" -eq 0 ] || die "Run this on the Proxmox host as root."
command -v pct   >/dev/null 2>&1 || die "pct not found — run this on a Proxmox VE host."
command -v pveam >/dev/null 2>&1 || die "pveam not found — run this on a Proxmox VE host."

if [ -z "$CT_ID" ]; then
  CT_ID="$(pvesh get /cluster/nextid 2>/dev/null || echo 100)"
fi
msg_info "Container ID: ${BL}${CT_ID}${CL}"

if [ -z "$CT_STORAGE" ]; then
  CT_STORAGE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR==2{print $1}')"
  [ -n "$CT_STORAGE" ] || die "No rootdir-capable storage found. Set CT_STORAGE."
fi
msg_ok "Storage: ${BL}${CT_STORAGE}${CL}"

# ── Download OS template ──────────────────────────────────────────────────────

msg_info "Checking for a Debian 12 template..."
pveam update >/dev/null 2>&1 || true
TEMPLATE="$(pveam available --section system 2>/dev/null | awk -v p="$OS_TEMPLATE_PREFIX" '$2 ~ p {print $2}' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "Could not find a $OS_TEMPLATE_PREFIX template via pveam."
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  msg_info "Downloading template $TEMPLATE ..."
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null 2>&1 || die "Template download failed."
fi
TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
msg_ok "Template: ${BL}${TEMPLATE}${CL}"

# ── Create and start LXC ─────────────────────────────────────────────────────

if [ "$CT_NET" = "dhcp" ]; then
  NET0="name=eth0,bridge=${CT_BRIDGE},ip=dhcp"
else
  NET0="name=eth0,bridge=${CT_BRIDGE},ip=${CT_NET}"
  [ -n "$CT_GW" ] && NET0="${NET0},gw=${CT_GW}"
fi

msg_info "Creating LXC ${CT_ID} (${CT_CPU} vCPU · ${CT_RAM} MB RAM · ${CT_DISK} GB disk)..."
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
  --description "StreamVault v2 — TypeScript + React" >/dev/null \
  || die "pct create failed."
msg_ok "Container created"

msg_info "Starting container..."
pct start "$CT_ID" >/dev/null || die "Failed to start container."
msg_info "Waiting for network..."
for i in $(seq 1 30); do
  pct exec "$CT_ID" -- bash -c "getent hosts github.com >/dev/null 2>&1" && break
  sleep 2
done
msg_ok "Container running with network"

# ── Deploy ────────────────────────────────────────────────────────────────────

msg_info "Downloading StreamVault app archive..."
pct exec "$CT_ID" -- bash -c \
  "curl -fsSL '${APP_ARCHIVE_URL}' -o /tmp/sv.tar.gz" \
  || die "Could not download app archive from ${APP_ARCHIVE_URL}"

msg_info "Extracting to /opt/streamvault ..."
pct exec "$CT_ID" -- bash -c \
  "mkdir -p /opt/streamvault && tar -xzf /tmp/sv.tar.gz -C /opt/streamvault && rm -f /tmp/sv.tar.gz" \
  || die "Failed to unpack app archive."

pct exec "$CT_ID" -- bash -c "[ -f /opt/streamvault/install-lxc.sh ]" \
  || die "install-lxc.sh missing from archive — rebuild it with ./build-archive.sh"

# ── Run the installer inside the container ────────────────────────────────────
# install-lxc.sh handles everything: apt packages, Node.js, ffmpeg, yt-dlp,
# npm install, tsc build, React build, prune, service user, systemd service.

msg_info "Running install-lxc.sh inside the container (this takes 3-5 minutes)..."
echo ""
pct exec "$CT_ID" -- bash /opt/streamvault/install-lxc.sh
echo ""

# ── Start the service ─────────────────────────────────────────────────────────

msg_info "Starting StreamVault service..."
pct exec "$CT_ID" -- systemctl start streamvault \
  || die "Service failed to start — check: pct exec ${CT_ID} -- journalctl -u streamvault -n 30"
msg_ok "Service started"

# ── Resolve IP ───────────────────────────────────────────────────────────────

IP=""
for i in $(seq 1 15); do
  IP="$(pct exec "$CT_ID" -- bash -c "hostname -I 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)"
  [ -n "$IP" ] && break
  sleep 2
done

# ── Done ──────────────────────────────────────────────────────────────────────

echo
msg_ok "${GN}StreamVault v2 installation complete!${CL}"
echo
echo -e " ${INFO} Open:   ${GN}http://${IP:-<container-ip>}:${APP_PORT}${CL}"
echo -e " ${INFO} Create your account on the first visit (signup is shown until an account exists)."
echo
echo -e " ${INFO} Forgot password? Reset it from the Proxmox host:"
echo -e "      ${BL}pct exec ${CT_ID} -- bash -c 'cd /opt/streamvault && sudo -u streamvault npm run set-password you@email.com mypassword'${CL}"
echo -e "      ${BL}pct exec ${CT_ID} -- systemctl restart streamvault${CL}"
echo
echo -e " ${INFO} Live logs:  ${BL}pct exec ${CT_ID} -- journalctl -u streamvault -f${CL}"
echo -e " ${INFO} Media dir:  ${BL}/opt/streamvault/media${CL} inside the container"
echo
