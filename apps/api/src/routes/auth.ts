// Auth route handlers, mounted under /api/auth/* (all PUBLIC except those that
// internally call requireAuth/requireAdmin via the router in index.ts).
//
// Security posture:
//  - No user enumeration: /login → generic 401; /request-reset → always 200.
//  - Per-email lockout: 5 fails → 15 min lock.
//  - bcrypt(12) password hashes; sha256-only token storage.
//  - 2FA via OTP (whatsapp|email), 6-digit, 10-min, 5 attempts.

import { Router, type Request, type Response } from 'express';
import * as notify from '../notify';
import * as store from '../store';
import { clientIp, requireAdmin, requireAuth, userAgent } from '../auth/middleware';
import {
  clearSessionCookie,
  readCookie,
  setSessionCookie,
  setTrustedDeviceCookie,
  SID,
  TDID,
} from '../auth/cookies';
import { assertStrongPassword, hashPassword, verifyPassword } from '../auth/password';
import {
  clearLoginAttempts,
  consumeSetupToken,
  createSetupToken,
  createUser,
  deleteUser,
  findUserByEmail,
  findUserById,
  isLockedOut,
  normalizeEmail,
  publicUser,
  recordFailedLogin,
  setPasswordHash,
} from '../auth/users';
import {
  consumeResetToken,
  createOtp,
  createResetToken,
  createSession,
  createTrustedDevice,
  hasValidTrustedDevice,
  listSessions,
  listTrustedDevices,
  revokeAllUserSessions,
  revokeSessionById,
  revokeSessionByToken,
  revokeTrustedDevice,
  revokeUserOtps,
  revokeUserResetTokens,
  verifyOtp,
} from '../auth/sessions';
import type { AuthUser, TwoFactorChannel } from '../store';

export const authRouter = Router();

const RESET_BASE = 'https://energy.hirobo.nl/reset';

function ctx(req: Request) {
  return { ua: userAgent(req), ip: clientIp(req) };
}

/** Deliver an OTP / link over the user's 2FA channel (whatsapp or email). */
async function deliverOtp(user: AuthUser, code: string): Promise<void> {
  const text = `Your Power login code is ${code}. It expires in 10 minutes.`;
  if (user.twoFactor.channel === 'email') {
    await notify.sendEmail(user.email, 'Power login code', text);
  } else {
    const number = store.get().channels.whatsapp.number;
    await notify.sendWhatsApp(number, text);
  }
}

// ---- POST /login --------------------------------------------------------

authRouter.post('/login', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');

  // Lockout is checked first; response is the same generic 401 to avoid
  // distinguishing locked vs. wrong-password (no enumeration / oracle).
  if (!email || isLockedOut(email)) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const user = findUserByEmail(email);
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    if (user) recordFailedLogin(email); // only count attempts on real accounts
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  clearLoginAttempts(email);

  // 2FA: require an OTP unless this device is already trusted.
  const trusted = hasValidTrustedDevice(user.id, readCookie(req, TDID));
  if (user.twoFactor.enabled && !trusted) {
    const code = createOtp(user.id, 'login');
    console.log(`[auth] login OTP for ${user.email}: ${code}`);
    await deliverOtp(user, code);
    res.json({ step: 'otp', channel: user.twoFactor.channel });
    return;
  }

  const token = createSession(user.id, ctx(req));
  setSessionCookie(res, token);
  res.json({ user: publicUser(user) });
});

// ---- POST /verify-otp ---------------------------------------------------

authRouter.post('/verify-otp', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    email?: unknown;
    code?: unknown;
    trustDevice?: unknown;
  };
  const email = normalizeEmail(body.email);
  const code = String(body.code ?? '');
  const user = email ? findUserByEmail(email) : undefined;
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired code' });
    return;
  }

  const result = verifyOtp(user.id, 'login', code);
  if (result !== 'ok') {
    res.status(401).json({ error: 'Invalid or expired code' });
    return;
  }

  const token = createSession(user.id, ctx(req));
  setSessionCookie(res, token);

  if (body.trustDevice === true) {
    const tdToken = createTrustedDevice(user.id, userAgent(req));
    setTrustedDeviceCookie(res, tdToken);
  }

  res.json({ user: publicUser(user) });
});

// ---- POST /logout -------------------------------------------------------

authRouter.post('/logout', (req: Request, res: Response) => {
  revokeSessionByToken(readCookie(req, SID));
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---- GET /me ------------------------------------------------------------

authRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({ user: publicUser(req.user as AuthUser) });
});

// ---- POST /request-reset (ALWAYS 200) -----------------------------------

authRouter.post('/request-reset', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: unknown };
  const email = normalizeEmail(body.email);
  const user = email ? findUserByEmail(email) : undefined;
  if (user) {
    const token = createResetToken(user.id);
    const link = `${RESET_BASE}?token=${token}`;
    console.log(`[auth] password reset link for ${user.email}: ${link}`);
    const text = `Reset your Power password: ${link} (expires in 1 hour).`;
    if (user.twoFactor.channel === 'email') {
      await notify.sendEmail(user.email, 'Power password reset', text);
    } else {
      await notify.sendWhatsApp(store.get().channels.whatsapp.number, text);
    }
  }
  // Same response whether or not the email exists.
  res.json({ ok: true });
});

