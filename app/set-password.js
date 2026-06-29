import bcrypt from 'bcryptjs';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');

const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.log('Usage: node set-password.js <email> <password>');
  process.exit(1);
}

const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
cfg.email = email;
cfg.passwordHash = bcrypt.hashSync(password, 10);
fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
console.log(`Updated login → ${email}`);
