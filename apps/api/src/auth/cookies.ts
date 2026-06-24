// Cookie parsing/serialization for the auth system, via the `cookie` package.
//
// Flags (all auth cookies): httpOnly, sameSite=lax, secure in production,
// path=/. Session cookie is `sid`, trusted-device cookie is `tdid`.

import { parse, serialize, type SerializeOptions } from 'cookie';
import type { Request, Response } from 'express';
import { SESSION_TTL_MS, TRUSTED_DEVICE_TTL_MS } from './tokens';

export const SID = 'sid';
export const TDID = 'tdid';

const isProd = (): boolean => process.env.NODE_ENV === 'production';

function baseOptions(): SerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd(),
    path: '/',
  };
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  try {
    return parse(header)[name];
  } catch {
    return undefined;
  }
}

function appendSetCookie(res: Response, value: string): void {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', value);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, value]);
  else res.setHeader('Set-Cookie', [String(prev), value]);
}

export function setSessionCookie(res: Response, token: string): void {
  appendSetCookie(
    res,
    serialize(SID, token, { ...baseOptions(), maxAge: Math.floor(SESSION_TTL_MS / 1000) }),
  );
}

export function clearSessionCookie(res: Response): void {
  appendSetCookie(res, serialize(SID, '', { ...baseOptions(), maxAge: 0 }));
}

export function setTrustedDeviceCookie(res: Response, token: string): void {
  appendSetCookie(
    res,
    serialize(TDID, token, {
      ...baseOptions(),
      maxAge: Math.floor(TRUSTED_DEVICE_TTL_MS / 1000),
    }),
  );
}
