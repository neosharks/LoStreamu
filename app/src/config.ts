import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { AppConfig } from './types';

export const APP_DIR = path.resolve(__dirname, '..');
export const CONFIG_PATH = path.join(APP_DIR, 'config.json');
export const SECRETS_PATH = path.join(APP_DIR, 'secrets.json');
export const COOKIES_PATH = path.join(APP_DIR, 'cookies.txt');
export const YT_DLP_LOCAL = path.join(APP_DIR, 'yt-dlp');

const DEFAULTS: AppConfig = {
  port: 8080,
  email: '',
  passwordHash: '',
  mediaDir: path.join(APP_DIR, 'media'),
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2));
}

export function getProxy(): string {
  return process.env.SV_PROXY || _config.proxy || '';
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
