#!/usr/bin/env bash

# StreamVault v2 — Proxmox VE LXC installer
#
# Creates a Debian 12 LXC, downloads the StreamVault app archive, and
# runs install-lxc.sh inside the container.  All installer output streams
# live to your terminal.
#
# Usage (run on the Proxmox VE host as root):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/thakursat/hosted-video-streamer/refs/heads/main/streamvault.sh)"
#
# Defaults: 2 vCPU · 8 GB RAM · 200 GB disk · unprivileged · DHCP
# Override any default:
#   CT_RAM=4096 CT_DISK=100 bash -c "$(curl -fsSL .../streamvault.sh)"

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/thakursat/hosted-video-streamer/refs/heads/main}"
APP_ARCHIVE_URL="${APP_ARCHIVE_URL:-$REPO_RAW/streamvault-app.tar.gz}"
APP_PORT="8080"

CT_ID="${CT_ID:-}"
CT_HOSTNAME="${CT_HOSTNAME:-streamvault}"
CT_CPU="${CT_CPU:-4}"
CT_RAM="${CT_RAM:-8192}"
CT_DISK="${CT_DISK:-200}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
CT_NET="${CT_NET:-dhcp}"
CT_GW="${CT_GW:-}"
CT_UNPRIVILEGED="${CT_UNPRIVILEGED:-1}"
CT_STORAGE="${CT_STORAGE:-}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
OS_TEMPLATE_PREFIX="debian-12-standard"

# ── Colours ───────────────────────────────────────────────────────────────────

RD=$'\033[01;31m'; GN=$'\033[1;92m'; YW=$'\033[33m'
BL=$'\033[36m'; DIM=$'\033[2m'; CL=$'\033[m'
CM="${GN}✓${CL}"; CROSS="${RD}✗${CL}"; INFO="${BL}ℹ${CL}"

msg_info()  { echo -e " ${YW}▸${CL} $1"; }
msg_ok()    { echo -e " ${CM} $1"; }
msg_err()   { echo -e " ${CROSS} ${RD}$1${CL}" >&2; }
msg_detail(){ echo -e " ${DIM}   $1${CL}"; }
die() {
  msg_err "$1"
  echo
  echo -e " ${RD}Installation failed.${CL} To debug:"
  echo -e "   pct exec ${CT_ID:-<CTID>} -- journalctl -u streamvault -n 50 --no-pager"
  echo -e "   pct exec ${CT_ID:-<CTID>} -- cat /var/log/streamvault-install.log"
  exit 1
}

# ── Header ────────────────────────────────────────────────────────────────────

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

# ── Pre-flight ────────────────────────────────────────────────────────────────

[ "$(id -u)" -eq 0 ]                  || die "Run this script as root on the Proxmox host."
command -v pct   >/dev/null 2>&1       || die "pct not found — this must run on a Proxmox VE host."
command -v pveam >/dev/null 2>&1       || die "pveam not found — this must run on a Proxmox VE host."
command -v pvesh >/dev/null 2>&1       || die "pvesh not found — this must run on a Proxmox VE host."

msg_info "Proxmox pre-flight checks passed"

if [ -z "$CT_ID" ]; then
  CT_ID="$(pvesh get /cluster/nextid 2>/dev/null)" || die "Could not get next container ID from pvesh"
fi
msg_ok "Container ID: ${BL}${CT_ID}${CL}"

if [ -z "$CT_STORAGE" ]; then
  CT_STORAGE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR==2{print $1}')"
  [ -n "$CT_STORAGE" ] || die "No rootdir-capable storage found — set CT_STORAGE manually."
fi
msg_ok "Storage: ${BL}${CT_STORAGE}${CL}"

# ── OS template ───────────────────────────────────────────────────────────────

msg_info "Syncing available OS templates..."
pveam update >/dev/null 2>&1 || true

TEMPLATE="$(pveam available --section system 2>/dev/null \
  | awk -v p="$OS_TEMPLATE_PREFIX" '$2 ~ p {print $2}' \
  | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "Could not find a ${OS_TEMPLATE_PREFIX} template — check internet access on the Proxmox host."