// ---- POST /reset --------------------------------------------------------

authRouter.post('/reset', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { token?: unknown; password?: unknown };
  const token = String(body.token ?? '');
  let password: string;
  try {
    password = assertStrongPassword(body.password);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message, code: 'BAD_INPUT' });
    return;
  }

  const user = consumeResetToken(token);
  if (!user) {
    res.status(400).json({ error: 'Invalid or expired reset token', code: 'BAD_INPUT' });
    return;
  }

  const hash = await hashPassword(password);
  setPasswordHash(user.id, hash);
  // Invalidate everything for that user: sessions, OTPs, reset tokens.
  revokeAllUserSessions(user.id);
  revokeUserOtps(user.id);
  revokeUserResetTokens(user.id);
  clearLoginAttempts(user.email);

  res.json({ ok: true });
});

// ---- POST /setup --------------------------------------------------------

authRouter.post('/setup', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { token?: unknown; password?: unknown; name?: unknown };
  const token = String(body.token ?? '');
  let password: string;
  try {
    password = assertStrongPassword(body.password);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message, code: 'BAD_INPUT' });
    return;
  }

  const user = consumeSetupToken(token);
  if (!user) {
    res.status(400).json({ error: 'Invalid or expired setup token', code: 'BAD_INPUT' });
    return;
  }

  const hash = await hashPassword(password);
  setPasswordHash(user.id, hash);
  const name = String(body.name ?? '').trim();
  if (name) {
    store.update((s) => {
      const u = s.auth.users.find((x) => x.id === user.id);
      if (u) u.name = name;
    });
  }

  const fresh = findUserById(user.id) as AuthUser;
  const sessionToken = createSession(fresh.id, ctx(req));
  setSessionCookie(res, sessionToken);
  res.json({ user: publicUser(fresh) });
});

// ---- POST /2fa (session) ------------------------------------------------

authRouter.post('/2fa', requireAuth, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { enabled?: unknown; channel?: unknown };
  const enabled = Boolean(body.enabled);
  const channel: TwoFactorChannel = body.channel === 'email' ? 'email' : 'whatsapp';
  const user = req.user as AuthUser;
  store.update((s) => {
    const u = s.auth.users.find((x) => x.id === user.id);
    if (u) u.twoFactor = { enabled, channel };
  });
  res.json({ twoFactor: { enabled, channel } });
});

// ---- GET /sessions + revoke ---------------------------------------------

authRouter.get('/sessions', requireAuth, (req: Request, res: Response) => {
  const user = req.user as AuthUser;
  const sessions = listSessions(user.id).map((s) => ({
    id: s.tokenHash, // hash doubles as the opaque revoke id (not the raw token)
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    ua: s.ua,
    ip: s.ip,
  }));
  const trustedDevices = listTrustedDevices(user.id).map((d) => ({
    id: d.id,
    label: d.label,
    createdAt: d.createdAt,
    expiresAt: d.expiresAt,
    lastUsed: d.lastUsed,
  }));
  res.json({ sessions, trustedDevices });
});

authRouter.delete('/sessions/:id', requireAuth, (req: Request, res: Response) => {
  const user = req.user as AuthUser;
  const ok = revokeSessionById(user.id, String(req.params.id));
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});

authRouter.delete('/trusted/:id', requireAuth, (req: Request, res: Response) => {
  const user = req.user as AuthUser;
  const ok = revokeTrustedDevice(user.id, String(req.params.id));
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});

// ---- ADMIN: users -------------------------------------------------------

authRouter.get('/users', requireAdmin, (_req: Request, res: Response) => {
  const users = store.get().auth.users.map((u) => ({
    ...publicUser(u),
    twoFactor: u.twoFactor,
    hasPassword: u.passwordHash !== null,
    createdAt: u.createdAt,
  }));
  res.json({ users });
});

authRouter.post('/users', requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: unknown; name?: unknown; role?: unknown };
  try {
    const user = createUser({
      email: String(body.email ?? ''),
      name: String(body.name ?? ''),
      role: body.role === 'admin' ? 'admin' : 'user',
    });
    const token = createSetupToken(user);
    res.json({
      user: publicUser(user),
      setupToken: token,
      setupUrl: `https://energy.hirobo.nl/setup?token=${token}`,
    });
  } catch (e) {
    const err = e as Error & { code?: string };
    res.status(err.code === 'BAD_INPUT' ? 400 : 500).json({
      error: err.message,
      code: err.code ?? 'ERROR',
    });
  }
});

authRouter.delete('/users/:id', requireAdmin, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const self = req.user as AuthUser;
  if (id === self.id) {
    res.status(400).json({ error: 'Cannot delete your own account', code: 'BAD_INPUT' });
    return;
  }
  const ok = deleteUser(id);
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});
