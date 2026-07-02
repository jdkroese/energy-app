// Spotify connector — Spotify Web API + Spotify Connect (Music Phase 1).
//
// WHY the Web API (not local UPnP): unlike internet radio, a Spotify stream can't be handed to
// Sonos as a plain URL. The validated path is the Web API's Spotify Connect: the owner's Sonos
// rooms already have Spotify linked, so they appear as Connect "devices" under
// GET /v1/me/player/devices. We start/steer playback on those devices with the Web API.
//
// AUTH (mirrors connectors/tesla.ts): Authorization-Code flow with a client secret, entirely
// server-side. The owner registers a Spotify developer app and pastes Client ID + Client Secret
// into Settings → Music, then runs the consent flow (auth-url → Spotify → /callback). We store
// the refresh token + a short-lived access token (+ expiry) in integrations.spotify and refresh
// proactively before every call. NONE of these secrets are ever returned to the client.
//
// TARGETING MULTIPLE SONOS ROOMS: Spotify Connect plays to ONE device. To play across several
// selected Sonos rooms we first GROUP them via sonos.ts (JoinGroup into one coordinator), then
// start playback on the COORDINATOR's Connect device (matched to the coordinator's Sonos room
// name). A single room = its own Connect device. See resolveConnectDevice() + playOnSpeakers().
//
// NOT LIVE-VERIFIED in this build — no Spotify credentials in CI (needs the owner's account +
// Premium). Typecheck/build pass; the real calls must be smoke-tested once the owner connects.

import { config } from '../config';
import * as store from '../store';
import * as sonos from './sonos';

const AUTH_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';

/** OAuth scopes: read + control playback, read the library/playlists. */
export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
].join(' ');

// ---- Config / redirect ------------------------------------------------------

function cfg(): store.SpotifyIntegration | null {
  return store.get().integrations?.spotify ?? null;
}

/** The redirect URI the owner must register in their Spotify app dashboard. Derived from the
 *  configurable public base URL so it matches whatever host the app is reached at. */
export function redirectUri(): string {
  return `${config.publicBaseUrl}/api/spotify/callback`;
}

/** True once the owner has entered a client id + secret (credentials present). */
export function isConfigured(): boolean {
  const c = cfg();
  return !!(c && c.clientId && c.clientSecret);
}

/** True once the OAuth consent flow has completed (a refresh token exists). */
export function isConnected(): boolean {
  const c = cfg();
  return !!(c && c.refreshToken);
}

// ---- Credentials / lifecycle -----------------------------------------------

/** Persist the owner's client id + secret (Settings → Music). Does NOT connect — the OAuth
 *  consent flow (auth-url → callback) mints the tokens. Clearing credentials disconnects. */
export function setCredentials(clientId: string, clientSecret: string): void {
  store.update((s) => {
    const prev = s.integrations.spotify ?? null;
    s.integrations.spotify = {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      // Changing the client invalidates any existing tokens.
      refreshToken: null,
      accessToken: null,
      expiresAt: 0,
      displayName: prev?.displayName ?? null,
      premium: prev?.premium ?? false,
    };
  });
}

/** Fully disconnect: drop tokens + cached profile (keeps nothing). */
export function disconnect(): void {
  store.update((s) => {
    s.integrations.spotify = null;
  });
}

// ---- OAuth: authorize URL + code exchange + refresh -------------------------

/** Build the Spotify consent URL. `state` is an opaque CSRF token the caller persists + checks
 *  on the callback. Throws when credentials aren't set. */
