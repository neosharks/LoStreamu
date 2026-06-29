# StreamVault

A lightweight, self-hosted, auth-gated video streamer. Like a tiny Plex: drop
files into a folder, sign in, and everything shows up with thumbnails. Click a
video and it plays at full resolution in a polished [Plyr](https://plyr.io)
player (vendored locally, no CDN at runtime): scrub-bar **peek thumbnails**,
playback speed, volume, mute, Picture-in-Picture, download, fullscreen, full
keyboard control, and automatic resume where you left off. Plays the next video
automatically.

Each card shows a duration badge, resolution, and size, with hover actions to
**download** the original file or open an **info** panel (resolution, codecs,
bitrate, frame rate). Search filters the library instantly. A **Stats** view
reports disk, memory, CPU load, uptime, library size, and active downloads.
Downloads are also available from inside the player.

## Requirements

- **Node.js 18+**
- **ffmpeg** and **ffprobe** on your PATH (used for thumbnails and merging streams).
  - macOS: `brew install ffmpeg`
- **yt-dlp** on your PATH (used by the "Add videos" downloader).
  - macOS: `brew install yt-dlp`  ·  or grab the binary from the yt-dlp releases page.

## Setup

```bash
cd streamvault
npm install
npm start
```

Open http://localhost:8080

On first run a `config.json` is created with **no account**. Open
http://localhost:8080 and the signup screen lets you create the single admin
account (email + password, 8+ chars). Once it exists, signup is locked and only
sign-in is shown.

Change your email or password anytime from the in-app **Account** button.
Prefer the CLI (or locked yourself out)? Seed/reset it directly:

```bash
npm run set-password your@email.com "your-strong-password"
```

(Restart the server after running the CLI.)

## Adding videos

Two ways:

**1. Drop files in.** Put video files into the `media/` folder (subfolders are
scanned too), then click **Rescan** in the header — or refresh.

**2. Download by link.** Click **+ Add videos**, paste a URL (a direct file, an
m3u8/HLS stream, or any site yt-dlp supports), and press Download. A live
progress bar shows percent, speed, and ETA; **Cancel** stops it mid-way. When it
finishes, the library refreshes automatically and the video appears in the grid.

Every download is saved into its **own randomly-named folder with a
randomly-named file** — the source title is never written to disk and never
shown in the UI. HLS/segmented streams are merged into a single mp4.

Supported containers: mp4, mkv, webm, mov, avi, m4v, ts, m2ts, 3gp, ogv, and more.

> **Browser playback note:** the server streams files directly (with HTTP range
> support, so seeking and skip work). Browsers play what they natively support —
> mp4 (H.264/AAC) and webm everywhere; mkv and some codecs may not decode in all
> browsers. For the widest compatibility, keep media as mp4 (H.264 + AAC). If you
> want automatic transcoding for unsupported formats, that's a larger add-on and
> isn't included in this lightweight build.

## config.json

```json
{
  "port": 8080,
  "email": "",
  "passwordHash": "",
  "mediaDir": "/absolute/path/to/media",
  "updateUrl": "https://raw.githubusercontent.com/thakursat/hosted-video-streamer/main/streamvault-app.tar.gz"
}
```

`email` and `passwordHash` are empty until you create an account via the signup
screen (or `npm run set-password`). `updateUrl` is the tarball the in-app
**Update** button pulls from — override it (or set the `SV_UPDATE_URL` env var)
if you fork the repo.

### Secrets

The session signing key (and any future tokens) live in **`secrets.json`**, not
in `config.json` and never in git. They're generated at deploy time:

```bash
npm run gen-secrets            # create secrets.json if missing (idempotent)
npm run gen-secrets -- --rotate  # force fresh keys (signs everyone out)
```

The server also generates them on first start if they're missing, and a legacy
`sessionSecret` already in `config.json` is migrated over automatically. The file
is written `0600`; keep it out of backups you share. `secrets.json` and
`config.json` are both preserved across in-app updates.

Point `mediaDir` anywhere — e.g. an external drive or an existing library
folder. Thumbnails are cached in `thumbnails/` keyed by file path.

## Player controls

- **Space** — play/pause
- **← / →** — skip 10 seconds back/forward
- **n** — next video
- **Esc** — close player
- Click the timeline to scrub; fullscreen button bottom-right.

## Notes on security

Auth is a single email/password with a bcrypt-hashed credential and an
HTTP-only session cookie. This is fine for a home/LAN setup. If you expose it to
the internet, put it behind HTTPS (a reverse proxy like Caddy or nginx) — the
session cookie is sent in the clear over plain HTTP otherwise.

## Hosting in a Proxmox LXC (LAN-only, dedicated container)

On the **Proxmox host**, create a Debian 12 unprivileged container:

```bash
pveam download local debian-12-standard_12.7-1_amd64.tar.zst
pct create 110 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname streamvault --cores 2 --memory 1024 --swap 512 \
  --rootfs local-lvm:16 --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --features nesting=1 --onboot 1
pct start 110
```

Push the zip in and enter the container:

```bash
pct push 110 /path/to/streamvault.zip /root/streamvault.zip
pct enter 110
cd /opt && unzip /root/streamvault.zip && cd streamvault
./install-lxc.sh
```

The installer sets up Node 20, ffmpeg, a `streamvault` service user, and a
systemd service. Finish by setting a password and starting it:

```bash
sudo -u streamvault npm run set-password you@example.com 'your-password'
systemctl start streamvault
```

Reach it on your LAN at `http://<LXC-ip>:8080`. Find the IP with `ip a`.

### Bigger / separate disk for the library

If your videos won't fit on the rootfs, add a mountpoint from the **host**:

```bash
pct set 110 -mp0 local-lvm:200,mp=/opt/streamvault/media
```

(or bind-mount an existing host directory). Re-run chown after:
`chown -R streamvault:streamvault /opt/streamvault/media`. Drop files in and
click **Rescan**.

### Service management

```bash
systemctl status streamvault     # check it's running
journalctl -u streamvault -f     # live logs
systemctl restart streamvault    # after editing config.json
```
