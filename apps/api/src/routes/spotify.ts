// HTTP surface for the Spotify (Music) integration — Phase 1.
//
// Auth flow (server-side Authorization Code, see connectors/spotify.ts):
//   • PUT  /api/spotify/credentials  { clientId, clientSecret }  — owner pastes the app creds.
//   • GET  /api/spotify/auth-url                                  — returns the consent URL.
//   • GET  /api/spotify/callback?code=&state=                     — Spotify redirects here; we
//        exchange the code + redirect the browser back to Settings (this route is UN-authed at
//        registration in index.ts, since the browser arrives straight from accounts.spotify.com).
//   • GET  /api/spotify/status                                   — safe status (NO secrets).
//   • POST /api/spotify/disconnect                               — drop tokens.
//
// Browse: /playlists /liked /search?q= ; devices: /devices ; playback: /play (+transport) ;
// /now-playing. All state-changing routes are admin-gated at the route in index.ts.
//
// SECURITY: the client secret + tokens NEVER leave the server — /status returns only
// { connected, premium, displayName, ... }. The OAuth `state` is a random token minted server-
// side + verified on the callback (CSRF protection); we use node crypto (no new deps).

import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import * as spotify from '../connectors/spotify';
import { SpotifyApiError } from '../connectors/spotify';

function badInput(msg: string): never {
  const e = new Error(msg) as Error & { code?: string };
  e.code = 'BAD_INPUT';
  throw e;
}

// ---- OAuth state (CSRF) ------------------------------------------------------
// A short-lived set of pending `state` tokens. The auth-url mints one; the callback consumes +
// verifies it. In-memory is fine — the consent flow completes in seconds and a restart just means
// the owner re-clicks Connect. Entries older than 10 min are swept.

const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, number>(); // state -> createdAt

function mintState(): string {
  const now = Date.now();
  for (const [s, ts] of pendingStates) if (now - ts > STATE_TTL_MS) pendingStates.delete(s);
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, now);
  return state;
}

function consumeState(state: string): boolean {
  const ts = pendingStates.get(state);
  if (ts === undefined) return false;
  pendingStates.delete(state);
  return Date.now() - ts <= STATE_TTL_MS;
}

// ---- Credentials + status ---------------------------------------------------

/** PUT /api/spotify/credentials { clientId, clientSecret } (admin) — save the app creds. */
export function setCredentials(body: unknown): unknown {
  const b = (body ?? {}) as { clientId?: unknown; clientSecret?: unknown };
  const clientId = String(b.clientId ?? '').trim();
  const clientSecret = String(b.clientSecret ?? '').trim();
  if (!clientId) badInput('clientId is required');
  if (!clientSecret) badInput('clientSecret is required');
  spotify.setCredentials(clientId, clientSecret);
  return { ts: new Date().toISOString(), status: spotify.getStatus() };
}

/** GET /api/spotify/status — safe, client-facing status (no secrets/tokens). */
export function getStatus(): unknown {
  return { ts: new Date().toISOString(), ...spotify.getStatus() };
}

/** POST /api/spotify/disconnect (admin). */
export function disconnect(): unknown {
  spotify.disconnect();
  return { ts: new Date().toISOString(), ok: true };
}

// ---- OAuth: auth-url + callback ---------------------------------------------

/** GET /api/spotify/auth-url (admin) — the consent URL to redirect the owner to. */
export function getAuthUrl(): unknown {
  if (!spotify.isConfigured()) badInput('Set the Spotify Client ID + Secret first');
  const state = mintState();
  return { ts: new Date().toISOString(), url: spotify.authorizeUrl(state) };
}

/**
 * GET /api/spotify/callback?code=&state= — Spotify redirects the owner's browser here. We verify
 * the state, exchange the code for tokens, then 302 the browser back to Settings → Connections
 * with a small ?spotify=… flag the UI can surface. Registered UN-authed in index.ts (the browser
 * arrives from accounts.spotify.com without our session cookie context guaranteed).
 */
export async function handleCallback(req: Request, res: Response): Promise<void> {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const spotifyError = typeof req.query.error === 'string' ? req.query.error : '';
  const back = (result: string) => res.redirect(`/settings?tab=Connections&spotify=${encodeURIComponent(result)}`);

  if (spotifyError) return back(`error:${spotifyError}`);
  if (!code || !state) return back('error:missing_code');
  if (!consumeState(state)) return back('error:bad_state');
  try {
    await spotify.exchangeCode(code);
    return back('connected');
  } catch (e) {
    return back(`error:${(e as Error).message.slice(0, 80)}`);
  }
}

// ---- Browse -----------------------------------------------------------------

/** Wrap a Web API read so a Premium/auth error becomes a tidy BAD_INPUT with the reason. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SpotifyApiError) {
      badInput(e.reason === 'PREMIUM_REQUIRED' ? 'Spotify Premium required' : e.message);
    }
    throw e;
  }
}

/** GET /api/spotify/playlists. */
export async function getPlaylists(): Promise<unknown> {
  const items = await guard(() => spotify.getPlaylists());
  return { ts: new Date().toISOString(), items };
}