export function authorizeUrl(state: string): string {
  const c = cfg();
  if (!c || !c.clientId) throw new Error('Spotify client id/secret not set');
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SPOTIFY_SCOPES,
    state,
    // Force the consent screen so a re-connect always returns a fresh refresh token.
    show_dialog: 'true',
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

function basicAuthHeader(c: store.SpotifyIntegration): string {
  return 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
}

/**
 * Exchange an authorization code for tokens (called from the OAuth callback). Persists the
 * refresh + access token, then fetches the account profile so the status card can show the
 * display name + Premium badge. Throws on any failure (the caller surfaces it).
 */
export async function exchangeCode(code: string): Promise<void> {
  const c = cfg();
  if (!c || !c.clientId || !c.clientSecret) throw new Error('Spotify client id/secret not set');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  });
  const res = await fetch(`${AUTH_BASE}/api/token`, {
    method: 'POST',
    headers: { authorization: basicAuthHeader(c), 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Spotify token exchange -> HTTP ${res.status}`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  store.update((s) => {
    if (!s.integrations.spotify) return;
    s.integrations.spotify.accessToken = json.access_token;
    if (json.refresh_token) s.integrations.spotify.refreshToken = json.refresh_token;
    s.integrations.spotify.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
  });
  // Best-effort profile fetch so the UI shows who's connected + Premium state.
  await refreshProfile().catch(() => {});
}

/** Return a valid access token, refreshing proactively (≥60s slack) via the refresh token. */
async function accessToken(): Promise<string> {
  const c = cfg();
  if (!c || !c.refreshToken) throw new Error('Spotify not connected');
  if (c.accessToken && c.expiresAt > Date.now() + 60_000) return c.accessToken;

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken });
  const res = await fetch(`${AUTH_BASE}/api/token`, {
    method: 'POST',
    headers: { authorization: basicAuthHeader(c), 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Spotify token refresh -> HTTP ${res.status}`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  const token = json.access_token;
  store.update((s) => {
    if (!s.integrations.spotify) return;
    s.integrations.spotify.accessToken = token;
    s.integrations.spotify.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
    // Spotify occasionally rotates the refresh token — persist a new one if returned.
    if (json.refresh_token) s.integrations.spotify.refreshToken = json.refresh_token;
  });
  return token;
}

// ---- Low-level Web API helpers ---------------------------------------------

/** A Web API error that carries the HTTP status + Spotify's `reason` (e.g. PREMIUM_REQUIRED). */
export class SpotifyApiError extends Error {
  status: number;
  reason: string | null;
  constructor(status: number, message: string, reason: string | null) {
    super(message);
    this.name = 'SpotifyApiError';
    this.status = status;
    this.reason = reason;
  }
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await accessToken();
  const res = await fetch(path.startsWith('http') ? path : `${API_BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok && res.status !== 204) {
    // Decode Spotify's error envelope: { error: { status, message, reason? } }.
    let reason: string | null = null;
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.clone().json()) as { error?: { message?: string; reason?: string } };
      reason = j.error?.reason ?? null;
      if (j.error?.message) message = j.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new SpotifyApiError(res.status, message, reason);
  }
  return res;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

/** PUT/POST that returns no useful body (playback control). 204/202 = success. */
async function apiWrite(path: string, method: 'PUT' | 'POST', body?: unknown): Promise<void> {
  await apiFetch(path, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

// ---- Profile / status -------------------------------------------------------

interface SpotifyMe {
  display_name?: string;
  product?: string; // 'premium' | 'free' | 'open'
}

/** Refresh + persist the cached account profile (display name + Premium tier). */
export async function refreshProfile(): Promise<{ displayName: string | null; premium: boolean }> {
  const me = await apiGet<SpotifyMe>('/me');
  const displayName = me.display_name ?? null;
  const premium = me.product === 'premium';
  store.update((s) => {
    if (!s.integrations.spotify) return;
    s.integrations.spotify.displayName = displayName;
    s.integrations.spotify.premium = premium;
  });
  return { displayName, premium };
}

export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  premium: boolean;
  displayName: string | null;
  /** The redirect URI the owner must register (surfaced in the UI). */
  redirectUri: string;
}

/** The safe, client-facing status (NEVER includes secrets or tokens). */
export function getStatus(): SpotifyStatus {
  const c = cfg();
  return {
    configured: isConfigured(),
    connected: isConnected(),
    premium: c?.premium ?? false,
    displayName: c?.displayName ?? null,
    redirectUri: redirectUri(),
  };
}

// ---- Browse: playlists / liked / search ------------------------------------

export interface SpotifyImage {
  url: string;
  width?: number | null;
  height?: number | null;
}
export interface BrowseItem {
  /** The Spotify context/track URI to play (context_uri for playlists, track uri for tracks). */
  uri: string;
  name: string;
  /** Secondary line: owner (playlist), artist(s) (track). */
  subtitle: string;
  image: string | null;
  /** 'playlist' | 'track' | 'liked'. */
  kind: 'playlist' | 'track' | 'liked';
}

function pickImage(images?: SpotifyImage[]): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  return images[images.length - 1]?.url ?? images[0]?.url ?? null;
}

interface PlaylistsResp {
  items: Array<{ uri: string; name: string; images?: SpotifyImage[]; owner?: { display_name?: string }; tracks?: { total?: number } }>;
}

/** The owner's playlists (first page, up to 50). */
export async function getPlaylists(): Promise<BrowseItem[]> {
  const r = await apiGet<PlaylistsResp>('/me/playlists?limit=50');
  return (r.items ?? []).map((p) => ({
    uri: p.uri,
    name: p.name || 'Playlist',
    subtitle: p.tracks?.total != null ? `${p.tracks.total} tracks` : (p.owner?.display_name ?? ''),
    image: pickImage(p.images),
    kind: 'playlist' as const,
  }));
}

interface SavedTracksResp {
  items: Array<{ track: SpotifyTrack }>;
}

/** The owner's Liked Songs (first page, up to 50). Playing these uses their track URIs
 *  (the "Liked Songs" collection has no context_uri that Connect accepts uniformly). */
export async function getLiked(): Promise<BrowseItem[]> {
  const r = await apiGet<SavedTracksResp>('/me/tracks?limit=50');
  return (r.items ?? [])
    .map((it) => it.track)
    .filter(Boolean)
    .map((t) => ({
      uri: t.uri,
      name: t.name || 'Track',
      subtitle: (t.artists ?? []).map((a) => a.name).join(', '),
      image: pickImage(t.album?.images),
      kind: 'liked' as const,
    }));
}

interface SearchResp {
  tracks?: { items: SpotifyTrack[] };
  playlists?: { items: Array<{ uri: string; name: string; images?: SpotifyImage[]; owner?: { display_name?: string } }> };
}

/** Search tracks + playlists. Returns a flat, UI-ready list (tracks then playlists). */
export async function search(q: string): Promise<BrowseItem[]> {
  const term = q.trim();
  if (!term) return [];
  const r = await apiGet<SearchResp>(`/search?q=${encodeURIComponent(term)}&type=track,playlist&limit=20`);
  const tracks: BrowseItem[] = (r.tracks?.items ?? []).map((t) => ({
    uri: t.uri,
    name: t.name || 'Track',
    subtitle: (t.artists ?? []).map((a) => a.name).join(', '),
    image: pickImage(t.album?.images),
    kind: 'track' as const,
  }));
  const playlists: BrowseItem[] = (r.playlists?.items ?? []).map((p) => ({
    uri: p.uri,
    name: p.name || 'Playlist',
    subtitle: p.owner?.display_name ? `Playlist · ${p.owner.display_name}` : 'Playlist',
    image: pickImage(p.images),
    kind: 'playlist' as const,
  }));
  return [...tracks, ...playlists];
}

// ---- Connect devices ⇄ Sonos zones -----------------------------------------

interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  volume_percent: number | null;
}
interface DevicesResp {
  devices: SpotifyDevice[];
}

export interface ConnectDevice {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  /** The Sonos speaker id (RINCON_…) this Connect device maps to by name, or null if unmatched. */
  sonosId: string | null;
}

/** Normalise a name for matching (case/space/diacritic-insensitive). */
function normName(n: string): string {
  return n.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * List the owner's Spotify Connect devices, mapped to Sonos zones by NAME. Spotify surfaces each
 * Sonos room as a Connect device whose name matches the Sonos room name, so a case/diacritic-
 * insensitive name match links the two. Best-effort: an unmatched device still lists (sonosId
 * null) so the UI can show it, and a Sonos room with no Connect device simply won't appear.
 */
export async function getConnectDevices(): Promise<ConnectDevice[]> {
  const [r, fleet] = await Promise.all([
    apiGet<DevicesResp>('/me/player/devices'),
    sonos.getFleet().catch(() => [] as sonos.SonosSpeaker[]),
  ]);
  const byName = new Map(fleet.map((s) => [normName(s.name), s.id]));
  return (r.devices ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    isActive: d.is_active,
    sonosId: byName.get(normName(d.name)) ?? null,
  }));
}

/** Resolve the Connect device for a given Sonos speaker id (by name match). Null if none. */
async function resolveConnectDevice(sonosId: string): Promise<ConnectDevice | null> {
  const devices = await getConnectDevices();
  return devices.find((d) => d.sonosId === sonosId) ?? null;
}

// ---- Playback ---------------------------------------------------------------

export interface PlayRequest {
  /** A playlist/album context to play. */
  contextUri?: string;
  /** Explicit track URIs to play (used for Liked Songs / single tracks). */
  uris?: string[];
  /** Sonos speaker ids to play on (first = coordinator when >1). */
  speakerIds: string[];
  /** Optional volume 0–100 to set on the targeted speakers. */
  volumePct?: number;
}

export interface PlayResult {
  /** The Sonos speaker ids actually targeted. */
  playedOn: string[];
  /** The coordinator Sonos id playback was started on. */
  coordinator: string;
  /** The Spotify Connect device id playback was transferred to. */
  deviceId: string;
}

/**
 * Start Spotify playback across the chosen Sonos speakers.
 * Steps:
 *   1. GROUP the chosen speakers under one coordinator (sonos.groupSpeakers) so they play in sync.
 *   2. Resolve the COORDINATOR's Spotify Connect device (by Sonos room name).
 *   3. Start playback on that Connect device (context_uri or track uris).
 *   4. Set the requested volume on every targeted Sonos speaker.
 * Throws SpotifyApiError (surfacing PREMIUM_REQUIRED) or a plain Error on grouping/mapping issues.
 */
export async function playOnSpeakers(req: PlayRequest): Promise<PlayResult> {
  if (!req.contextUri && (!req.uris || req.uris.length === 0)) {
    throw new Error('contextUri or uris required');
  }
  if (!req.speakerIds || req.speakerIds.length === 0) throw new Error('at least one speaker is required');

  // 1. Group the chosen speakers so they share one coordinator + Connect device.
  const { coordinator, joined } = await sonos.groupSpeakers(req.speakerIds);

  // 2. Map the coordinator to its Connect device.
  const device = await resolveConnectDevice(coordinator);
  if (!device || !device.id) {
    throw new Error(
      'No Spotify Connect device found for the target Sonos room. Make sure Spotify is linked to your Sonos and the room is online.',
    );
  }

  // 3. Start playback on that device.
  const playBody: { context_uri?: string; uris?: string[] } = {};
  if (req.contextUri) playBody.context_uri = req.contextUri;
  else if (req.uris) playBody.uris = req.uris;
  await apiWrite(`/me/player/play?device_id=${encodeURIComponent(device.id)}`, 'PUT', playBody);

  // 4. Volume on every targeted Sonos speaker (best-effort per speaker).
  if (typeof req.volumePct === 'number') {
    const v = Math.max(0, Math.min(100, Math.round(req.volumePct)));
    await Promise.all(joined.map((id) => sonos.setVolume(id, v).catch(() => {})));
  }

  return { playedOn: joined, coordinator, deviceId: device.id };
}

/** Transport controls — all operate on the CURRENTLY ACTIVE Connect device. */
export async function pause(): Promise<void> {
  await apiWrite('/me/player/pause', 'PUT');
}
export async function resume(): Promise<void> {
  await apiWrite('/me/player/play', 'PUT');
}
export async function next(): Promise<void> {
  await apiWrite('/me/player/next', 'POST');
}
export async function previous(): Promise<void> {
  await apiWrite('/me/player/previous', 'POST');
}
export async function setShuffle(on: boolean): Promise<void> {
  await apiWrite(`/me/player/shuffle?state=${on ? 'true' : 'false'}`, 'PUT');
}
export async function setRepeat(mode: 'off' | 'context' | 'track'): Promise<void> {
  await apiWrite(`/me/player/repeat?state=${mode}`, 'PUT');
}
export async function seek(positionMs: number): Promise<void> {
  const ms = Math.max(0, Math.round(positionMs));
  await apiWrite(`/me/player/seek?position_ms=${ms}`, 'PUT');
}

// ---- Now playing ------------------------------------------------------------

interface SpotifyArtist {
  name: string;
}
interface SpotifyAlbum {
  name?: string;
  images?: SpotifyImage[];
}
interface SpotifyTrack {
  uri: string;
  name: string;
  artists?: SpotifyArtist[];
  album?: SpotifyAlbum;
  duration_ms?: number;
}
interface PlayerState {
  is_playing: boolean;
  progress_ms?: number | null;
  shuffle_state?: boolean;
  repeat_state?: 'off' | 'context' | 'track';
  device?: { id: string | null; name: string; volume_percent?: number | null };
  item?: SpotifyTrack | null;
}

export interface NowPlaying {
  isPlaying: boolean;
  track: string | null;
  artist: string | null;
  album: string | null;
  image: string | null;
  progressMs: number;
  durationMs: number;
  shuffle: boolean;
  repeat: 'off' | 'context' | 'track';
  /** The active Connect device name. */
  deviceName: string | null;
  /** The Sonos speaker id(s) the active device maps to (by name), for the UI. */
  sonosIds: string[];
}

/**
 * The current player state, mapped to a slim now-playing shape. Returns null when nothing is
 * playing / no active device (Spotify returns 204). The active Connect device is mapped back to
 * a Sonos zone id by name so the UI can highlight the right speaker chips.
 */
export async function getNowPlaying(): Promise<NowPlaying | null> {
  const res = await apiFetch('/me/player');
  if (res.status === 204) return null;
  const state = (await res.json()) as PlayerState;
  if (!state || !state.item) {
    // A device may be active with nothing loaded — report the device but no track.
    if (!state?.device) return null;
  }
  const track = state.item ?? null;
  let sonosIds: string[] = [];
  if (state.device?.name) {
    try {
      const fleet = await sonos.getFleet();
      const match = fleet.find((s) => normName(s.name) === normName(state.device!.name));
      if (match) {
        // Include every speaker in the coordinator's group so all playing rooms light up.
        sonosIds = fleet.filter((s) => s.group === match.group).map((s) => s.id);
        if (sonosIds.length === 0) sonosIds = [match.id];
      }
    } catch {
      /* fleet read failed — leave sonosIds empty */
    }
  }
  return {
    isPlaying: state.is_playing ?? false,
    track: track?.name ?? null,
    artist: (track?.artists ?? []).map((a) => a.name).join(', ') || null,
    album: track?.album?.name ?? null,
    image: pickImage(track?.album?.images),
    progressMs: state.progress_ms ?? 0,
    durationMs: track?.duration_ms ?? 0,
    shuffle: state.shuffle_state ?? false,
    repeat: state.repeat_state ?? 'off',
    deviceName: state.device?.name ?? null,
    sonosIds,
  };
}
