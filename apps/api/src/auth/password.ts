// Password hashing (bcryptjs, cost 12) and password policy.
// Plaintext is never stored or logged — only the bcrypt hash is persisted.

import bcrypt from 'bcryptjs';

const COST = 12;

export function badInput(message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

/** Enforce the minimum policy. Throws BAD_INPUT (→ 400) on a weak password. */
export function assertStrongPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 10) {
    throw badInput('Password must be at least 10 characters');
  }
  return password;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

/** Constant-time-ish verify via bcrypt. Returns false when no hash is set. */
export async function verifyPassword(
  password: string,
  hash: string | null,
): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}
