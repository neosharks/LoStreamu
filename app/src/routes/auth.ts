import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, deviceToken, DEVICE_COOKIE } from '../middleware/auth';
import {
  AVATAR_KEYS, clearFailures, findUser, findUserByEmail, forgetDevices, hasAccounts,
  hashPin, isTrustedDevice, loadUsers, lockRemaining, profileCard, publicUser,
  recordFailure, saveUsers, touchDevice, trustDevice, validatePin, verifyPin, createUser,
} from '../services/users';

const router = Router();

const DEVICE_MAX_AGE = 180 * 24 * 60 * 60 * 1000;  // 6 months, matches the store

const PinField = z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits.');
const AvatarField = z.enum(AVATAR_KEYS);

const SetupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(40),
  email: z.string().email('A valid email address is required.'),
  pin: PinField,
  avatar: AvatarField.optional(),
});

const LoginSchema = z.object({
  userId: z.string().min(1),
  pin: PinField,
  email: z.string().trim().optional(),
  remember: z.boolean().optional(),
});

const ProfileSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  avatar: AvatarField.optional(),
  email: z.string().email('A valid email address is required.').optional(),
  currentPin: z.string().optional(),
  newPin: PinField.optional(),
});

// Issue the long-lived device token that turns later logins into PIN-only.
function issueDevice(res: import('express').Response, token: string): void {
  res.cookie(DEVICE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    maxAge: DEVICE_MAX_AGE,
  });
}

router.get('/me', requireAuth, (req, res) => {
  res.json(publicUser(req.user!));
});

router.get('/setup-state', (_req, res) => {
  res.json({ hasAccount: hasAccounts() });
});

// The Netflix-style profile row. Unauthenticated by design, so it exposes only
// display data — never emails, PIN state or attempt counters.
router.get('/profiles', (req, res) => {
  const token = deviceToken(req);
  res.json({
    profiles: loadUsers()
      .filter(u => !!u.pinHash)
      .sort((a, b) => (Number(b.isAdmin) - Number(a.isAdmin)) || a.createdAt - b.createdAt)
      .map(u => profileCard(u, token)),
  });
});

// First-run only — blocked forever once an account exists.
router.post('/setup', async (req, res) => {
  if (hasAccounts()) { res.status(403).json({ error: 'Setup has already been completed.' }); return; }
  const parsed = SetupSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }); return; }
  const { name, email, pin, avatar } = parsed.data;

  const policy = validatePin(pin);
  if (policy) { res.status(400).json({ error: policy }); return; }

  const user = await createUser({ name, email, pin, isAdmin: true, ...(avatar ? { avatar } : {}) });
  req.session.userId = user.id;
  issueDevice(res, trustDevice(user, req.headers['user-agent']));
  res.json({ ok: true, user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }); return; }
  const { userId, pin, email, remember } = parsed.data;

  const user = findUser(userId);
  if (!user || !user.pinHash) { res.status(401).json({ error: 'Incorrect PIN.' }); return; }

  const locked = lockRemaining(user);
  if (locked) {
    res.status(429).json({ error: `Too many attempts. Try again in ${locked}s.`, retryAfter: locked });
    return;
  }

  // A browser the server has never seen needs email + PIN. Once it is trusted,
  // the PIN alone is enough. A wrong email counts as a failed attempt so the
  // pairing can't be brute-forced either.
  const trusted = isTrustedDevice(user, deviceToken(req));
  if (!trusted) {
    if (!email) { res.status(400).json({ error: 'Email is required on a new device.', needsEmail: true }); return; }
    if (email.trim().toLowerCase() !== user.email) {
      const retryAfter = recordFailure(user);
      res.status(401).json({ error: 'Email and PIN do not match.', needsEmail: true, ...(retryAfter ? { retryAfter } : {}) });
      return;
    }
  }

  if (!await verifyPin(user, pin)) {
    const retryAfter = recordFailure(user);
    res.status(401).json({
      error: retryAfter ? `Incorrect PIN. Locked for ${retryAfter}s.` : 'Incorrect PIN.',
      ...(trusted ? {} : { needsEmail: true }),
      ...(retryAfter ? { retryAfter } : {}),
    });
    return;
  }

  clearFailures(user);
  req.session.userId = user.id;
  // Default to remembering — that is what makes the next login PIN-only. A
  // shared browser can opt out and will be asked for the email again. An
  // already-trusted browser keeps its existing token, so repeat sign-ins don't
  // pile up records and evict someone else's device.
  if (trusted) touchDevice(user, deviceToken(req));
  else if (remember !== false) issueDevice(res, trustDevice(user, req.headers['user-agent']));
  res.json({ ok: true, user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  // The device token deliberately survives sign-out — that is the whole point
  // of trusting the browser. "Forget devices" in settings clears it.
  req.session.destroy(() => res.json({ ok: true }));
});

// Self-service profile edits. Changing the email or the PIN needs the current
// PIN, so a hijacked tab can't quietly take the account over.
router.post('/profile', requireAuth, async (req, res) => {
  const parsed = ProfileSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }); return; }
  const { name, avatar, email, currentPin, newPin } = parsed.data;
  const user = req.user!;
  const sensitive = !!newPin || (!!email && email.toLowerCase() !== user.email);

  if (sensitive) {
    if (!currentPin) { res.status(400).json({ error: 'Enter your current PIN to save this change.' }); return; }
    const locked = lockRemaining(user);
    if (locked) { res.status(429).json({ error: `Too many attempts. Try again in ${locked}s.`, retryAfter: locked }); return; }
    if (!await verifyPin(user, currentPin)) {
      const retryAfter = recordFailure(user);
      res.status(401).json({ error: 'Current PIN is incorrect.', ...(retryAfter ? { retryAfter } : {}) });
      return;
    }
    clearFailures(user);
  }

  if (newPin) {
    const policy = validatePin(newPin);
    if (policy) { res.status(400).json({ error: policy }); return; }
    if (await verifyPin(user, newPin)) { res.status(400).json({ error: 'That is already your PIN.' }); return; }
    user.pinHash = await hashPin(newPin);
  }
  if (email) {
    const clash = findUserByEmail(email);
    if (clash && clash.id !== user.id) { res.status(400).json({ error: 'Another profile already uses that email.' }); return; }
    user.email = email.toLowerCase();
  }
  if (name) user.name = name;
  if (avatar) user.avatar = avatar;
  saveUsers();
  res.json({ ok: true, user: publicUser(user) });
});

// Drop every trusted browser for this account — the next login anywhere needs
// email + PIN again. The recovery move after a device is lost or stolen.
router.post('/profile/forget-devices', requireAuth, (req, res) => {
  forgetDevices(req.user!);
  res.clearCookie(DEVICE_COOKIE);
  res.json({ ok: true });
});

export default router;
