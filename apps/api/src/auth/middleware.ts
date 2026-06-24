// Auth middleware: requireAuth validates the `sid` cookie and attaches the
// user; requireAdmin additionally enforces the admin role.

import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from '../store';
import { readCookie, SID } from './cookies';
import { validateSession } from './sessions';

// Augment Express Request with the authenticated user.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? '';
}

export function userAgent(req: Request): string {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : '';
}

/** Validate the session cookie, refresh expiry, attach req.user, or 401. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const raw = readCookie(req, SID);
  const result = validateSession(raw);
  if (!result) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.user = result.user;
  next();
}

/** requireAuth + admin role. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  });
}