if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  msg_info "Downloading OS template: ${TEMPLATE} ..."
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" 2>&1 \
    | grep -v "^$" || true
  pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE" \
    || die "Template download failed — check disk space on $TEMPLATE_STORAGE."
  msg_ok "Template downloaded"
else
  msg_ok "Template already local: ${BL}${TEMPLATE}${CL}"
fi
TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"

# ── Create container ──────────────────────────────────────────────────────────

if [ "$CT_NET" = "dhcp" ]; then
  NET0="name=eth0,bridge=${CT_BRIDGE},ip=dhcp"
else
  NET0="name=eth0,bridge=${CT_BRIDGE},ip=${CT_NET}"
  [ -n "$CT_GW" ] && NET0="${NET0},gw=${CT_GW}"
fi

echo
msg_info "Creating LXC container ${CT_ID}..."
msg_detail "Hostname : $CT_HOSTNAME"
msg_detail "vCPU     : $CT_CPU"
msg_detail "RAM      : ${CT_RAM} MB"
msg_detail "Disk     : ${CT_DISK} GB on ${CT_STORAGE}"
msg_detail "Network  : ${CT_NET} on ${CT_BRIDGE}"

pct create "$CT_ID" "$TEMPLATE_REF" \
  --hostname   "$CT_HOSTNAME" \
  --cores      "$CT_CPU" \
  --memory     "$CT_RAM" \
  --swap       512 \
  --rootfs     "${CT_STORAGE}:${CT_DISK}" \
  --net0       "$NET0" \
  --unprivileged "$CT_UNPRIVILEGED" \
  --features   nesting=1 \
  --onboot     1 \
  --description "StreamVault v2 — TypeScript + React" \
  || die "pct create failed — check storage space and template path."
msg_ok "Container created"

msg_info "Starting container..."
pct start "$CT_ID" || die "pct start failed — check host resources."

msg_info "Waiting for network inside container (up to 60s)..."
WAIT=0
while [ "$WAIT" -lt 60 ]; do
  if pct exec "$CT_ID" -- bash -c "getent hosts github.com >/dev/null 2>&1"; then
    break
  fi
  sleep 2; WAIT=$((WAIT + 2))
done
if [ "$WAIT" -ge 60 ]; then
  die "Container has no internet after 60s — check bridge ($CT_BRIDGE) and DHCP."
fi
msg_ok "Container is online (DNS resolves github.com)"

# ── Bootstrap inside container ────────────────────────────────────────────────

echo
msg_info "Bootstrapping container (curl, rsync, initial packages)..."
pct exec "$CT_ID" -- bash -c \
  "apt-get update -y -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl rsync ca-certificates 2>&1 | grep -E '^(Get:|Inst|Setting up)' || true" \
  || die "Failed to install bootstrap packages in container."
msg_ok "Bootstrap packages installed"

# ── Download app archive ──────────────────────────────────────────────────────

echo
msg_info "Downloading StreamVault app archive..."
msg_detail "Source: $APP_ARCHIVE_URL"
pct exec "$CT_ID" -- bash -c \
  "curl -fL --retry 3 --retry-delay 5 --progress-bar '${APP_ARCHIVE_URL}' -o /tmp/sv.tar.gz" \
  || die "Could not download app archive from ${APP_ARCHIVE_URL}
  Check: is the archive committed and pushed to GitHub?
  Or set APP_ARCHIVE_URL to an accessible URL."

ARCHIVE_SIZE="$(pct exec "$CT_ID" -- bash -c "du -sh /tmp/sv.tar.gz | cut -f1" 2>/dev/null || echo '?')"
msg_ok "Archive downloaded (${ARCHIVE_SIZE})"

msg_info "Extracting to /opt/streamvault ..."
pct exec "$CT_ID" -- bash -c \
  "mkdir -p /opt/streamvault && tar -xzf /tmp/sv.tar.gz -C /opt/streamvault && rm -f /tmp/sv.tar.gz" \
  || die "Failed to extract archive."

FILE_COUNT="$(pct exec "$CT_ID" -- bash -c "find /opt/streamvault -not -path '*/node_modules/*' -type f | wc -l" 2>/dev/null || echo '?')"
msg_ok "Extracted ($FILE_COUNT files in /opt/streamvault)"

