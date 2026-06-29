import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECRETS_PATH = join(__dirname, 'secrets.json');
const CONFIG_PATH = join(__dirname, 'config.json');

const newKey = () => crypto.randomBytes(32).toString('hex');

// Generates secrets.json on first use and returns the secrets. Idempotent:
// existing keys are preserved so sessions survive restarts and updates. Secrets
// live here (never in git, never in the tarball, never mixed into config.json).
// Pass { rotate: true } to force fresh keys — this invalidates all sessions.
export function ensureSecrets({ rotate = false } = {}) {
  let secrets = {};
  if (fs.existsSync(SECRETS_PATH)) {
    try { secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')); } catch {}
  }

  // One-time migration: lift a legacy sessionSecret out of config.json.
  if (!rotate && !secrets.sessionSecret && fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (cfg.sessionSecret) secrets.sessionSecret = cfg.sessionSecret;
    } catch {}
  }

  let changed = false;
  if (rotate || !secrets.sessionSecret) { secrets.sessionSecret = newKey(); changed = true; }

  if (changed || !fs.existsSync(SECRETS_PATH)) {
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    try { fs.chmodSync(SECRETS_PATH, 0o600); } catch {}
  }
  return secrets;
}

export { SECRETS_PATH };