/** GET /api/spotify/liked. */
export async function getLiked(): Promise<unknown> {
  const items = await guard(() => spotify.getLiked());
  return { ts: new Date().toISOString(), items };
}

/** GET /api/spotify/search?q=. */
export async function search(qRaw: unknown): Promise<unknown> {
  const q = String(qRaw ?? '').trim();
  if (!q) return { ts: new Date().toISOString(), query: '', items: [] };
  const items = await guard(() => spotify.search(q));
  return { ts: new Date().toISOString(), query: q, items };
}

/** GET /api/spotify/devices — Connect devices mapped to Sonos zones. */
export async function getDevices(): Promise<unknown> {
  const devices = await guard(() => spotify.getConnectDevices());
  return { ts: new Date().toISOString(), devices };
}

// ---- Playback ---------------------------------------------------------------

/** POST /api/spotify/play { contextUri?|uris?, speakerIds[], volumePct? } (admin). */
export async function play(body: unknown): Promise<unknown> {
  const b = (body ?? {}) as {
    contextUri?: unknown;
    uris?: unknown;
    speakerIds?: unknown;
    volumePct?: unknown;
  };
  const contextUri = typeof b.contextUri === 'string' && b.contextUri ? b.contextUri : undefined;
  const uris = Array.isArray(b.uris) ? b.uris.filter((x): x is string => typeof x === 'string') : undefined;
  if (!contextUri && (!uris || uris.length === 0)) badInput('contextUri or uris is required');
  const speakerIds = Array.isArray(b.speakerIds) ? b.speakerIds.filter((x): x is string => typeof x === 'string') : [];
  if (speakerIds.length === 0) badInput('at least one speaker is required');
  const volumePct =
    b.volumePct === undefined || b.volumePct === null
      ? undefined
      : (() => {
          const v = Number(b.volumePct);
          if (!Number.isFinite(v) || v < 0 || v > 100) badInput('volumePct must be 0–100');
          return v;
        })();

  const res = await guard(() =>
    spotify.playOnSpeakers({ contextUri, uris, speakerIds, ...(volumePct !== undefined ? { volumePct } : {}) }),
  );
  return { ts: new Date().toISOString(), ok: true, ...res };
}

/**
 * POST /api/spotify/speakers { speakerIds } (admin) — LIVE-edit which Sonos zones the active
 * Spotify playback runs on, without restarting the track. Reconciles the Sonos group around the
 * active Connect device (coordinator): added zones join in sync, removed zones leave + stop.
 * Removing the LAST zone (empty set) pauses playback. Fail-soft → BAD_INPUT on grouping errors.
 */
export async function setSpeakers(body: unknown): Promise<unknown> {
  const b = (body ?? {}) as { speakerIds?: unknown };
  const targetIds = Array.isArray(b.speakerIds)
    ? [...new Set(b.speakerIds.filter((x): x is string => typeof x === 'string'))]
    : [];
  if (targetIds.length === 0) {
    // No zones = stop listening — pause the active device.
    await guard(() => spotify.pause());
    return { ts: new Date().toISOString(), ok: true, paused: true };
  }
  const res = await guard(() => spotify.setSpeakers(targetIds));
  return { ts: new Date().toISOString(), ok: true, ...res };
}

/** POST /api/spotify/pause | resume | next | previous (admin). */
export async function transport(action: 'pause' | 'resume' | 'next' | 'previous'): Promise<unknown> {
  await guard(() => spotify[action]());
  return { ts: new Date().toISOString(), ok: true, action };
}

/** PUT /api/spotify/shuffle { on } (admin). */
export async function setShuffle(body: unknown): Promise<unknown> {
  const on = !!(body as { on?: unknown })?.on;
  await guard(() => spotify.setShuffle(on));
  return { ts: new Date().toISOString(), ok: true, shuffle: on };
}

/** PUT /api/spotify/repeat { mode } (admin). */
export async function setRepeat(body: unknown): Promise<unknown> {
  const mode = (body as { mode?: unknown })?.mode;
  if (mode !== 'off' && mode !== 'context' && mode !== 'track') badInput("mode must be off | context | track");
  await guard(() => spotify.setRepeat(mode));
  return { ts: new Date().toISOString(), ok: true, repeat: mode };
}

/** PUT /api/spotify/seek { positionMs } (admin). */
export async function seek(body: unknown): Promise<unknown> {
  const positionMs = Number((body as { positionMs?: unknown })?.positionMs);
  if (!Number.isFinite(positionMs) || positionMs < 0) badInput('positionMs must be ≥ 0');
  await guard(() => spotify.seek(positionMs));
  return { ts: new Date().toISOString(), ok: true };
}

/** GET /api/spotify/now-playing. */
export async function nowPlaying(): Promise<unknown> {
  // Not connected → an empty now-playing (the UI shows the connect prompt) rather than a 502.
  if (!spotify.isConnected()) return { ts: new Date().toISOString(), nowPlaying: null };
  const np = await guard(() => spotify.getNowPlaying());
  return { ts: new Date().toISOString(), nowPlaying: np };
}