pct exec "$CT_ID" -- bash -c "[ -f /opt/streamvault/install-lxc.sh ]" \
  || die "install-lxc.sh not found after extraction.  Rebuild the archive with: ./build-archive.sh"
pct exec "$CT_ID" -- bash -c "[ -f /opt/streamvault/package.json ]" \
  || die "package.json not found — archive contents look wrong."

# ── Run the installer ─────────────────────────────────────────────────────────

echo
echo -e " ${YW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CL}"
echo -e " ${YW}  Running install-lxc.sh inside the container (3-6 minutes)       ${CL}"
echo -e " ${YW}  All output streams live below — do not interrupt                ${CL}"
echo -e " ${YW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CL}"
echo

pct exec "$CT_ID" -- bash /opt/streamvault/install-lxc.sh \
  || {
    echo
    msg_err "install-lxc.sh failed!"
    echo -e " ${RD}Last 40 lines of install log:${CL}"
    pct exec "$CT_ID" -- bash -c "tail -40 /var/log/streamvault-install.log 2>/dev/null || echo '(no log found)'" | sed 's/^/   /'
    echo
    die "Fix the error above then re-run:  pct exec ${CT_ID} -- bash /opt/streamvault/install-lxc.sh"
  }

echo
echo -e " ${YW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${CL}"
echo

# ── Start the service ─────────────────────────────────────────────────────────

msg_info "Starting StreamVault service..."
pct exec "$CT_ID" -- systemctl start streamvault \
  || {
    msg_err "Service failed to start!"
    echo -e " ${RD}Last 30 lines of service log:${CL}"
    pct exec "$CT_ID" -- bash -c "journalctl -u streamvault -n 30 --no-pager 2>/dev/null" | sed 's/^/   /'
    die "Fix the error above, then:  pct exec ${CT_ID} -- systemctl start streamvault"
  }

sleep 2
if pct exec "$CT_ID" -- systemctl is-active --quiet streamvault 2>/dev/null; then
  msg_ok "StreamVault service is running"
else
  pct exec "$CT_ID" -- bash -c "journalctl -u streamvault -n 20 --no-pager 2>/dev/null" | sed 's/^/   /'
  die "Service started but is not active — check the logs above."
fi

# ── Get container IP ──────────────────────────────────────────────────────────

IP=""
for i in $(seq 1 20); do
  IP="$(pct exec "$CT_ID" -- bash -c "hostname -I 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)"
  [ -n "$IP" ] && break
  sleep 2
done

# ── Done ──────────────────────────────────────────────────────────────────────

echo
echo -e "${GN}"
echo "  ╔════════════════════════════════════════════════════════════╗"
echo "  ║          StreamVault v2  —  Installation complete  ✓      ║"
echo "  ╠════════════════════════════════════════════════════════════╣"
printf "  ║  Container : LXC %-41s║\n" "${CT_ID} (${CT_HOSTNAME})"
printf "  ║  IP address: %-44s║\n" "${IP:-<check pct exec ${CT_ID} -- hostname -I>}"
printf "  ║  Web UI    : http://%-39s║\n" "${IP:-<container-ip>}:${APP_PORT}"
echo "  ╠════════════════════════════════════════════════════════════╣"
echo "  ║  Create your account on the first visit.                  ║"
echo "  ╚════════════════════════════════════════════════════════════╝"
echo -e "${CL}"

echo -e " ${INFO} Useful commands:"
echo -e "   pct exec ${CT_ID} -- journalctl -u streamvault -f             ${DIM}# live logs${CL}"
echo -e "   pct exec ${CT_ID} -- systemctl restart streamvault             ${DIM}# restart${CL}"
echo -e "   pct exec ${CT_ID} -- cat /var/log/streamvault-install.log      ${DIM}# full install log${CL}"
echo
echo -e " ${INFO} Reset password:"
echo -e "   pct exec ${CT_ID} -- bash -c \\"
echo -e "     'cd /opt/streamvault && node dist/cli/set-password.js you@email.com newpass'"
echo -e "   pct exec ${CT_ID} -- systemctl restart streamvault"
echo
