# StreamVault

A lightweight, self-hosted, auth-gated video streamer for your homelab — think a
tiny Plex. Sign in, see your library with thumbnails, click to play at full
resolution. The player is deliberately minimal: scrub timeline, 10-second skip,
play/pause, next, fullscreen. Add videos by dropping files in a folder **or** by
pasting a link (direct file, m3u8/HLS, or anything yt-dlp supports) — downloads
show a live progress bar and are saved under randomized names.

## Install on Proxmox VE (one line)

Run this in the **Proxmox VE host shell** (Datacenter → your node → Shell):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/USER/REPO/main/streamvault.sh)"
```

> Replace `USER/REPO` with your GitHub path. **Edit the two URL variables at the
> top of `streamvault.sh`** (`REPO_RAW`) to point at your repo before pushing —
> the script pulls the app from `streamvault-app.tar.gz` in the same repo.

This creates a Debian 12 LXC and installs everything (Node.js, ffmpeg, yt-dlp,
the app, and a systemd service). **Defaults: 2 vCPU, 8 GB RAM, 200 GB disk,
unprivileged, DHCP.**

When it finishes it prints the access URL, e.g. `http://<container-ip>:8080`.

### Default login

```
email:    admin@local
password: changeme
```

Change it immediately (from the Proxmox host):

```bash
pct exec <CTID> -- bash -c "cd /opt/streamvault && sudo -u streamvault npm run set-password you@example.com 'your-password'"
pct exec <CTID> -- systemctl restart streamvault
```

### Override the defaults

Export variables before running the one-liner:

```bash
CT_RAM=4096 CT_DISK=100 CT_HOSTNAME=media \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/USER/REPO/main/streamvault.sh)"
```

Available overrides: `CT_ID`, `CT_HOSTNAME`, `CT_CPU`, `CT_RAM` (MB), `CT_DISK`
(GB), `CT_BRIDGE`, `CT_NET` (`dhcp` or `192.168.1.50/24`), `CT_GW`,
`CT_UNPRIVILEGED`, `CT_STORAGE`, `TEMPLATE_STORAGE`.

## Using it

- **+ Add videos** → paste a link → live progress, with Cancel. Finished
  downloads appear in the grid automatically.
- Or copy files into `/opt/streamvault/media` inside the container, then click
  **Rescan**.
- Every downloaded video is saved into a randomly-named folder with a
  randomly-named file; the source title is never written to disk or shown.

## Updating

```bash
pct exec <CTID> -- bash -c "curl -fsSL https://raw.githubusercontent.com/USER/REPO/main/streamvault-app.tar.gz -o /tmp/sv.tar.gz && tar -xzf /tmp/sv.tar.gz -C /opt/streamvault && cd /opt/streamvault && npm install --omit=dev && chown -R streamvault:streamvault /opt/streamvault && systemctl restart streamvault"
```

(Your `config.json` and `media/` are preserved.)

## Maintainers: how to (re)build the app archive

`streamvault.sh` downloads `streamvault-app.tar.gz`. Rebuild it after any code
change and commit it alongside the script:

```bash
./build-archive.sh
git add streamvault-app.tar.gz && git commit -m "Update app archive" && git push
```

## Notes

- **Browser codec support:** mp4 (H.264/AAC) and webm play everywhere; mkv and
  some codecs may not decode in all browsers. Keep media as mp4 for trouble-free
  playback. Downloads are merged to mp4 where possible.
- **LAN use:** auth is a single bcrypt-hashed email/password over an HTTP-only
  session cookie. For internet exposure, put it behind HTTPS (reverse proxy).
- **yt-dlp** self-updates; if a site changes, run
  `pct exec <CTID> -- yt-dlp -U` inside the container.

## Manual / non-Proxmox install

See [`README-app.md`](README-app.md) for running it directly (any Debian/Ubuntu
host or your Mac) without the Proxmox helper.
