import type { Request, Response, NextFunction } from 'express';
import { findUser, touchDevice, type User } from '../services/users';

declare module 'express-serve-static-core' {
  interface Request {
    /** The signed-in account, attached by requireAuth. */
    user?: User;
  }
}

export const DEVICE_COOKIE = 'sv_device';

/** Raw device token from the signed cookie, if the browser has one. */
export function deviceToken(req: Request): string | undefined {
  const value = req.signedCookies?.[DEVICE_COOKIE];
  return typeof value === 'string' && value ? value : undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const id = req.session?.userId;
  const user = id ? findUser(id) : undefined;
  // A deleted account keeps its session cookie — drop it rather than trusting it.
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
  req.user = user;
  touchDevice(user, deviceToken(req));
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isAdmin) { res.status(403).json({ error: 'Admin only' }); return; }
  next();
}
