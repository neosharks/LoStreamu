import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { USERS_PATH, DATA_DIR, getConfig, saveConfig } from '../config';

// ── Accounts ─────────────────────────────────────────────────────────────────
// Auth is a 6-digit PIN, Netflix style: the login screen lists profiles, you
// pick yours and type the PIN. There is no password and no reset flow — a PIN
// that is forgotten cannot be recovered from inside the app.
//
// Email is the second factor for a device the server has never seen: the first
// login from a browser needs email + PIN, and on success the browser is issued
// a long-lived signed device token. Every later login from that browser is PIN
// only.
//
// The whole account store is one JSON file in DATA_DIR, so it survives an app
// reinstall along with the media library.

const BCRYPT_ROUNDS = 12;
const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;   // 6 months
const MAX_DEVICES = 12;                            // per user, oldest evicted

// Lockout: the first few misses are free (fat fingers), then the account locks
// for a doubling window. A 6-digit PIN is only a million combinations, so
// throttling is what actually makes it safe to expose.
const FREE_ATTEMPTS = 4;
const LOCK_BASE_MS = 30 * 1000;
const LOCK_MAX_MS = 15 * 60 * 1000;

/** Avatar tiles offered on the profile picker. The client maps these to gradients. */
export const AVATAR_KEYS = [
  'indigo', 'violet', 'rose', 'amber', 'emerald', 'sky', 'slate', 'fuchsia',
] as const;
export type AvatarKey = typeof AVATAR_KEYS[number];

export interface TrustedDevice {
  id: string;
  hash: string;       // sha256 of the token; the raw token only lives in the cookie
  label: string;      // truncated user agent, so devices are recognisable in settings
  addedAt: number;
  lastSeen: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  pinHash: string;
  avatar: AvatarKey;
  isAdmin: boolean;
  createdAt: number;
  devices: TrustedDevice[];
  failedAttempts: number;
  lockedUntil: number;
}

interface UsersFile {
  version: 2;
  users: User[];
}

let _users: User[] | null = null;

// ── Persistence ──────────────────────────────────────────────────────────────

function normalize(raw: Partial<User>): User {
  return {
    id: raw.id || newId(),
    name: raw.name || 'User',
    email: (raw.email || '').toLowerCase(),
    pinHash: raw.pinHash || '',
    avatar: (AVATAR_KEYS as readonly string[]).includes(raw.avatar as string)
      ? raw.avatar as AvatarKey
      : 'indigo',
    isAdmin: !!raw.isAdmin,
    createdAt: raw.createdAt || Date.now(),
    devices: Array.isArray(raw.devices) ? raw.devices : [],
    failedAttempts: raw.failedAttempts || 0,
    lockedUntil: raw.lockedUntil || 0,
  };
}

export function loadUsers(): User[] {
  if (_users) return _users;
  let users: User[] = [];
  try {
    if (fs.existsSync(USERS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
      if (Array.isArray(raw)) {
        // v1 file: [{ email, passwordHash }] — password accounts, unusable now.
        archiveLegacyAccounts();
      } else if (raw && Array.isArray(raw.users)) {
        users = raw.users.map(normalize);
      }
    }
  } catch {}
  _users = users;
  return _users;
}

export function saveUsers(users?: User[]): void {
  if (users) _users = users;
  const file: UsersFile = { version: 2, users: _users ?? [] };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(file, null, 2));
}

/** Test seam — drops the in-memory cache so the next read hits disk. */
export function resetUserCache(): void {
  _users = null;
}

function newId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// ── Password-era migration ───────────────────────────────────────────────────
// Password hashes cannot become PINs, so old accounts are set aside rather than
// converted: the file is renamed, the legacy config fields are dropped, and the
// app returns to first-run setup. The media library is untouched.

function archiveLegacyAccounts(): void {
  const backup = `${USERS_PATH}.password-era.bak`;
  try { if (!fs.existsSync(backup)) fs.renameSync(USERS_PATH, backup); }
  catch { return; }
  console.log(`Accounts: password-era users.json archived → ${backup}`);
}

/** Clears the pre-PIN admin credentials out of config.json. Call once on boot. */
export function migratePasswordEraConfig(): boolean {
  const cfg = getConfig();
  if (!cfg.email && !cfg.passwordHash) return false;
  delete cfg.email;
  delete cfg.passwordHash;
  saveConfig();
  console.log('Accounts: password login removed — set up a PIN on the next visit.');
  return true;
}

// ── Lookup ───────────────────────────────────────────────────────────────────

export function findUser(id: string): User | undefined {
  return loadUsers().find(u => u.id === id);
}

export function findUserByEmail(email: string): User | undefined {
  const wanted = email.trim().toLowerCase();
  return loadUsers().find(u => u.email === wanted);
}

