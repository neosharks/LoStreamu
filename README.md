# LoStreamu

A self-hosted, auth-gated video streamer for your homelab — think a lightweight Plex. Sign in, browse your library with thumbnails, click to play in a full-featured player. Add videos by pasting any URL yt-dlp supports (single video or whole playlist), or drop files via the upload tab.

**Stack:** TypeScript (Express) backend · React 18 + Tailwind CSS frontend · Custom video player · yt-dlp for downloads · ffmpeg for thumbnails + scrub-preview sprites

---

## Install on Proxmox VE (one command)

Run in the **Proxmox VE host shell** (Datacenter → your node → Shell):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/neosharks/LoStreamu/refs/heads/main/streamvault.sh)"
```

Creates a Debian 12 LXC, installs all dependencies, compiles the TypeScript server, builds the React frontend, and starts the app as a systemd service.

**Defaults:** 4 vCPU · 8 GB RAM · 200 GB disk · unprivileged · DHCP

Override before running:

```bash
CT_RAM=4096 CT_DISK=100 CT_HOSTNAME=media \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/neosharks/LoStreamu/refs/heads/main/streamvault.sh)"
```

Available overrides: `CT_ID` `CT_HOSTNAME` `CT_CPU` `CT_RAM` (MB) `CT_DISK` (GB) `CT_BRIDGE` `CT_NET` (`dhcp` or `192.168.1.50/24`) `CT_GW` `CT_UNPRIVILEGED` `CT_STORAGE` `TEMPLATE_STORAGE`

When it finishes it prints the access URL: `http://<container-ip>:8080`

---

## First login

There is no default password. On the first visit the app shows a **signup screen** — set your email and password there. After that the signup screen is locked permanently.

**Forgot your password?** Reset from the Proxmox host:

```bash
pct exec <CTID> -- bash -c "cd /opt/streamvault && node dist/cli/set-password.js you@email.com 'newpassword'"
pct exec <CTID> -- systemctl restart streamvault
```

---

## Features

- **Library** — responsive grid with thumbnails, duration badges, resizable folder tree sidebar, search, sort (newest, name, size, duration, shuffle)
- **Scrub preview** — hover any video card to scrub through frames; full sprite preview tooltip in the player seek bar
- **Player** — custom-built, mobile-friendly (swipe to close, iOS fullscreen), keyboard shortcuts (Space/K play, J/L ±10s, M mute, F fullscreen, P PiP, 0–9 seek%, N/B playlist), resume position, auto-advance
- **Downloads** — paste any yt-dlp-supported URL; downloads are queued one at a time with live progress (speed + ETA); pause, resume, or cancel mid-download; floating tray shows active downloads when the modal is closed
- **Playlists** — preview playlist contents before downloading, cherry-pick items, download 1–3 concurrently; per-item live progress, skip individual videos; pause/resume/stop the whole batch
- **Upload** — drag-and-drop or file picker with upload progress bar
- **Folder management** — create, rename, move, delete folders from the sidebar; bulk move or delete videos; move individual videos via card menu
- **Multi-user** — admin can add and remove additional user accounts in Account settings; all users share the same library
- **Age-gated content** — headless Chromium launches automatically to accept age gates and save cookies when yt-dlp hits a 410/403 block
- **Proxy support** — set an HTTP/SOCKS5 proxy in Account → Network settings for sites blocked on the server network
- **App + yt-dlp version indicator** — visible in the navbar; one-click in-app update for both

---

## Updating

### In-app (recommended)

Open **Account settings → Update application**. The server downloads the latest release, rebuilds, and restarts automatically.

### From the Proxmox host

```bash
pct exec <CTID> -- bash -c "curl -fsSL https://raw.githubusercontent.com/neosharks/LoStreamu/refs/heads/main/streamvault-app.tar.gz -o /tmp/sv.tar.gz && tar -xzf /tmp/sv.tar.gz -C /opt/streamvault && rm /tmp/sv.tar.gz && bash /opt/streamvault/install-lxc.sh"
```

`config.json`, `media/`, `thumbnails/`, `secrets.json`, and `users.json` are preserved.

---

## Service management

```bash
pct exec <CTID> -- systemctl start streamvault
pct exec <CTID> -- systemctl status streamvault
pct exec <CTID> -- journalctl -u streamvault -f     # live logs
pct exec <CTID> -- systemctl restart streamvault    # after config changes
```

---

## Manual install (no Proxmox)

See [README-app.md](README-app.md) for installing directly on any Debian/Ubuntu host or macOS.

---

## Maintainers: rebuild the app archive

`streamvault.sh` downloads `streamvault-app.tar.gz` (source files only — compiled on the container). Rebuild after code changes:

```bash
./build-archive.sh
git add streamvault-app.tar.gz && git commit -m "chore: update app archive" && git push
```

---

## Notes

- **Browser codec support:** mp4 (H.264/AAC) and webm play in all browsers. mkv and some codecs may not decode natively — yt-dlp merges downloads to mp4 where possible.
- **Security:** bcrypt-hashed passwords, HTTP-only session cookie. Fine for LAN. Put behind HTTPS (Caddy, nginx) if exposed to the internet.
- **Cookies for gated content:** drop a Netscape-format `cookies.txt` at `/opt/streamvault/cookies.txt` — picked up automatically. For YouTube age-restricted videos, Chromium launches headlessly to accept the gate automatically.
- **Single-library:** all users see and share the same media library.
