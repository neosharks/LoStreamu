import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getConfig, saveConfig } from '../config';
import { requireAuth } from '../middleware/auth';
import { loadUsers } from '../services/users';

const router = Router();

const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const ChangeSchema = z.object({
  currentPassword: z.string().min(1),
  email: z.string().email().optional(),
  newPassword: z.string().min(8).optional(),
});

router.get('/me', requireAuth, (req, res) => {
  const cfg = getConfig();
  res.json({ email: req.session.userId, isAdmin: req.session.userId === cfg.email });
});

router.get('/setup-state', (_req, res) => {
  res.json({ hasAccount: !!getConfig().passwordHash });
});

// First-run only — blocked once an admin account exists
router.post('/signup', async (req, res) => {
  if (getConfig().passwordHash) { res.status(403).json({ error: 'Account already exists.' }); return; }
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8) {
    res.status(400).json({ error: 'Valid email and password (min 8 chars) required.' }); return;
  }
  const hash = await bcrypt.hash(password, 12);
  saveConfig({ email, passwordHash: hash });
  req.session.userId = email;
  res.json({ ok: true });
});

router.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid email or password.' }); return; }
  const { email, password } = parsed.data;
  const cfg = getConfig();

  // Check admin account first
  if (cfg.email && cfg.email === email) {
    const ok = cfg.passwordHash && await bcrypt.compare(password, cfg.passwordHash);
    if (!ok) { res.status(401).json({ error: 'Invalid email or password.' }); return; }
    req.session.userId = email;
    res.json({ ok: true });
    return;
  }

  // Check managed users
  const user = loadUsers().find(u => u.email === email);
  if (!user) { res.status(401).json({ error: 'Invalid email or password.' }); return; }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) { res.status(401).json({ error: 'Invalid email or password.' }); return; }
  req.session.userId = email;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/change-password', requireAuth, async (req, res) => {
  const parsed = ChangeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }); return; }
  const { currentPassword, email, newPassword } = parsed.data;
  const cfg = getConfig();
  const isAdmin = req.session.userId === cfg.email;

  if (isAdmin) {
    const ok = await bcrypt.compare(currentPassword, cfg.passwordHash);
    if (!ok) { res.status(401).json({ error: 'Current password is incorrect.' }); return; }
    const updates: Record<string, string> = {};
    if (email) updates.email = email;
    if (newPassword) updates.passwordHash = await bcrypt.hash(newPassword, 12);
    saveConfig(updates);
    if (email) req.session.userId = email;
  } else {
    // Managed user changing their own password
    const users = loadUsers();
    const idx = users.findIndex(u => u.email === req.session.userId);
    if (idx === -1) { res.status(404).json({ error: 'User not found.' }); return; }
    const ok = await bcrypt.compare(currentPassword, users[idx]!.passwordHash);
    if (!ok) { res.status(401).json({ error: 'Current password is incorrect.' }); return; }
    if (newPassword) users[idx]!.passwordHash = await bcrypt.hash(newPassword, 12);
    const { saveUsers } = await import('../services/users');
    saveUsers(users);
  }
  res.json({ ok: true });
});

export default router;
