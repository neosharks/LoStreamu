# StreamVault

A self-hosted, auth-gated video streamer for your homelab — think a lightweight Plex. Sign in, browse your library with thumbnails, click to play in a full-featured mobile-friendly player. Add videos by pasting any URL yt-dlp supports (single video or whole playlist), or drop files into the media folder and rescan.

**Stack:** TypeScript (Express) backend · React 18 + Tailwind CSS frontend · Plyr video player · yt-dlp for downloads · ffmpeg for thumbnails

---

## Install on Proxmox VE (one command)

Run in the **Proxmox VE host shell** (Datacenter → your node → Shell):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/thakursat/hosted-video-streamer/refs/heads/main/streamvault.sh)"
```

Creates a Debian 12 LXC, installs all dependencies, compiles the TypeScript server, builds the React frontend, and starts the app as a systemd service.

**Defaults:** 2 vCPU · 8 GB RAM · 200 GB disk · unprivileged · DHCP

Override before running:

```bash
CT_RAM=4096 CT_DISK=100 CT_HOSTNAME=media \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/thakursat/hosted-video-streamer/refs/heads/main/streamvault.sh)"
```

Available overrides: `CT_ID` `CT_HOSTNAME` `CT_CPU` `CT_RAM` (MB) `CT_DISK` (GB) `CT_BRIDGE` `CT_NET` (`dhcp` or `192.168.1.50/24`) `CT_GW` `CT_UNPRIVILEGED` `CT_STORAGE` `TEMPLATE_STORAGE`

When it finishes it prints the access URL: `http://<container-ip>:8080`

---

## First login

There is no default password. On the first visit the app shows a **signup screen** — set your email and password there. After that the signup screen is locked permanently.

**Forgot your password?** Reset from the Proxmox host:

```bash
pct exec <CTID> -- bash -c "cd /opt/streamvault && sudo -u streamvault npm run set-password you@email.com 'newpassword'"
pct exec <CTID> -- systemctl restart streamvault
```

---

## Features

- **Library** — responsive grid with thumbnails, duration badges, folder tree sidebar, search, sort
- **Player** — Plyr-based, mobile-friendly (swipe to close, iOS fullscreen), scrub preview thumbnails, resume position, auto-advance, playlist prev/next
- **Downloads** — paste any yt-dlp-supported URL; live progress bar (speed + ETA); cancel mid-download
- **Playlists** — preview playlist contents, select which items to download, batch download with per-item status, pause/resume/stop/skip
- **Upload** — drag-and-drop or file picker with upload progress
- **yt-dlp version indicator** — always visible in the navbar; shows current version, flags outdated, one-click update
- **Proxy support** — set an HTTP/SOCKS5 proxy in Account → Network settings for blocked sites
- **Folder management** — create, rename, delete folders; move videos between folders; bulk delete

---

## Updating

Re-run the installer inside the container — it detects an existing install, rebuilds, and restarts the service automatically:

```bash
pct exec <CTID> -- bash -c "curl -fsSL https://raw.githubusercontent.com/thakursat/hosted-video-streamer/refs/heads/main/streamvault-app.tar.gz | tar -xz -C /opt/streamvault && bash /opt/streamvault/install-lxc.sh"
```

`config.json`, `media/`, `thumbnails/`, and `secrets.json` are preserved.

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

`streamvault.sh` downloads `streamvault-app.tar.gz` (source files only — the archive is built on the container). Rebuild after code changes:

```bash
./build-archive.sh
git add streamvault-app.tar.gz && git commit -m "chore: update app archive" && git push
```

---

## Notes

- **Browser codec support:** mp4 (H.264/AAC) and webm play everywhere. mkv and some codecs may not decode in all browsers. yt-dlp merges downloads to mp4 where possible.
- **Security:** bcrypt-hashed password, HTTP-only session cookie. Fine for LAN. Put it behind HTTPS (Caddy, nginx) if exposed to the internet.
- **Cookies for gated content:** drop a Netscape-format `cookies.txt` next to the app at `/opt/streamvault/cookies.txt` — it's picked up automatically for all downloads.
