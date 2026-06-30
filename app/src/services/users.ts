import fs from 'fs';
import path from 'path';
import { APP_DIR } from '../config';

const USERS_PATH = path.join(APP_DIR, 'users.json');

export interface ManagedUser {
  email: string;
  passwordHash: string;
}

export function loadUsers(): ManagedUser[] {
  try {
    if (fs.existsSync(USERS_PATH)) return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  } catch {}
  return [];
}

export function saveUsers(users: ManagedUser[]): void {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}
