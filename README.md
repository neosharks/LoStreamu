# LoStreamu

A self-hosted, PIN-gated video streamer for your homelab — think a lightweight Plex. The app opens on a Netflix-style profile picker: tap yours, type your 6-digit PIN, and you are in your library. Add videos by pasting any URL yt-dlp supports (single video or whole playlist), or drop files via the upload tab.

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

There is no default PIN. On the first visit the app shows a **setup screen** — pick a display name, a profile colour, your email, and a **6-digit PIN**. That first profile is the **admin** and can create everyone else from Settings → Profiles. After setup, the setup screen is locked permanently.

**How signing in works**

| | |
|---|---|
| A browser the server has never seen | email **+** PIN, once |
| Every login after that, same browser | PIN only |
| A new phone, laptop or private window | email **+** PIN again |

The browser is remembered with a signed, HTTP-only cookie for 6 months. Clear it any time from **Settings → Trusted devices → Forget all devices**.

**Forgotten PIN — there is no rescue.** No reset email, no password fallback, no recovery code. An admin can issue a new PIN for anyone else's profile (Settings → Profiles → key icon), but a forgotten *admin* PIN cannot be recovered from inside the app. The only way back is deleting the profiles file from the host shell, which returns the app to first-run setup and **keeps every video**:

```bash
pct exec <CTID> -- bash -c "rm /var/lib/streamvault/users.json"
pct exec <CTID> -- systemctl restart streamvault
```

Brute force is throttled: four wrong PINs are free, then the profile locks for 30s, doubling on each further miss up to 15 minutes.

---

## Features

- **Library** — responsive grid with thumbnails, duration badges, resizable folder tree sidebar, breadcrumb path, subfolder tiles, search, sort (newest, name, size, duration, shuffle), and a *this folder only* toggle for when the recursive listing gets in the way
- **Scrub preview** — hover any video card to scrub through frames; full sprite preview tooltip in the player seek bar
- **Player** — custom-built, mobile-friendly (swipe to close, iOS fullscreen), auto-advance. **Scroll over the volume control to change it**, with an on-screen readout; playback speed 0.5×–2×; loop a single video. Volume, mute and speed are remembered across videos and sessions. Keyboard: Space/K play, J/L ±10s, ↑↓ volume, `,`/`.` speed, M mute, R loop, F fullscreen, P PiP, 0–9 seek%, N/B playlist, Esc close
- **Downloads** — paste any yt-dlp-supported URL; downloads are queued one at a time with live progress (speed + ETA); pause, resume, or cancel mid-download; floating tray shows active downloads when the modal is closed
- **Playlists** — preview playlist contents before downloading, cherry-pick items, download 1–3 concurrently; per-item live progress, skip individual videos; pause/resume/stop the whole batch
- **Upload** — drag-and-drop or file picker with upload progress bar
- **Drag and drop** — drag a video (or a whole selection) onto any folder in the sidebar, onto a subfolder tile, or onto a breadcrumb to move it; drag folders into each other to reorganise. Hovering a collapsed folder mid-drag springs it open. Illegal drops (a folder into its own child, a file into where it already lives) never light up
- **Selection** — click a checkbox, shift-click for a range, ⌘/Ctrl-click to pick individual videos, ⌘/Ctrl+A for everything in view; `M` moves, `Delete` deletes, `Esc` clears. Long-press works on touch
- **Folder management** — create, rename, move and delete folders from the sidebar, from a folder tile, or from inside the move dialog (which also searches your folders by name). Empty folders stay put — nothing vanishes while you are organising; **Settings → Clean junk files** sweeps them when you want them gone
- **Profiles** — Netflix-style picker on the login screen with animated gradient tiles and a tap-or-type PIN pad; the admin adds, renames, re-PINs and removes profiles in Settings; all profiles share the same library
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

Nothing of yours is touched: `config.json`, `media/`, `thumbnails/`, `secrets.json` and `users.json` all live in `/var/lib/streamvault`, outside the app directory.

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
- **Security:** bcrypt-hashed PINs, HTTP-only session cookie, signed device tokens, per-profile lockout after repeated wrong PINs. Fine for LAN. Put behind HTTPS (Caddy, nginx) if exposed to the internet.
- **Your data is separate from the app:** videos, thumbnails, profiles and config live in `/var/lib/streamvault`; the code lives in `/opt/streamvault`. Deleting or reinstalling the app leaves the library intact. Point the server elsewhere with the `SV_DATA_DIR` environment variable. An install made before this split is migrated automatically on the first boot after updating.
- **Cookies for gated content:** drop a Netscape-format `cookies.txt` at `/opt/streamvault/cookies.txt` — picked up automatically. For YouTube age-restricted videos, Chromium launches headlessly to accept the gate automatically.
- **Single-library:** all profiles see and share the same media library.
- **Upgrading from a password build:** PINs cannot be derived from password hashes, so the old accounts are set aside (`users.json.password-era.bak`) and the app returns to first-run setup — one admin profile to re-create, then the rest from Settings. Your videos, thumbnails and folders are untouched.
