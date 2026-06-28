// Media route — serves the bundled alarm siren clip over the LAN so Sonos speakers
// can fetch it by URL (PlayNotification needs a URI the players can reach). The clip
// lives in apps/api/assets/ and is resolved relative to this module both in dev
// (tsx/ESM) and in the esbuild CJS bundle (dist/index.cjs).
//
// FORMAT: an MP3 (alarm.mp3) is preferred; a 16-bit PCM WAV (alarm.wav) is shipped as the
// default because it needs no encoder to produce and is owner-validated to play on every
// Sonos model. The served path is always /api/media/alarm.* — the route picks whichever
// asset is bundled and sets the matching Content-Type. Drop an alarm.mp3 into assets/ to
// switch formats with no code change.
//
// The ABSOLUTE URL the speakers fetch is built by alarmMediaUrl(): it prefers the
// LAN_BASE_URL env (e.g. http://192.168.1.149:3002) — REQUIRED in production because the
// API binds to 127.0.0.1 behind nginx, and the speakers must reach the mini's LAN IP:port
// directly, NOT the reverse-proxy hostname. When LAN_BASE_URL is unset it falls back to
// the request's own host header (works in dev when the API is reachable on the LAN).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Request, Response } from 'express';

const FILENAMES = ['alarm.mp3', 'alarm.wav'] as const;

/** Candidate dirs holding the bundled clip, across dev (tsx/ESM, __dirname undefined) and
 *  the CJS bundle (dist/index.cjs → ../assets) and various cwds. */
function assetDirs(): string[] {
  const dirs: string[] = [];
  if (typeof __dirname !== 'undefined') {
    dirs.push(resolve(__dirname, 'assets')); // dist/index.cjs → dist/assets (bundled by build.mjs)
    dirs.push(resolve(__dirname, '..', 'assets')); // dist/index.cjs → apps/api/assets (source tree)
    dirs.push(resolve(__dirname, '..', '..', 'assets')); // src/routes → apps/api/assets (tsx dev)
  }
  dirs.push(resolve(process.cwd(), 'assets')); // cwd = apps/api (dev)
  dirs.push(resolve(process.cwd(), 'dist', 'assets')); // cwd = apps/api, prod
  dirs.push(resolve(process.cwd(), 'apps', 'api', 'assets')); // cwd = repo root
  return dirs;
}

/** Resolve the bundled clip path + its extension, preferring mp3 over wav. */
function alarmAsset(): { path: string; ext: 'mp3' | 'wav' } | null {
  for (const name of FILENAMES) {
    for (const dir of assetDirs()) {
      const p = resolve(dir, name);
      if (existsSync(p)) return { path: p, ext: name.endsWith('mp3') ? 'mp3' : 'wav' };
    }
  }
  return null;
}

let cached: { bytes: Buffer; ext: 'mp3' | 'wav' } | null = null;
function alarmClip(): { bytes: Buffer; ext: 'mp3' | 'wav' } | null {
  if (cached) return cached;
  const a = alarmAsset();
  if (!a) return null;
  cached = { bytes: readFileSync(a.path), ext: a.ext };
  return cached;
}

const CONTENT_TYPE: Record<'mp3' | 'wav', string> = { mp3: 'audio/mpeg', wav: 'audio/wav' };

/** GET /api/media/alarm.mp3 (and /alarm.wav) — stream the siren clip. Registered BEFORE
 *  requireAuth in index.ts so the speakers (which fetch un-authed over the LAN) can reach
 *  it. Always returns the one bundled clip regardless of the requested extension. */
export function serveAlarmClip(_req: Request, res: Response): void {
  const clip = alarmClip();
  if (!clip) {
    res.status(404).json({ error: 'alarm clip not bundled', code: 'NOT_FOUND' });
    return;
  }
  res.setHeader('Content-Type', CONTENT_TYPE[clip.ext]);
  res.setHeader('Content-Length', String(clip.bytes.length));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(clip.bytes);
}

/** The absolute LAN URL the Sonos speakers fetch the siren from. Prefers LAN_BASE_URL
 *  (required in prod — speakers must reach the mini's LAN IP:port, not the nginx host),
 *  else derives from the request host. The path matches the bundled clip's extension. */
export function alarmMediaUrl(req?: Request): string {
  const ext = alarmClip()?.ext ?? 'mp3';
  const pathPart = `/api/media/alarm.${ext}`;
  const base = (process.env.LAN_BASE_URL || '').trim().replace(/\/+$/, '');
  if (base) return `${base}${pathPart}`;
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = req.get('host');
    if (host) return `${proto}://${host}${pathPart}`;
  }
  // Last-resort fallback (dev): assume the API's own port on localhost. The speakers
  // can't reach this — set LAN_BASE_URL on the mini.
  const port = process.env.API_PORT ?? '3002';
  return `http://127.0.0.1:${port}${pathPart}`;
}
