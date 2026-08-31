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
8. Creates `/var/lib/streamvault` (data dir) and writes a default `config.json` if none exists
9. Installs and enables `streamvault.service`

Then start it:

```bash
systemctl start streamvault
```

Open **http://\<server-ip\>:8080** and create the admin profile — display name, email, and a 6-digit PIN — on the first visit.

## Where files live

Application code and user data are deliberately kept apart, so removing or reinstalling the app never risks the library.

**Data — `/var/lib/streamvault`** (override with the `SV_DATA_DIR` environment variable)

| Path | Contents |
|---|---|
| `config.json` | Port, media dir, proxy, update URL |
| `secrets.json` | Session + cookie signing key (auto-generated, never commit) |
| `users.json` | Profiles: name, email, bcrypt PIN hash, avatar, trusted devices |
| `media/` | Videos, organised in subfolders |
| `thumbnails/` | Generated thumbnails, sprites, VTT seek files |
| `meta-cache.json` | Cached ffprobe metadata (duration, resolution) |
| `download-queue.json` | Persisted download queue |
| `cookies.txt` | Optional Netscape cookies for age-gated sites |

**Code — `/opt/streamvault`**

| Path | Contents |
|---|---|
| `dist/` | Compiled TypeScript server |
| `client/dist/` | Built React frontend |
| `streamvault.service` | systemd unit (sets `SV_DATA_DIR`) |

On a dev checkout with no `/var/lib/streamvault` and no `SV_DATA_DIR`, the data dir falls back to the `app/` directory so `npm run dev` works with no setup. A pre-split install is migrated into `/var/lib/streamvault` automatically on the first boot after updating; the server logs what it moved.

## config.json reference

```json
{
  "port": 8080,
  "mediaDir": "/var/lib/streamvault/media",
  "proxy": ""
}
```

Accounts are **not** in `config.json` — they live in `users.json` alongside it.

Set `proxy` to an `http://`, `https://`, or `socks5://` URL to route all yt-dlp downloads through it. Alternatively, set the `SV_PROXY` environment variable.

## Forgotten PIN

There is no reset flow, by design: no reset email, no password fallback, no recovery code.

- **Someone else's PIN** — an admin issues a new one from **Settings → Profiles** (key icon). That also clears the profile's trusted devices, so the owner confirms their email once on the next sign-in.
- **The last admin PIN** — unrecoverable from inside the app. Delete the profiles file to return to first-run setup. Videos, thumbnails and folders are untouched:

```bash
rm /var/lib/streamvault/users.json
systemctl restart streamvault
```

Repeated wrong PINs lock a profile: four misses are free, then 30s, doubling per miss up to 15 minutes. An admin can clear a lock early from Settings → Profiles.

## Profiles

The first profile created on the setup screen is the **admin**. It can add, rename, re-colour, re-PIN, promote and remove profiles from **Settings → Profiles**. All profiles share the same media library.

Every profile can change its own name, colour, email and PIN from **Settings → Account**; changing the email or the PIN requires the current PIN. Non-admins cannot see or touch other profiles.

**Sign-in rules**

| Situation | Required |
|---|---|
| A browser the server has never seen | email + 6-digit PIN |
| The same browser afterwards | PIN only |
| A new device, or after "Forget all devices" | email + PIN again |

The trust is a signed, HTTP-only cookie valid for 6 months, hashed server-side (only the hash is stored). Signing out keeps the trust; **Settings → Trusted devices → Forget all devices** revokes it everywhere.

PIN rules: exactly 6 digits, no single repeated digit (`111111`), no consecutive run (`123456`, `654321`).

## Empty folders

Moving or deleting the last video out of a folder leaves the folder in place — a folder disappearing mid-reorganise is worse than a stray empty one, and a folder you just created has to survive long enough to receive files. **Settings → Library & storage → Clean junk files** removes every empty folder under the media root in one pass, along with orphaned thumbnails and download leftovers.

## Service management

```bash
systemctl status streamvault
systemctl restart streamvault
journalctl -u streamvault -f     # live logs
```

## Bigger / external media disk

Add a disk mountpoint from the Proxmox host:

```bash
pct set <CTID> -mp0 local-lvm:500,mp=/var/lib/streamvault/media
```

Or bind-mount an existing host directory. Re-run `chown -R streamvault:streamvault /var/lib/streamvault` after mounting.

## Upgrading

Re-run `install-lxc.sh` — it rebuilds the server and client and restarts the service if running. Everything in `/var/lib/streamvault` (config, profiles, media, thumbnails) is outside the app directory and is never touched.

```bash
cd /opt/streamvault
git pull   # or re-extract the archive
bash install-lxc.sh
```
