// Panasonic Comfort Cloud connector — cloud-managed WiFi AC units (CS-Z / CS-XZ series
// with built-in WiFi modules). Provides the same ClimateUnit shape as the Intesis
// connector so Panasonic units merge into the same Devices fleet alongside Intesis/Airzone.
//
// Auth: Panasonic migrated from simple user+pass (/auth/login) to Auth0 OAuth2 PKCE circa
// 2026. The flow: PKCE authorize → username/password → form callback → auth code →
// /oauth/token → /auth/v2/login for the ACC client ID. Token is cached; refresh_token is
// used on expiry; full re-auth if refresh fails.
//
// Reference: https://github.com/lostfields/python-panasonic-comfort-cloud

import * as crypto from 'crypto';
import { cached, invalidate } from '../cache';
import * as store from '../store';
import type { ClimateUnit } from './intesis';
import { serialize } from './write-queue';

// ---- Constants ---------------------------------------------------------------

const BASE_AUTH = 'https://authglb.digital.panasonic.com';
const BASE_ACC  = 'https://accsmart.panasonic.com';
const APP_CLIENT_ID = 'Xmy6xIYIitMxngjB2rHvlm6HSDNnaMJx';
const AUTH0_CLIENT  = 'eyJuYW1lIjoiQXV0aDAuQW5kcm9pZCIsImVudiI6eyJhbmRyb2lkIjoiMzAifSwidmVyc2lvbiI6IjIuOS4zIn0=';
const REDIRECT_URI  = 'panasonic-iot-cfc://authglb.digital.panasonic.com/android/com.panasonic.ACCsmart/callback';
// Fetched from iTunes on first auth; bump this fallback when Panasonic releases
// a new mandatory version (they return code 4106 when the version is too old).
const APP_VERSION_FALLBACK = '4.3.0';
let appVersion: string | null = null;

async function getAppVersion(): Promise<string> {
  if (appVersion) return appVersion;
  try {
    const r = await fetch('https://itunes.apple.com/lookup?id=1348640525', { signal: AbortSignal.timeout(5_000) });
    if (r.ok) {
      const j = (await r.json()) as { results?: Array<{ version?: string }> };
      const v = j.results?.[0]?.version;
      if (v) { appVersion = v; return v; }
    }
  } catch { /* ignore — use fallback */ }
  return APP_VERSION_FALLBACK;
}
const AUDIENCE      = `https://digital.panasonic.com/${APP_CLIENT_ID}/api/v1/`;
const SCOPE         = 'openid offline_access comfortcloud.control a2w.control';
const MOBILE_UA     = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36';

// ---- Mode maps ---------------------------------------------------------------

const MODE: Record<number, string>       = { 0: 'auto', 1: 'dry', 2: 'cool', 3: 'heat', 4: 'fan' };
const MODE_VALUE: Record<string, number> = { auto: 0, dry: 1, cool: 2, heat: 3, fan: 4 };

// ---- Credentials -------------------------------------------------------------

interface PanasonicCreds { username: string; password: string; }

function creds(): PanasonicCreds | null {
  const s = (store.get().integrations as { panasonic?: { username?: string; password?: string } | null }).panasonic;
  if (s?.username && s?.password) return { username: s.username, password: s.password };
  const u = process.env.PANASONIC_CC_USER;
  const p = process.env.PANASONIC_CC_PASS;
  if (u && p) return { username: u, password: p };
  return null;
}

export function isConfigured(): boolean { return creds() !== null; }

// ---- Internal ID -------------------------------------------------------------
// deviceGuid may contain '+' (URL-unsafe). We prefix 'pan-' and replace '+' with '-'.

const guidByInternalId = new Map<string, string>();

function internalId(guid: string): string {
  const id = `pan-${guid.replace(/\+/g, '-')}`;
  guidByInternalId.set(id, guid);
  return id;
}

export function guidFor(id: string): string {
  const g = guidByInternalId.get(id);
  if (!g) throw new Error(`Panasonic device not in session cache: ${id}. Fetch the fleet first.`);
  return g;
}

// ---- PKCE helpers ------------------------------------------------------------

