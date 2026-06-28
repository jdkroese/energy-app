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
// The ABSOLUTE URL the speakers fetch is built by alarmMediaUrl(). Because the main API
// binds 127.0.0.1 behind nginx, this module ALSO starts a dedicated listener on
// 0.0.0.0:MEDIA_PORT (startMediaLanListener) that serves ONLY this clip — so the speakers
// can reach it over the LAN with zero config. alarmMediaUrl() prefers an explicit
// LAN_BASE_URL override, else the auto-detected LAN IPv4 + MEDIA_PORT, else localhost (dev).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
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
function writeClip(res: ServerResponse | Response): void {
  const clip = alarmClip();
  if (!clip) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'alarm clip not bundled', code: 'NOT_FOUND' }));
    return;
  }
  res.setHeader('Content-Type', CONTENT_TYPE[clip.ext]);
  res.setHeader('Content-Length', String(clip.bytes.length));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(clip.bytes);
}

export function serveAlarmClip(_req: Request, res: Response): void {
  writeClip(res);
}

/** Port the dedicated LAN media listener binds (0.0.0.0) so speakers can fetch the siren
 *  even though the main API is bound to 127.0.0.1 behind nginx. */
export function mediaPort(): number {
  const p = Number(process.env.MEDIA_PORT ?? 3019);
  return Number.isFinite(p) && p > 0 ? p : 3019;
}

/** Best-effort primary private LAN IPv4 of this host, skipping internal + common virtual
 *  adapters (docker/Hyper-V/WSL/VM). Lets us build a speaker-reachable siren URL with no
 *  config. Prefers 192.168 / 10 / 172.16-31 ranges. */
function lanIpv4(): string | null {
  const cands: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/docker|veth|vethernet|wsl|hyper-v|loopback|virtualbox|vmware|tailscale|zerotier/i.test(name)) continue;
      cands.push(a.address);
    }
  }
  return (
    cands.find((ip) => ip.startsWith('192.168.')) ||
    cands.find((ip) => /^10\./.test(ip)) ||
    cands.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ||
    cands[0] ||
    null
  );
}

let mediaServer: ReturnType<typeof createServer> | null = null;
/** Start a tiny HTTP listener bound to 0.0.0.0:MEDIA_PORT that serves ONLY the un-authed
 *  siren clip — so the Sonos speakers can fetch it over the LAN even though the main API
 *  binds 127.0.0.1 behind nginx. Exposes nothing else. Idempotent; never throws. */
export function startMediaLanListener(): void {
  if (mediaServer) return;
  const port = mediaPort();
  const srv = createServer((req, res) => {
    if (req.url && req.url.startsWith('/api/media/alarm')) return writeClip(res);
    res.statusCode = 404;
    res.end('not found');
  });
  srv.on('error', (e) => {
    console.error(`[energy-api] media LAN listener error on :${port}:`, (e as Error).message);
    mediaServer = null;
  });
  srv.listen(port, '0.0.0.0', () => {
    console.log(`[energy-api] media LAN listener http://0.0.0.0:${port}  (siren clip only)`);
  });
  mediaServer = srv;
}

/** The absolute LAN URL the Sonos speakers fetch the siren from. Prefers LAN_BASE_URL
 *  (required in prod — speakers must reach the mini's LAN IP:port, not the nginx host),
 *  else derives from the request host. The path matches the bundled clip's extension. */
export function alarmMediaUrl(_req?: Request): string {
  const ext = alarmClip()?.ext ?? 'mp3';
  const pathPart = `/api/media/alarm.${ext}`;
  // 1) explicit override (deterministic; always wins) — e.g. http://192.168.1.50:3019
  const base = (process.env.LAN_BASE_URL || '').trim().replace(/\/+$/, '');
  if (base) return `${base}${pathPart}`;
  // 2) zero-config: auto-detected LAN IP + the dedicated media listener's port. This is what
  //    the speakers can actually reach — the main API is 127.0.0.1 behind nginx, and a
  //    request's Host header is the public nginx vhost (NOT a URL the speakers should fetch).
  const ip = lanIpv4();
  if (ip) return `http://${ip}:${mediaPort()}${pathPart}`;
  // 3) last resort (dev box, no detectable LAN IP): localhost on the media port.
  return `http://127.0.0.1:${mediaPort()}${pathPart}`;
}
