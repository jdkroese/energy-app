// In-memory sliding-window rate limiter for auth *issuance* (OTP sends, reset
// requests). Per-process and intentionally not persisted — we never want a disk
// write on every login attempt, and a restart simply resets the windows.
//
// FAIL-SAFE CONTRACT: callers treat a `true` ("limited") result as "skip the
// send / token mint" — never as "reject the login". A throttled user is never
// locked out; any code/link already delivered still works, and they can retry
// after the window. Limits are generous: a real user won't hit them; they only
// blunt spam / token-flooding abuse.

const buckets = new Map<string, number[]>();

/**
 * Record an attempt for `key` and report whether it should be throttled.
 * Returns true when `key` already has >= `max` attempts within `windowMs`.
 */
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    buckets.set(key, recent); // keep pruned history; do NOT add this attempt
    return true;
  }
  recent.push(now);
  buckets.set(key, recent);
  return false;
}

/** Test/diagnostic helper — clear all windows. */
export function _resetRateLimits(): void {
  buckets.clear();
}

// Generous thresholds — normal use sends 1 code / 1 reset; these only stop abuse.
export const OTP_SEND_MAX = 5;
export const OTP_SEND_WINDOW_MS = 15 * 60 * 1000; // 15 min, per user
export const RESET_MAX_PER_EMAIL = 3;
export const RESET_MAX_PER_IP = 10;
export const RESET_WINDOW_MS = 60 * 60 * 1000; // 1 hour
