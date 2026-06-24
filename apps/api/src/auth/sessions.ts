// Sessions, trusted devices, login/reset OTPs and reset tokens.
// All values are generated as raw secrets and persisted only as sha256 hashes.

import { randomUUID } from 'node:crypto';
import * as store from '../store';
import type {
  AuthSession,
  AuthTrustedDevice,
  AuthUser,
  OtpPurpose,
} from '../store';
import {
  generateOtp,
  generateToken,
  sha256,
  tokenMatches,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  RESET_TTL_MS,
  SESSION_TTL_MS,
  TRUSTED_DEVICE_TTL_MS,
} from './tokens';

// ---- Sessions -----------------------------------------------------------

export interface SessionContext {
  ua: string;
  ip: string;
}

/** Create a session; returns the RAW session token (goes into the `sid` cookie). */
export function createSession(userId: string, ctx: SessionContext): string {
  const raw = generateToken();
  const now = Date.now();
  store.update((s) => {
    s.auth.sessions.push({
      tokenHash: sha256(raw),
      userId,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      ua: ctx.ua.slice(0, 256),
      ip: ctx.ip.slice(0, 64),
    });
  });
  return raw;
}

/**
 * Validate a raw session token: must exist and be unexpired. On success the
 * expiry is refreshed (sliding window) and the user is returned.
 */
export function validateSession(
  raw: string | undefined,
): { user: AuthUser; session: AuthSession } | null {
  if (!raw) return null;
  // Hot path: READ-ONLY (no state-file write) for the common case.
  const s = store.get();
  const now = Date.now();
  const session = s.auth.sessions.find((x) => x.expiresAt > now && tokenMatches(raw, x.tokenHash));
  if (!session) return null;
  const user = s.auth.users.find((u) => u.id === session.userId);
  if (!user) return null;

  // Sliding refresh — but only persist at most ~once/hour to avoid a disk write
  // on every authenticated request (10s polling would otherwise thrash state.json).
  if (session.expiresAt - now < SESSION_TTL_MS - 3_600_000) {
    store.update((st) => {
      const live = st.auth.sessions.find((x) => x.tokenHash === session.tokenHash);
      if (live) live.expiresAt = Date.now() + SESSION_TTL_MS;
    });
  }
  return { user, session };
}

/** Revoke the session whose raw token is given. */
export function revokeSessionByToken(raw: string | undefined): void {
  if (!raw) return;
  store.update((s) => {
    s.auth.sessions = s.auth.sessions.filter((x) => !tokenMatches(raw, x.tokenHash));
  });
}

/** Revoke a session by its tokenHash id (used by the sessions list UI). */
export function revokeSessionById(userId: string, tokenHash: string): boolean {
  return store.update((s) => {
    const before = s.auth.sessions.length;
    s.auth.sessions = s.auth.sessions.filter(
      (x) => !(x.userId === userId && x.tokenHash === tokenHash),
    );
    return s.auth.sessions.length < before;
  });
}

export function revokeAllUserSessions(userId: string): void {
  store.update((s) => {
    s.auth.sessions = s.auth.sessions.filter((x) => x.userId !== userId);
  });
}

export function listSessions(userId: string): AuthSession[] {
  const now = Date.now();
  return store.get().auth.sessions.filter((x) => x.userId === userId && x.expiresAt > now);
}

// ---- Trusted devices ----------------------------------------------------