function randomString(length: number): string {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

function codeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ---- API key computation -----------------------------------------------------
// SHA256('Comfort Cloud' + salt + timestamp_ms + 'Bearer ' + token); insert 'cfc' at [9].
// timestamp_ms: current local-time components interpreted as UTC (matching Python quirk).

function computeApiKey(accessToken: string): { key: string; ts: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
             `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  // Replicates Python: datetime.datetime(local components, tzinfo=utc).timestamp() * 1000
  const localAsUtcMs = String(Date.UTC(
    now.getFullYear(), now.getMonth(), now.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds(), 0,
  ));
  const buf = Buffer.concat([
    Buffer.from('Comfort Cloud', 'utf8'),
    Buffer.from('521325fb2dd486bf4831b47644317fca', 'utf8'),
    Buffer.from(localAsUtcMs, 'utf8'),
    Buffer.from('Bearer ', 'utf8'),
    Buffer.from(accessToken, 'utf8'),
  ]);
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  return { key: h.slice(0, 9) + 'cfc' + h.slice(9), ts };
}

// ---- ACC API headers ---------------------------------------------------------

function accHeaders(accessToken: string, accClientId: string, version: string): Record<string, string> {
  const { key, ts } = computeApiKey(accessToken);
  return {
    'Content-Type': 'application/json;charset=utf-8',
    'User-Agent': 'G-RAC',
    'x-app-name': 'Comfort Cloud',
    'x-app-timestamp': ts,
    'x-app-type': '1',
    'x-app-version': version,
    'x-cfc-api-key': key,
    'x-client-id': accClientId,
    'x-user-authorization-v2': `Bearer ${accessToken}`,
  };
}

// ---- Cookie jar --------------------------------------------------------------

class CookieJar {
  private cookies = new Map<string, string>();

  update(response: Response): void {
    // Node 18.14+ exposes getSetCookie() on Headers; fall back to parsing the
    // concatenated set-cookie value if it's absent (shouldn't happen on Node 26).
    const hdr = response.headers as typeof response.headers & { getSetCookie?: () => string[] };
    const raw = hdr.getSetCookie ? hdr.getSetCookie() : (response.headers.get('set-cookie') ?? '').split(/,\s*(?=[a-zA-Z_-]+=)/);
    for (const h of raw) {
      const [pair] = h.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  get(name: string): string | undefined { return this.cookies.get(name); }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// ---- HTML hidden-input parser ------------------------------------------------

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g,    (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractHiddenInputs(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /<input\b([^>]*?)(?:\s*\/?>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    if (!/type\s*=\s*["']?hidden["']?/i.test(attrs)) continue;
    const nameM  = /name\s*=\s*["']([^"']*)["']/i.exec(attrs);
    const valueM = /value\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (nameM) result[nameM[1]] = decodeHtmlEntities(valueM ? valueM[1] : '');
  }
  return result;
}

// ---- Auth0 OAuth2 PKCE flow --------------------------------------------------

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function auth0GetToken(username: string, password: string): Promise<PanasonicToken> {
  const version = await getAppVersion();
  const jar = new CookieJar();
  const verifier  = randomString(43);
  const challenge = codeChallenge(verifier);
  const state     = randomString(20);

  // Step 1 — GET /authorize (PKCE + redirect back to the deep-link callback URI)
  const authorizeParams = new URLSearchParams({
    scope: SCOPE, audience: AUDIENCE, protocol: 'oauth2', response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256',
    auth0Client: AUTH0_CLIENT, client_id: APP_CLIENT_ID,
    redirect_uri: REDIRECT_URI, state,
  });
  const authRes = await fetch(`${BASE_AUTH}/authorize?${authorizeParams}`, {
    headers: { 'user-agent': 'okhttp/4.10.0' },
    redirect: 'manual',
  });
  if (authRes.status !== 302) throw new Error(`Panasonic CC /authorize → ${authRes.status}`);
  jar.update(authRes);
  let location = authRes.headers.get('location') ?? '';
  const urlState = new URLSearchParams(location.split('?')[1] ?? '').get('state') ?? state;

  // Step 2 — Follow redirect to the login form (if not already at the callback URI)
  if (!location.startsWith(REDIRECT_URI)) {
    const redir = location.startsWith('http') ? location : `${BASE_AUTH}/${location.replace(/^\//, '')}`;
    const formRes = await fetch(redir, {
      headers: { 'user-agent': 'okhttp/4.10.0', Cookie: jar.header() },
      redirect: 'manual',
    });
    if (formRes.status !== 200) throw new Error(`Panasonic CC authorize_redirect → ${formRes.status}`);
    jar.update(formRes);
  }

  const csrf = jar.get('_csrf') ?? '';

  // Step 3 — POST username + password to Auth0
  const loginRes = await fetch(`${BASE_AUTH}/usernamepassword/login`, {
    method: 'POST',
    headers: {
      'Auth0-Client': AUTH0_CLIENT, 'user-agent': 'okhttp/4.10.0',
      'Content-Type': 'application/json', Cookie: jar.header(),
    },
    body: JSON.stringify({
      client_id: APP_CLIENT_ID, redirect_uri: REDIRECT_URI,
      tenant: 'pdpauthglb-a1', response_type: 'code', scope: SCOPE,
      audience: AUDIENCE, _csrf: csrf, state: urlState,
      _intstate: 'deprecated', username, password, lang: 'en',
      connection: 'PanasonicID-Authentication',
    }),
    redirect: 'manual',
  });
  if (loginRes.status !== 200) throw new Error(`Panasonic CC usernamepassword/login → ${loginRes.status}`);
  jar.update(loginRes);
  const loginHtml = await loginRes.text();

  const formInputs = extractHiddenInputs(loginHtml);
  if (Object.keys(formInputs).length === 0) {
    throw new Error('Panasonic CC login: no form inputs returned — credentials may be incorrect');
  }

  // Step 4 — POST hidden form to /login/callback (WS-Federation SSO hand-off)
  const callbackRes = await fetch(`${BASE_AUTH}/login/callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': MOBILE_UA, Cookie: jar.header(),
    },
    body: new URLSearchParams(formInputs).toString(),
    redirect: 'manual',
  });
  if (callbackRes.status !== 302) throw new Error(`Panasonic CC /login/callback → ${callbackRes.status}`);
  jar.update(callbackRes);
  location = callbackRes.headers.get('location') ?? '';

  // Step 5 — Follow one more redirect to arrive at the auth-code callback URI
  if (!location.startsWith(REDIRECT_URI)) {
    const redir2 = location.startsWith('http') ? location : `${BASE_AUTH}/${location.replace(/^\//, '')}`;
    const redir2Res = await fetch(redir2, {
      headers: { Cookie: jar.header() },
      redirect: 'manual',
    });
    jar.update(redir2Res);
    location = redir2Res.headers.get('location') ?? '';
  }

  const codeM = /[?&]code=([^&]+)/.exec(location);
  if (!codeM) throw new Error(`Panasonic CC: no auth code in redirect URI: ${location}`);
  const code = decodeURIComponent(codeM[1]);

  // Step 6 — Exchange code for OAuth tokens
  const tokenRes = await fetch(`${BASE_AUTH}/oauth/token`, {
    method: 'POST',
    headers: { 'Auth0-Client': AUTH0_CLIENT, 'user-agent': 'okhttp/4.10.0', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: 'openid', client_id: APP_CLIENT_ID,
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`Panasonic CC /oauth/token → ${tokenRes.status}`);
  const tokenJson = (await tokenRes.json()) as OAuthTokenResponse;

  // Step 7 — Get ACC client ID from the Comfort Cloud API
  const { key, ts } = computeApiKey(tokenJson.access_token);
  const v2Res = await fetch(`${BASE_ACC}/auth/v2/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'User-Agent': 'G-RAC', 'x-app-name': 'Comfort Cloud',
      'x-app-timestamp': ts, 'x-app-type': '1', 'x-app-version': version,
      'x-cfc-api-key': key,
      'x-user-authorization-v2': `Bearer ${tokenJson.access_token}`,
    },
    body: JSON.stringify({ language: 0 }),
  });
  if (!v2Res.ok) throw new Error(`Panasonic CC /auth/v2/login → ${v2Res.status}`);
  const v2Json = (await v2Res.json()) as { clientId?: string };

  return {
    access_token:  tokenJson.access_token,
    refresh_token: tokenJson.refresh_token,
    expires_at:    Date.now() + tokenJson.expires_in * 1000 - 60_000,
    acc_client_id: v2Json.clientId ?? '',
    app_version:   version,
  };
}

async function refreshOAuthToken(old: PanasonicToken): Promise<PanasonicToken> {
  const res = await fetch(`${BASE_AUTH}/oauth/token`, {
    method: 'POST',
    headers: { 'Auth0-Client': AUTH0_CLIENT, 'user-agent': 'okhttp/4.10.0', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: SCOPE, client_id: APP_CLIENT_ID,
      refresh_token: old.refresh_token, grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Panasonic CC token refresh → ${res.status}`);
  const j = (await res.json()) as OAuthTokenResponse;
  return {
    access_token:  j.access_token,
    refresh_token: j.refresh_token,
    expires_at:    Date.now() + j.expires_in * 1000 - 60_000,
    acc_client_id: old.acc_client_id,
    app_version:   old.app_version,
  };
}

// ---- Token cache -------------------------------------------------------------

interface PanasonicToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  acc_client_id: string;
  app_version: string;
}

let tokenCache: PanasonicToken | null = null;

async function getToken(): Promise<PanasonicToken> {
  const c = creds();
  if (!c) throw new Error('Panasonic CC not connected — add credentials in Settings or .env');

  if (tokenCache && tokenCache.expires_at > Date.now()) return tokenCache;

  if (tokenCache) {
    try {
      tokenCache = await refreshOAuthToken(tokenCache);
      return tokenCache;
    } catch {
      // Refresh failed — fall through to full re-auth
    }
  }

  tokenCache = await auth0GetToken(c.username, c.password);
  return tokenCache;
}

function invalidateToken(): void { tokenCache = null; }

// ---- Raw API types -----------------------------------------------------------

interface PanasonicParameters {
  operate?: number;
  operationMode?: number;
  temperatureSet?: number;
  insideTemperature?: number;
  outTemperature?: number;
  fanSpeed?: number;
  airSwingUD?: number;
  airSwingLR?: number;
}

interface PanasonicDevice {
  deviceGuid: string;
  deviceName: string;
  parameters?: PanasonicParameters;
}

interface PanasonicGroup {
  groupName?: string;
  deviceList?: PanasonicDevice[];
}

// ---- Vane mapping ------------------------------------------------------------
// Panasonic: 0=auto, 1–5=fixed, ≥6=swing. Our swing sentinel is 10.

function toVane(v?: number): number | null {
  if (v === undefined || v === null) return null;
  if (v === 0) return 0;
  if (v >= 1 && v <= 5) return v;
  return 10;
}

function fromVane(v: number): number {
  if (v === 0) return 0;
  if (v === 10) return 6;
  return Math.min(5, Math.max(1, v));
}

// ---- Ambient temperature -----------------------------------------------------
// Panasonic reports the indoor reading in `insideTemperature`, using the sentinel
// 126 when no value is available (unit off / sensor warming up). Anything outside a
// plausible room range is treated as "no reading" → null (UI shows "—").

function toInsideC(raw: number | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (raw >= 100 || raw <= -50) return null; // 126 = sentinel
  return raw;
}

// ---- Normalize device → ClimateUnit -----------------------------------------

function toClimateUnit(d: PanasonicDevice): ClimateUnit {
  const p = d.parameters ?? {};
  return {
    id:           internalId(d.deviceGuid),
    name:         d.deviceName,
    installation: 'Panasonic CC',
    power:        p.operate === 1,
    mode:         MODE[p.operationMode ?? -1] ?? 'unknown',
    setpointC:    p.temperatureSet ?? null,
    currentTempC: toInsideC(p.insideTemperature),
    minSetpointC: 16,
    maxSetpointC: 30,
    online:       true,
    fanLevel:     p.fanSpeed ?? null,
    vaneUpDown:   toVane(p.airSwingUD),
    vaneLeftRight: toVane(p.airSwingLR),
  };
}

// ---- Fleet read --------------------------------------------------------------

async function fetchFleet(): Promise<ClimateUnit[]> {
  const token = await getToken();
  const res = await fetch(`${BASE_ACC}/device/group`, {
    headers: accHeaders(token.access_token, token.acc_client_id, token.app_version),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) {
    invalidateToken();
    throw new Error('Panasonic CC token rejected — will re-auth next poll');
  }
  if (!res.ok) throw new Error(`Panasonic CC getGroups → HTTP ${res.status}`);
  const json = (await res.json()) as { groupList?: PanasonicGroup[] };
  const devices = (json.groupList ?? []).flatMap((g) => g.deviceList ?? []);

  // The group listing returns the 126 sentinel for `insideTemperature`; the live
  // ambient reading only comes from the per-device status endpoint. Fetch those in
  // parallel and overlay the live parameters (best-effort — fall back to the group
  // snapshot if a per-device read fails).
  await Promise.all(devices.map(async (d) => {
    const live = await fetchDeviceNow(token, d.deviceGuid);
    if (live) d.parameters = { ...(d.parameters ?? {}), ...live };
  }));

  return devices.map(toClimateUnit);
}

/** Per-device live snapshot — the only source of a real `insideTemperature`. */
async function fetchDeviceNow(token: PanasonicToken, guid: string): Promise<PanasonicParameters | null> {
  try {
    const res = await fetch(`${BASE_ACC}/deviceStatus/now/${encodeURIComponent(guid)}`, {
      headers: accHeaders(token.access_token, token.acc_client_id, token.app_version),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { parameters?: PanasonicParameters };
    return json.parameters ?? null;
  } catch {
    return null; // best-effort — keep the group snapshot
  }
}

/** Cached 30 s fleet snapshot; returns [] when not configured. */
export async function getFleet(): Promise<ClimateUnit[]> {
  if (!isConfigured()) return [];
  return cached('panasonic.fleet', 30_000, () => fetchFleet());
}

/** Drop the cached fleet so the next read reflects a write immediately (not after TTL). */
export function invalidateFleet(): void {
  invalidate('panasonic.fleet');
}

// ---- Control -----------------------------------------------------------------

export type PanasonicLever = 'power' | 'mode' | 'setpoint' | 'fan' | 'vaneUpDown' | 'vaneLeftRight';
export interface PanasonicSetResult { ok: boolean; detail: string; }

/** Write one lever to a Panasonic unit. Caller (climate-execute) applies guardrails. */
export async function setLever(
  id: string,
  lever: PanasonicLever,
  value: boolean | number | string,
): Promise<PanasonicSetResult> {
  const token = await getToken();
  const guid  = guidFor(id);

  const parameters: Record<string, number> = {};
  if (lever === 'power') {
    parameters.operate = value ? 1 : 0;
  } else if (lever === 'mode') {
    const code = MODE_VALUE[String(value)];
    if (code === undefined) throw new Error(`Panasonic CC unknown mode: ${value}`);
    parameters.operationMode = code;
  } else if (lever === 'setpoint') {
    parameters.temperatureSet = Number(value);
  } else if (lever === 'fan') {
    parameters.fanSpeed = Math.max(0, Math.round(Number(value)));
  } else if (lever === 'vaneUpDown') {
    parameters.airSwingUD = fromVane(Number(value));
  } else if (lever === 'vaneLeftRight') {
    parameters.airSwingLR = fromVane(Number(value));
  }

  // Comfort Cloud rejects overlapping control calls, so serialize writes — flipping
  // several units off in quick succession queues instead of racing. See write-queue.ts.
  return serialize('panasonic:cc', async () => {
    const res = await fetch(`${BASE_ACC}/deviceStatus/control`, {
      method: 'POST',
      headers: accHeaders(token.access_token, token.acc_client_id, token.app_version),
      body: JSON.stringify({ deviceGuid: guid, parameters }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) {
      invalidateToken();
      throw new Error('Panasonic CC token expired mid-write — will re-auth next request');
    }
    if (!res.ok) throw new Error(`Panasonic CC set → HTTP ${res.status}`);
    const json = (await res.json()) as { result?: number; message?: string };
    if (json.result !== 0) throw new Error(`Panasonic CC set rejected: ${json.message ?? String(json.result)}`);
    return { ok: true, detail: `${lever}=${String(value)} on ${id}` };
  });
}
