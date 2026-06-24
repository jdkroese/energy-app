// Cryptographic primitives for the auth system.
//
// Design rule: the store NEVER holds a raw secret. Every session token,
// trusted-device token, OTP code, reset token and setup token is generated
// here and only its sha256 hash is persisted. The raw value lives exclusively
// in the cookie / setup URL / OTP message handed back to the caller — so a
// leak of state.json cannot be replayed to gain access.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Generate a 256-bit url-safe token. Returned raw; store only sha256(token). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 hex digest — used for all token/code hashes in the store. */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** A 6-digit numeric OTP (zero-padded), e.g. "004271". */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Constant-time compare of two hex strings (token-hash comparisons).
 * Returns false on any length mismatch without leaking timing on content.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Compare a raw secret to a stored sha256 hash in constant time. */
export function tokenMatches(raw: string, storedHash: string): boolean {
  return safeEqualHex(sha256(raw), storedHash);
}

// ---- Durations (ms) -----------------------------------------------------

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const TRUSTED_DEVICE_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
export const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const ADMIN_SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (bootstrap)

export const OTP_MAX_ATTEMPTS = 5;
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000; // 15 minutes
