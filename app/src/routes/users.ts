import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  AVATAR_KEYS, adminCount, clearFailures, createUser, deleteUser, findUser,
  findUserByEmail, forgetDevices, hashPin, loadUsers, managedUser, saveUsers,
  validatePin,
} from '../services/users';

const router = Router();

const PinField = z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits.');

const CreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(40),
  email: z.string().email('A valid email address is required.'),
  pin: PinField,
  avatar: z.enum(AVATAR_KEYS).optional(),
  isAdmin: z.boolean().optional(),
});

const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  email: z.string().email('A valid email address is required.').optional(),
  avatar: z.enum(AVATAR_KEYS).optional(),
  isAdmin: z.boolean().optional(),
  pin: PinField.optional(),
});

router.get('/users', requireAuth, requireAdmin, (_req, res) => {
  res.json(loadUsers().map(managedUser));
});

router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }); return; }
  const { name, email, pin, avatar, isAdmin } = parsed.data;

  const policy = validatePin(pin);
  if (policy) { res.status(400).json({ error: policy }); return; }
  if (findUserByEmail(email)) { res.status(400).json({ error: 'A profile with that email already exists.' }); return; }

  const user = await createUser({
    name, email, pin,
    ...(avatar ? { avatar } : {}),
    ...(isAdmin ? { isAdmin } : {}),
  });
  res.json({ ok: true, user: managedUser(user) });
});

// Admins manage the household: rename a profile, fix an email, hand out a new
// PIN when someone forgets theirs. An admin's own PIN has no such fallback.
router.patch('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }); return; }
  const target = findUser(req.params['id'] as string);
  if (!target) { res.status(404).json({ error: 'Profile not found.' }); return; }
  const { name, email, avatar, isAdmin, pin } = parsed.data;

  if (isAdmin === false && target.isAdmin && adminCount() <= 1) {
    res.status(400).json({ error: 'The last admin cannot be demoted.' }); return;
  }
  if (email) {
    const clash = findUserByEmail(email);
    if (clash && clash.id !== target.id) { res.status(400).json({ error: 'Another profile already uses that email.' }); return; }
    target.email = email.toLowerCase();
  }
  if (pin) {
    const policy = validatePin(pin);
    if (policy) { res.status(400).json({ error: policy }); return; }
    target.pinHash = await hashPin(pin);
    // A PIN handed out by an admin invalidates the old browser trust, so the
    // owner's next login proves both the new PIN and the email.
    forgetDevices(target);
    clearFailures(target);
  }
  if (name) target.name = name;
  if (avatar) target.avatar = avatar;
  if (isAdmin !== undefined) target.isAdmin = isAdmin;
  saveUsers();
  res.json({ ok: true, user: managedUser(target) });
});

// Clear a lockout early instead of waiting the window out.
router.post('/users/:id/unlock', requireAuth, requireAdmin, (req, res) => {
  const target = findUser(req.params['id'] as string);
  if (!target) { res.status(404).json({ error: 'Profile not found.' }); return; }
  clearFailures(target);
  res.json({ ok: true, user: managedUser(target) });
});

router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = findUser(req.params['id'] as string);
  if (!target) { res.status(404).json({ error: 'Profile not found.' }); return; }
  if (target.id === req.user!.id) { res.status(400).json({ error: 'You cannot delete your own profile.' }); return; }
  if (target.isAdmin && adminCount() <= 1) { res.status(400).json({ error: 'The last admin cannot be deleted.' }); return; }
  deleteUser(target.id);
  res.json({ ok: true });
});

export default router;
