# LoStreamu — Manual Install

For running LoStreamu directly on any Debian/Ubuntu server or macOS without Proxmox.

## Requirements

- **Node.js 20+**
- **ffmpeg** + **ffprobe** (thumbnails and scrub-preview sprites)
  - macOS: `brew install ffmpeg`
  - Debian/Ubuntu: `apt-get install ffmpeg`
- **yt-dlp** (video downloads)
  - macOS: `brew install yt-dlp`
  - Linux: `curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp`
- **curl-cffi** (yt-dlp TLS impersonation — fixes many blocked-site errors)
  - `pip3 install --break-system-packages curl-cffi`  *(Debian 12+)*
  - `pip3 install curl-cffi`  *(older systems / macOS)*
- **Chromium** (optional — headless browser for age-gated content)
  - macOS: [Google Chrome](https://google.com/chrome) or `brew install --cask chromium`
  - Debian/Ubuntu: `apt-get install chromium`

## Development (local)

```bash
git clone https://github.com/neosharks/LoStreamu.git
cd hosted-video-streamer/app

# Install server deps
npm install

# Install client deps
cd client && npm install && cd ..

# Start both (backend :8080, frontend :5173 with hot reload)
npm run dev
```

Open **http://localhost:5173** — the React dev server proxies `/api`, `/stream`, and `/thumb` to the Express backend on port 8080.

## Production (Debian/Ubuntu LXC or server)

Clone or download the source, then run the installer as root:

```bash
git clone https://github.com/neosharks/LoStreamu.git
cd hosted-video-streamer/app
bash install-lxc.sh
```

The installer:
1. Installs system packages (Node.js 20, ffmpeg, yt-dlp, Chromium, curl-cffi)
2. Sets up a daily yt-dlp auto-update timer
3. Runs `npm install` (full — TypeScript compiler needed for the build)
4. Compiles the TypeScript server → `dist/`
5. Builds the React frontend → `client/dist/`
6. Prunes dev dependencies and removes `client/node_modules`
7. Creates the `streamvault` service user
8. Writes a default `config.json` if none exists
9. Installs and enables `streamvault.service`

Then start it:

```bash
systemctl start streamvault
```

Open **http://\<server-ip\>:8080** and create your account on the first visit.

## Where files live

| Path | Contents |
|---|---|
| `/opt/streamvault/config.json` | Port, email, password hash, media dir, proxy |
| `/opt/streamvault/secrets.json` | Session signing key (auto-generated, never commit) |
| `/opt/streamvault/users.json` | Additional managed user accounts (admin-created) |
| `/opt/streamvault/media/` | Videos, organised in subfolders |
| `/opt/streamvault/thumbnails/` | Generated thumbnails, sprites, VTT seek files |
| `/opt/streamvault/meta-cache.json` | Cached ffprobe metadata (duration, resolution) |
| `/opt/streamvault/cookies.txt` | Optional Netscape cookies for age-gated sites |
| `/opt/streamvault/dist/` | Compiled TypeScript server |
| `/opt/streamvault/client/dist/` | Built React frontend |

## config.json reference

```json
{
  "port": 8080,
  "email": "you@example.com",
  "passwordHash": "<bcrypt hash>",
  "mediaDir": "/opt/streamvault/media",
  "proxy": ""
}
```

Set `proxy` to an `http://`, `https://`, or `socks5://` URL to route all yt-dlp downloads through it. Alternatively, set the `SV_PROXY` environment variable.

## Reset password (CLI)

```bash
cd /opt/streamvault
node dist/cli/set-password.js you@example.com 'newpassword'
systemctl restart streamvault
```

## User management

The first account created (via the signup page) is the **admin**. The admin can add and remove additional user accounts from **Account settings → Users**. All users share the same media library. Non-admin users can change their own passwords but cannot manage other accounts.

## Service management

```bash
systemctl status streamvault
systemctl restart streamvault
journalctl -u streamvault -f     # live logs
```

## Bigger / external media disk

Add a disk mountpoint from the Proxmox host:

```bash
pct set <CTID> -mp0 local-lvm:500,mp=/opt/streamvault/media
```

Or bind-mount an existing host directory. Re-run `chown -R streamvault:streamvault /opt/streamvault/media` after mounting.

## Upgrading

Re-run `install-lxc.sh` — it rebuilds the server and client, restarts the service if running, and leaves `config.json`, `secrets.json`, `users.json`, `media/`, and `thumbnails/` untouched.

```bash
cd /opt/streamvault
git pull   # or re-extract the archive
bash install-lxc.sh
```
