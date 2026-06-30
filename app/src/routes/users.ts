import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getConfig } from '../config';
import { requireAuth } from '../middleware/auth';
import { loadUsers, saveUsers } from '../services/users';
import type { Request, Response, NextFunction } from 'express';

const router = Router();

const CreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  if (req.session.userId !== getConfig().email) { res.status(403).json({ error: 'Admin only' }); return; }
  next();
}

router.get('/users', requireAuth, requireAdmin, (_req, res) => {
  res.json(loadUsers().map(u => ({ email: u.email })));
});

router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }); return; }
  const { email, password } = parsed.data;
  if (email === getConfig().email) { res.status(400).json({ error: 'That email belongs to the admin account' }); return; }
  const users = loadUsers();
  if (users.find(u => u.email === email)) { res.status(400).json({ error: 'User already exists' }); return; }
  users.push({ email, passwordHash: await bcrypt.hash(password, 12) });
  saveUsers(users);
  res.json({ ok: true });
});

router.delete('/users/:email', requireAuth, requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params['email'] as string);
  saveUsers(loadUsers().filter(u => u.email !== email));
  res.json({ ok: true });
});

export default router;
