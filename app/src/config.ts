import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { AppConfig } from './types';

export const APP_DIR = path.resolve(__dirname, '..');

// ── Data directory ───────────────────────────────────────────────────────────
// Everything the user would hate to lose — videos, thumbnails, accounts, config
// — lives OUTSIDE the app tree, so reinstalling or updating the application can
// never touch it. Resolution order:
//   1. SV_DATA_DIR       — set by the systemd unit on a real install
//   2. /var/lib/streamvault — when that directory already exists
//   3. APP_DIR           — dev checkouts and legacy installs keep working
function resolveDataDir(): string {
  const fromEnv = process.env.SV_DATA_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  const standard = '/var/lib/streamvault';
  try {
    if (fs.statSync(standard).isDirectory()) {
      // Adopt it only if this process can actually write there. The in-app
      // updater ships new code but cannot install the new systemd unit, so a
      // service still running under the old unit may be able to see the
      // directory without being allowed to write to it. Falling back to APP_DIR
      // keeps that install running on the data it already has.
      fs.accessSync(standard, fs.constants.W_OK);
      return standard;
    }
  } catch {}
  return APP_DIR;
}

export const DATA_DIR = resolveDataDir();

export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');
export const USERS_PATH = path.join(DATA_DIR, 'users.json');
export const COOKIES_PATH = path.join(DATA_DIR, 'cookies.txt');
export const META_CACHE_PATH = path.join(DATA_DIR, 'meta-cache.json');
export const QUEUE_PATH = path.join(DATA_DIR, 'download-queue.json');
export const FAVORITES_PATH = path.join(DATA_DIR, 'favorites.json');
export const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');
export const PREVIEW_DIR = path.join(DATA_DIR, 'previews');
export const YT_DLP_LOCAL = path.join(DATA_DIR, 'yt-dlp');

const DEFAULTS: AppConfig = {
  port: 8080,
  mediaDir: path.join(DATA_DIR, 'media'),
  proxy: '',
  updateUrl: 'https://raw.githubusercontent.com/neosharks/LoStreamu/main/streamvault-app.tar.gz',
};

let _config: AppConfig = { ...DEFAULTS };

export function loadConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      _config = { ...DEFAULTS, ...raw };
    }
  } catch {}
  return _config;
}

export function getConfig(): AppConfig {
  return _config;
}

export function saveConfig(updates?: Partial<AppConfig>): void {
  if (updates) _config = { ..._config, ...updates };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2));
}

export function getProxy(): string {
  return process.env.SV_PROXY || _config.proxy || '';
}

// Create the data tree before anything reads from it. Safe to call repeatedly.
export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, path.join(DATA_DIR, 'media'), THUMB_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}

// ── Legacy layout migration ──────────────────────────────────────────────────
// Installs made before the data directory split kept everything inside
// /opt/streamvault. Move those files into DATA_DIR once, on boot, so an upgrade
// is invisible to the user. Directories are merged child-by-child, so a media/
// folder the installer already created never blocks the move.

const LEGACY_ENTRIES = [
  'config.json', 'secrets.json', 'users.json', 'cookies.txt',
  'meta-cache.json', 'download-queue.json', 'yt-dlp',
  'favorites.json',
  'media', 'thumbnails',
];

let warnedSlowMigration = false;

function moveEntry(from: string, to: string): boolean {
  let stat: fs.Stats;
  try { stat = fs.statSync(from); } catch { return false; }

  if (stat.isDirectory() && fs.existsSync(to)) {
    let movedAny = false;
    for (const child of fs.readdirSync(from)) {
      if (moveEntry(path.join(from, child), path.join(to, child))) movedAny = true;
    }
    return movedAny;
  }
  if (fs.existsSync(to)) return false;

  try {
    fs.renameSync(from, to);
  } catch {
    // Different device — copy, then drop. This is the slow path and on a large
    // library it is very slow: systemd bind-mounts each ReadWritePaths entry, so
    // inside the service's namespace the app tree and the data dir look like
    // separate devices even on one disk. install-lxc.sh does the move as root
    // before the service starts, where it is a rename; this is the fallback for
    // anyone pointing SV_DATA_DIR somewhere by hand.
    if (!warnedSlowMigration) {
      warnedSlowMigration = true;
      console.log('Migration: cannot rename across the data dir — copying instead. On a large library this takes a while; the server finishes starting once it is done.');
    }
    try {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    } catch { return false; }
  }
  return true;
}

/** `fromDir` is only overridden by tests — production always migrates APP_DIR. */
export function migrateLegacyData(fromDir: string = APP_DIR): string[] {
  if (DATA_DIR === fromDir) return [];
  ensureDataDirs();
  const moved: string[] = [];
  for (const name of LEGACY_ENTRIES) {
    if (moveEntry(path.join(fromDir, name), path.join(DATA_DIR, name))) moved.push(name);
  }
  // A migrated config still points mediaDir at the old app-tree path.
  if (moved.includes('config.json')) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (!raw.mediaDir || path.resolve(raw.mediaDir) === path.join(fromDir, 'media')) {
        raw.mediaDir = path.join(DATA_DIR, 'media');
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
      }
    } catch {}
  }
  return moved;
}

// Face recognition was removed. Its index, face crops and ONNX models (~190 MB)
// are biometric data with nothing left to read them, so delete them on boot —
// from the data dir and from the app tree, where legacy installs kept them.
const FACE_DATA_ENTRIES = ['faces.json', 'faces', 'models'];

/** `dirs` is only overridden by tests — production cleans DATA_DIR and APP_DIR. */
export function removeFaceData(dirs: string[] = [DATA_DIR, APP_DIR]): string[] {
  const removed: string[] = [];
  for (const dir of new Set(dirs)) {
    for (const name of FACE_DATA_ENTRIES) {
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) continue;
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch {}
    }
  }
  return removed;
}

export interface AppSecrets {
  sessionSecret: string;
}

export function loadSecrets(): AppSecrets {
  try {
    if (fs.existsSync(SECRETS_PATH)) {
      return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
    }
  } catch {}
  const secret = crypto.randomBytes(64).toString('hex');
  const secrets = { sessionSecret: secret };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
  return secrets;
}

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.webm', '.mov', '.avi', '.ogv', '.ts',
  '.m4v', '.flv', '.wmv', '.m2ts', '.3gp', '.mts',
]);

export const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ogv': 'video/ogg',
  '.ts': 'video/mp2t', '.m4v': 'video/mp4', '.m2ts': 'video/mp2t',
  '.3gp': 'video/3gpp', '.mts': 'video/mp2t',
};