/** Summarize a UA string into a short human label. */
export function uaLabel(ua: string): string {
  const s = ua || 'Unknown device';
  let os = 'Unknown OS';
  if (/windows/i.test(s)) os = 'Windows';
  else if (/iphone|ipad|ios/i.test(s)) os = 'iOS';
  else if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/android/i.test(s)) os = 'Android';
  else if (/linux/i.test(s)) os = 'Linux';
  let br = 'browser';
  if (/edg\//i.test(s)) br = 'Edge';
  else if (/chrome\//i.test(s)) br = 'Chrome';
  else if (/firefox\//i.test(s)) br = 'Firefox';
  else if (/safari\//i.test(s)) br = 'Safari';
  return `${br} on ${os}`;
}

/** Create a trusted device; returns the RAW token (goes into the `tdid` cookie). */
export function createTrustedDevice(userId: string, ua: string): string {
  const raw = generateToken();
  const now = Date.now();
  store.update((s) => {
    s.auth.trustedDevices.push({
      id: randomUUID(),
      tokenHash: sha256(raw),
      userId,
      label: uaLabel(ua),
      createdAt: now,
      expiresAt: now + TRUSTED_DEVICE_TTL_MS,
      lastUsed: now,
    });
  });
  return raw;
}

/**
 * True if the raw `tdid` token is a valid, unexpired trusted device for the
 * given user. Updates lastUsed on a hit.
 */
export function hasValidTrustedDevice(userId: string, raw: string | undefined): boolean {
  if (!raw) return false;
  return store.update((s) => {
    const now = Date.now();
    s.auth.trustedDevices = s.auth.trustedDevices.filter((x) => x.expiresAt > now);
    const dev = s.auth.trustedDevices.find(
      (x) => x.userId === userId && tokenMatches(raw, x.tokenHash),
    );
    if (!dev) return false;
    dev.lastUsed = now;
    return true;
  });
}

export function listTrustedDevices(userId: string): AuthTrustedDevice[] {
  const now = Date.now();
  return store
    .get()
    .auth.trustedDevices.filter((x) => x.userId === userId && x.expiresAt > now);
}

export function revokeTrustedDevice(userId: string, id: string): boolean {
  return store.update((s) => {
    const before = s.auth.trustedDevices.length;
    s.auth.trustedDevices = s.auth.trustedDevices.filter(
      (x) => !(x.userId === userId && x.id === id),
    );
    return s.auth.trustedDevices.length < before;
  });
}

// ---- OTPs ---------------------------------------------------------------

/**
 * Create an OTP for a user+purpose. Replaces any prior OTP for the same
 * purpose. Returns the RAW 6-digit code (sent via channel; never stored raw).
 */
export function createOtp(userId: string, purpose: OtpPurpose): string {
  const code = generateOtp();
  const now = Date.now();
  store.update((s) => {
    s.auth.otps = s.auth.otps.filter(
      (o) => !(o.userId === userId && o.purpose === purpose),
    );
    s.auth.otps.push({
      userId,
      codeHash: sha256(code),
      purpose,
      createdAt: now,
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
    });
  });
  return code;
}

export type OtpResult = 'ok' | 'invalid' | 'expired' | 'too-many-attempts';

/**
 * Verify an OTP code. On success the OTP is consumed. Tracks attempts and
 * invalidates after OTP_MAX_ATTEMPTS. Constant-time hash compare.
 */
export function verifyOtp(userId: string, purpose: OtpPurpose, code: string): OtpResult {
  return store.update((s) => {
    const now = Date.now();
    const otp = s.auth.otps.find((o) => o.userId === userId && o.purpose === purpose);
    if (!otp) return 'invalid';
    if (otp.expiresAt <= now) {
      s.auth.otps = s.auth.otps.filter((o) => o !== otp);
      return 'expired';
    }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      s.auth.otps = s.auth.otps.filter((o) => o !== otp);
      return 'too-many-attempts';
    }
    if (tokenMatches(String(code), otp.codeHash)) {
      s.auth.otps = s.auth.otps.filter((o) => o !== otp); // consume
      return 'ok';
    }
    otp.attempts += 1;
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      s.auth.otps = s.auth.otps.filter((o) => o !== otp); // invalidate
    }
    return 'invalid';
  });
}

export function revokeUserOtps(userId: string): void {
  store.update((s) => {
    s.auth.otps = s.auth.otps.filter((o) => o.userId !== userId);
  });
}

// ---- Reset tokens -------------------------------------------------------

/** Create a single-use reset token; returns the RAW token (goes in the link). */
export function createResetToken(userId: string): string {
  const raw = generateToken();
  store.update((s) => {
    s.auth.resetTokens.push({
      tokenHash: sha256(raw),
      userId,
      expiresAt: Date.now() + RESET_TTL_MS,
    });
  });
  return raw;
}

/** Validate & consume a reset token (single-use). Returns the user or null. */
export function consumeResetToken(raw: string): AuthUser | null {
  if (!raw) return null;
  return store.update((s) => {
    const now = Date.now();
    s.auth.resetTokens = s.auth.resetTokens.filter((t) => t.expiresAt > now);
    const idx = s.auth.resetTokens.findIndex((t) => tokenMatches(raw, t.tokenHash));
    if (idx === -1) return null;
    const tok = s.auth.resetTokens[idx];
    s.auth.resetTokens.splice(idx, 1); // single-use
    return s.auth.users.find((u) => u.id === tok.userId) ?? null;
  });
}

export function revokeUserResetTokens(userId: string): void {
  store.update((s) => {
    s.auth.resetTokens = s.auth.resetTokens.filter((t) => t.userId !== userId);
  });
}