/** True once at least one usable account exists — gates the signup screen. */
export function hasAccounts(): boolean {
  return loadUsers().some(u => !!u.pinHash);
}

export function adminCount(): number {
  return loadUsers().filter(u => u.isAdmin).length;
}

// ── PIN policy ───────────────────────────────────────────────────────────────

/** Returns an error message, or null when the PIN is acceptable. */
export function validatePin(pin: unknown): string | null {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return 'PIN must be exactly 6 digits.';
  if (/^(\d)\1{5}$/.test(pin)) return 'PIN cannot be the same digit six times.';
  const digits = pin.split('').map(Number);
  const step = (d: number) => digits.every((n, i) => i === 0 || n === digits[i - 1]! + d);
  if (step(1) || step(-1)) return 'PIN cannot be a run of consecutive digits.';
  return null;
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

export async function verifyPin(user: User, pin: string): Promise<boolean> {
  if (!user.pinHash) return false;
  return bcrypt.compare(pin, user.pinHash);
}

// ── Lockout ──────────────────────────────────────────────────────────────────

/** Milliseconds an account stays locked after `failedAttempts` misses. */
export function lockDuration(failedAttempts: number): number {
  if (failedAttempts <= FREE_ATTEMPTS) return 0;
  const over = failedAttempts - FREE_ATTEMPTS - 1;
  return Math.min(LOCK_BASE_MS * 2 ** over, LOCK_MAX_MS);
}

/** Seconds left on an active lock, or 0 when the account is usable. */
export function lockRemaining(user: User, now = Date.now()): number {
  return user.lockedUntil > now ? Math.ceil((user.lockedUntil - now) / 1000) : 0;
}

export function recordFailure(user: User): number {
  user.failedAttempts += 1;
  const lock = lockDuration(user.failedAttempts);
  if (lock) user.lockedUntil = Date.now() + lock;
  saveUsers();
  return Math.ceil(lock / 1000);
}

export function clearFailures(user: User): void {
  if (!user.failedAttempts && !user.lockedUntil) return;
  user.failedAttempts = 0;
  user.lockedUntil = 0;
  saveUsers();
}

// ── Trusted devices ──────────────────────────────────────────────────────────

export function hashDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function deviceLabel(userAgent: string | undefined): string {
  return (userAgent || 'Unknown device').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Finds the live device record matching a raw cookie token. */
export function matchDevice(user: User, token: string | undefined): TrustedDevice | undefined {
  if (!token) return undefined;
  const hash = hashDeviceToken(token);
  const now = Date.now();
  return user.devices.find(d => d.hash === hash && now - d.lastSeen < DEVICE_TTL_MS);
}

export function isTrustedDevice(user: User, token: string | undefined): boolean {
  return !!matchDevice(user, token);
}

/** Issues a device token for `user` and returns the raw value for the cookie. */
export function trustDevice(user: User, userAgent: string | undefined): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  user.devices = user.devices
    .filter(d => now - d.lastSeen < DEVICE_TTL_MS)
    .slice(-(MAX_DEVICES - 1));
  user.devices.push({
    id: newId(),
    hash: hashDeviceToken(token),
    label: deviceLabel(userAgent),
    addedAt: now,
    lastSeen: now,
  });
  saveUsers();
  return token;
}

export function touchDevice(user: User, token: string | undefined): void {
  const device = matchDevice(user, token);
  if (!device) return;
  device.lastSeen = Date.now();
  saveUsers();
}

export function forgetDevices(user: User): void {
  user.devices = [];
  saveUsers();
}

// ── Mutations ────────────────────────────────────────────────────────────────

export interface NewUser {
  name: string;
  email: string;
  pin: string;
  avatar?: AvatarKey;
  isAdmin?: boolean;
}

export async function createUser(input: NewUser): Promise<User> {
  const users = loadUsers();
  const user = normalize({
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    pinHash: await hashPin(input.pin),
    avatar: input.avatar,
    isAdmin: !!input.isAdmin,
  });
  users.push(user);
  saveUsers(users);
  return user;
}

export function deleteUser(id: string): void {
  saveUsers(loadUsers().filter(u => u.id !== id));
}

/** Shape sent to the client for an authenticated user. */
export function publicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    isAdmin: user.isAdmin,
    devices: user.devices.length,
  };
}

/** Shape sent to the *unauthenticated* login screen — no email, no counters. */
export function profileCard(user: User, deviceToken: string | undefined) {
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    isAdmin: user.isAdmin,
    needsEmail: !isTrustedDevice(user, deviceToken),
    lockedFor: lockRemaining(user),
  };
}

/** Shape sent to an admin managing the household. */
export function managedUser(user: User) {
  return {
    ...publicUser(user),
    createdAt: user.createdAt,
    lockedFor: lockRemaining(user),
  };
}
