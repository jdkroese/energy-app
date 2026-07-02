// User records, login-attempt lockout, and setup-token lifecycle.
// store.ts stays the persistence layer; this module owns the auth domain logic.

import { randomUUID } from 'node:crypto';
import * as store from '../store';
import type { AuthUser, UserRole } from '../store';
import {
  generateToken,
  sha256,
  tokenMatches,
  LOGIN_LOCK_MS,
  LOGIN_MAX_ATTEMPTS,
  SETUP_TTL_MS,
} from './tokens';

export function normalizeEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

export function findUserByEmail(email: string): AuthUser | undefined {
  const norm = normalizeEmail(email);
  return store.get().auth.users.find((u) => u.email.toLowerCase() === norm);
}

export function findUserById(id: string): AuthUser | undefined {
  return store.get().auth.users.find((u) => u.id === id);
}

/** Public-safe projection of a user (no hash, no internals). */
export function publicUser(u: AuthUser): {
  id: string;
  email: string;
  name: string;
  role: UserRole;
} {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: UserRole;
}

/** Create a passwordHash:null user. Throws BAD_INPUT on dup/invalid. */
export function createUser(input: CreateUserInput): AuthUser {
  const email = normalizeEmail(input.email);
  const name = String(input.name ?? '').trim();
  const role: UserRole = input.role === 'admin' ? 'admin' : 'user';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    const e = new Error('Invalid email') as Error & { code: string };
    e.code = 'BAD_INPUT';
    throw e;
  }
  if (findUserByEmail(email)) {
    const e = new Error('A user with that email already exists') as Error & { code: string };
    e.code = 'BAD_INPUT';
    throw e;
  }
  const user: AuthUser = {
    id: randomUUID(),
    email,
    name: name || email,
    role,
    passwordHash: null,
    // Default to email: it's the universally-configured channel (Resend), so a
    // new user can never be locked out by an unconfigured WhatsApp provider.
    twoFactor: { enabled: false, channel: 'email' },
    createdAt: Date.now(),
  };
  store.update((s) => {
    s.auth.users.push(user);
  });
  return user;
}

/**
 * Ensure the single kiosk (wall-tablet) user exists and return it. The kiosk account has
 * a fixed identity (email `kiosk@local`, name `Wall tablet`, role `'kiosk'`) and NO
 * password (passwordHash null) — it can never log in by credentials; a session is minted
 * for it only via the admin-gated provisioning route. Idempotent: returns the existing
 * record when already seeded.
 */
export function ensureKioskUser(): AuthUser {
  const email = 'kiosk@local';
  const existing = findUserByEmail(email);
  if (existing) return existing;
  const user: AuthUser = {
    id: randomUUID(),
    email,
    name: 'Wall tablet',
    role: 'kiosk',
    passwordHash: null,
    twoFactor: { enabled: false, channel: 'email' },
    createdAt: Date.now(),
  };
  store.update((s) => {
    s.auth.users.push(user);
  });
  return user;
}

export function deleteUser(id: string): boolean {
  return store.update((s) => {
    const before = s.auth.users.length;
    s.auth.users = s.auth.users.filter((u) => u.id !== id);
    if (s.auth.users.length === before) return false;
    // Cascade: drop all of the user's auth artifacts.
    s.auth.sessions = s.auth.sessions.filter((x) => x.userId !== id);
    s.auth.trustedDevices = s.auth.trustedDevices.filter((x) => x.userId !== id);
    s.auth.otps = s.auth.otps.filter((x) => x.userId !== id);
    s.auth.resetTokens = s.auth.resetTokens.filter((x) => x.userId !== id);
    s.auth.setupTokens = s.auth.setupTokens.filter((x) => x.userId !== id);
    return true;
  });
}

export function setPasswordHash(userId: string, hash: string): void {
  store.update((s) => {
    const u = s.auth.users.find((x) => x.id === userId);
    if (u) u.passwordHash = hash;
  });
}

// ---- Login-attempt lockout ---------------------------------------------

/** True if the email is currently locked out. */
export function isLockedOut(email: string): boolean {
  const norm = normalizeEmail(email);
  const rec = store.get().auth.loginAttempts[norm];
  return !!rec && rec.lockedUntil > Date.now();
}

/** Register a failed login; lock after LOGIN_MAX_ATTEMPTS. */
export function recordFailedLogin(email: string): void {
  const norm = normalizeEmail(email);
  store.update((s) => {
    const rec = s.auth.loginAttempts[norm] ?? { count: 0, lockedUntil: 0 };
    if (rec.lockedUntil > Date.now()) return; // already locked
    rec.count += 1;
    if (rec.count >= LOGIN_MAX_ATTEMPTS) {
      rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
      rec.count = 0;
    }
    s.auth.loginAttempts[norm] = rec;
  });
}

/** Clear the failure counter on a successful login. */
export function clearLoginAttempts(email: string): void {
  const norm = normalizeEmail(email);
  store.update((s) => {
    delete s.auth.loginAttempts[norm];
  });
}

// ---- Setup tokens -------------------------------------------------------

/** Create a single-use setup token; returns the RAW token (store keeps hash). */
export function createSetupToken(
  user: AuthUser,
  ttlMs: number = SETUP_TTL_MS,
): string {
  const raw = generateToken();
  store.update((s) => {
    s.auth.setupTokens.push({
      tokenHash: sha256(raw),
      userId: user.id,
      email: user.email,
      expiresAt: Date.now() + ttlMs,
    });
  });
  return raw;
}

/** Validate & consume a setup token (single-use). Returns the user or null. */
export function consumeSetupToken(raw: string): AuthUser | null {
  if (!raw) return null;
  return store.update((s) => {
    const now = Date.now();
    s.auth.setupTokens = s.auth.setupTokens.filter((t) => t.expiresAt > now);
    const idx = s.auth.setupTokens.findIndex((t) => tokenMatches(raw, t.tokenHash));
    if (idx === -1) return null;
    const tok = s.auth.setupTokens[idx];
    s.auth.setupTokens.splice(idx, 1); // single-use
    return s.auth.users.find((u) => u.id === tok.userId) ?? null;
  });
}

// ---- Bootstrap ----------------------------------------------------------

/**
 * On boot, if there are no users, seed one admin (passwordHash null) and
 * print a setup URL to the service log. No open self-signup.
 */
export function bootstrapAdmin(): void {
  const users = store.get().auth.users;
  if (users.length > 0) return;

  const email = normalizeEmail(process.env.ADMIN_EMAIL ?? 'j.kroese@levante.nl');
  const admin: AuthUser = {
    id: randomUUID(),
    email,
    name: 'Joris',
    role: 'admin',
    passwordHash: null,
    twoFactor: { enabled: false, channel: 'email' },
    createdAt: Date.now(),
  };
  store.update((s) => {
    s.auth.users.push(admin);
  });
  const raw = createSetupToken(admin, SETUP_TTL_MS);
  console.log(
    `[auth] SETUP — set the admin password at: https://home.hirobo.nl/setup?token=${raw}`,
  );
}
