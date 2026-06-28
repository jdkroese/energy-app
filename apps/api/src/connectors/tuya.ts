// Tuya Cloud connector — the GENERIC foundation every Tuya device category builds
// on (lights first; covers/switches/breakers/fans next). Talks to the Tuya
// OpenAPI v2 over the internet, exactly the way Smart Life / Tuya Smart does.
// Cloud-first by design (works regardless of where the server sits); a local
// (tinytuya-style) path can be layered on later for latency/resilience.
//
// Onboarding model differs from the single-device connectors (Sonnen/Airzone):
// ONE Cloud project credential (Access ID + Secret, datacenter region) unlocks a
// whole heterogeneous FLEET. The user creates a project at iot.tuya.com, links
// their Tuya/Smart-Life app account to it, and pastes the Access ID/Secret into
// Settings → Connections. Discovery then enumerates every linked device.
//
// Auth (Tuya OpenAPI v2 HMAC-SHA256):
//  - TOKEN  : GET /v1.0/token?grant_type=1  signed with (client_id + t + sign).
//  - BIZ    : every other call signed with (client_id + access_token + t + sign).
//    stringToSign = METHOD\nSHA256(body)\n\nURL  (the empty line = no signed headers).
//    sign = HMAC_SHA256(secret, str).hex().toUpperCase().
// ⚠️ The EXACT response shapes + the per-category DP (datapoint) codes are
// validated live on first connect — Tuya is consistent but firmware varies.

import crypto from 'node:crypto';
import { cached, invalidate } from '../cache';
import { tuyaConfig } from '../runtime-config';

// Datacenter → OpenAPI host. The region MUST match the data center your Tuya app
// account is registered in (not just where you live). Spain is usually Central
// Europe (eu), but accounts can sit in the Azure-based Western Europe DC (weu).
const REGION_HOSTS: Record<string, string> = {
  eu: 'https://openapi.tuyaeu.com', // Central Europe
  weu: 'https://openapi-weaz.tuyaeu.com', // Western Europe (Azure)
  us: 'https://openapi.tuyaus.com', // Western America
  eus: 'https://openapi-ueaz.tuyaus.com', // Eastern America (Azure)
  cn: 'https://openapi.tuyacn.com', // China
  in: 'https://openapi.tuyain.com', // India
};
export const REGIONS = Object.keys(REGION_HOSTS);

const EMPTY_BODY_SHA256 = crypto.createHash('sha256').update('', 'utf8').digest('hex');

export interface TuyaCreds {
  region: string;
  accessId: string;
  accessSecret: string;
}

/** Creds from the in-app Settings store first, then env as a fallback. */
function creds(): TuyaCreds | null {
  const c = tuyaConfig();
  if (c.accessId && c.accessSecret) {
    return { region: c.region || 'eu', accessId: c.accessId, accessSecret: c.accessSecret };
  }
  return null;
}

function mustCreds(): TuyaCreds {
  const c = creds();
  if (!c) throw new Error('Tuya not connected — add your Cloud project in Settings');
  return c;
}

/** Whether a Tuya Cloud project has been connected (creds present). */
export function isConfigured(): boolean {
  return creds() !== null;
}

function host(region: string): string {
  return REGION_HOSTS[region] ?? REGION_HOSTS.eu;
}

// ---- Signing ----------------------------------------------------------------

function hmac(str: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}
function sha256(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

// ---- Token (cached; auto-refresh) -------------------------------------------

interface TuyaResp<T> {
  success: boolean;
  result?: T;
  code?: number;
  msg?: string;
  t?: number;
}

let tokenCache: { token: string; expireAt: number; accessId: string; region: string } | null = null;

async function fetchToken(c: TuyaCreds): Promise<string> {
  const path = '/v1.0/token?grant_type=1';
  const t = Date.now().toString();
  const stringToSign = ['GET', EMPTY_BODY_SHA256, '', path].join('\n');
  const sign = hmac(c.accessId + t + stringToSign, c.accessSecret);
  const res = await fetch(`${host(c.region)}${path}`, {
    headers: { client_id: c.accessId, sign, t, sign_method: 'HMAC-SHA256', nonce: '' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Tuya token -> HTTP ${res.status}`);
  const json = (await res.json()) as TuyaResp<{ access_token: string; expire_time: number; uid: string }>;
  if (!json.success || !json.result) {
    throw new Error(`Tuya token rejected: ${json.msg ?? 'unknown'} (code ${json.code ?? '?'})`);
  }
  tokenCache = {
    token: json.result.access_token,
    // Refresh a minute early to avoid races against the ~2h expiry.
    expireAt: Date.now() + Math.max(60, json.result.expire_time - 60) * 1000,
    accessId: c.accessId,
    region: c.region,
  };
  return tokenCache.token;
}

async function getToken(c: TuyaCreds): Promise<string> {
  if (
    tokenCache &&
    tokenCache.expireAt > Date.now() &&
    tokenCache.accessId === c.accessId &&
    tokenCache.region === c.region
  ) {
    return tokenCache.token;
  }
  return fetchToken(c);
}

// ---- Authenticated request (retries once on token expiry) -------------------

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  retry = true,
): Promise<T> {
  const c = mustCreds();
  const token = await getToken(c);
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const contentSha = body === undefined ? EMPTY_BODY_SHA256 : sha256(bodyStr);
  const t = Date.now().toString();
  const stringToSign = [method, contentSha, '', path].join('\n');
  const sign = hmac(c.accessId + token + t + stringToSign, c.accessSecret);

  const headers: Record<string, string> = {
    client_id: c.accessId,
    access_token: token,
    sign,
    t,
    sign_method: 'HMAC-SHA256',
    nonce: '',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${host(c.region)}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : bodyStr,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Tuya ${method} ${path} -> HTTP ${res.status}`);
  const json = (await res.json()) as TuyaResp<T>;
  if (!json.success) {
    // 1010 token expired / 1011 invalid / 1004 sign — drop the token and retry once.
    if (retry && (json.code === 1010 || json.code === 1011 || json.code === 1004)) {
      tokenCache = null;
      return request<T>(method, path, body, false);
    }
    throw new Error(`Tuya ${path} failed: ${json.msg ?? 'error'} (code ${json.code ?? '?'})`);
  }
  return json.result as T;
}

// ---- Devices ----------------------------------------------------------------

export interface TuyaStatusItem {
  code: string;
  value: unknown;
}

export interface TuyaDevice {
  id: string;
  name: string;
  /** Tuya product category code (e.g. 'dj' lights, 'cz' sockets, 'cl' curtains). */
  category: string;
  productName?: string;
  online: boolean;
  status: TuyaStatusItem[];
  /** Local key — captured for the future local-control path; never exposed to the client. */
  localKey?: string;
}

interface TuyaRawDevice {
  id: string;
  name?: string;
  category?: string;
  product_name?: string;
  online?: boolean;
  status?: TuyaStatusItem[];
  local_key?: string;
}

function normalizeRaw(d: TuyaRawDevice): TuyaDevice {
  return {
    id: d.id,
    name: d.name ?? d.id,
    category: d.category ?? '',
    productName: d.product_name,
    online: d.online ?? false,
    status: Array.isArray(d.status) ? d.status : [],
    localKey: d.local_key,
  };
}

/**
 * Enumerate every device linked to the connected Cloud project's app account,
 * paginated. Status is returned inline, so this doubles as a fleet read.
 */
async function listDevices(): Promise<TuyaDevice[]> {
  const out: TuyaDevice[] = [];
  let lastRowKey = '';
  // Bounded loop — a home has tens of devices, not thousands.
  for (let page = 0; page < 20; page++) {
    const q = lastRowKey ? `?last_row_key=${encodeURIComponent(lastRowKey)}` : '';
    const r = await request<{ devices?: TuyaRawDevice[]; has_more?: boolean; last_row_key?: string }>(
      'GET',
      `/v1.0/iot-01/associated-users/devices${q}`,
    );
    for (const d of r.devices ?? []) out.push(normalizeRaw(d));
    if (!r.has_more || !r.last_row_key) break;
    lastRowKey = r.last_row_key;
  }
  return out;
}

const FLEET_KEY = 'tuya.devices';

/** Cached fleet snapshot (20s). Returns [] when no project is connected. */
export function getDevices(): Promise<TuyaDevice[]> {
  if (!isConfigured()) return Promise.resolve([]);
  return cached(FLEET_KEY, 20_000, listDevices);
}

/** Force the next getDevices() to refetch — call right after a successful write. */
export function invalidateFleet(): void {
  invalidate(FLEET_KEY);
}

/** Fresh per-device status (bypasses the fleet cache). */
export function getStatus(id: string): Promise<TuyaStatusItem[]> {
  return request<TuyaStatusItem[]>('GET', `/v1.0/devices/${id}/status`);
}

/** Issue one or more datapoint commands to a device (legacy v1.0 command API). */
export function sendCommands(id: string, commands: Array<{ code: string; value: unknown }>): Promise<boolean> {
  return request<boolean>('POST', `/v1.0/devices/${id}/commands`, { commands });
}

/** Issue properties via the NEWER v2.0 "thing model" API. Some devices (often newer
 *  metering plugs / Matter-era firmware) silently ignore the v1.0 command endpoint
 *  and only actuate through this one. `properties` is a code→value map. */
export function sendThingCommands(id: string, properties: Record<string, unknown>): Promise<unknown> {
  return request<unknown>('POST', `/v2.0/cloud/thing/${id}/shadow/properties/issue`, {
    properties: JSON.stringify(properties),
  });
}

// ---- Low-level signed request that returns the RAW envelope (never throws on a
//      success:false). Only for diagnostics that must see code/msg/result verbatim.
async function rawRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<TuyaResp<T>> {
  const c = mustCreds();
  const token = await getToken(c);
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const contentSha = body === undefined ? EMPTY_BODY_SHA256 : sha256(bodyStr);
  const t = Date.now().toString();
  const stringToSign = [method, contentSha, '', path].join('\n');
  const sign = hmac(c.accessId + token + t + stringToSign, c.accessSecret);
  const headers: Record<string, string> = {
    client_id: c.accessId, access_token: token, sign, t, sign_method: 'HMAC-SHA256', nonce: '',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${host(c.region)}${path}`, {
    method, headers, body: body === undefined ? undefined : bodyStr, signal: AbortSignal.timeout(12_000),
  });
  return (await res.json()) as TuyaResp<T>;
}

export interface TuyaCmdProbe {
  api: 'v1' | 'v2';
  httpOk: boolean;
  success: boolean;
  result: unknown;
  code?: number;
  msg?: string;
}

/** Diagnostic: fire a single DP command through the chosen command API and return the
 *  RAW Tuya response (success/result/code/msg) so we can see exactly what the device
 *  accepts. `api` 'v1' = legacy commands; 'v2' = thing-model properties. */
export async function probeCommand(
  id: string, code: string, value: unknown, api: 'v1' | 'v2',
): Promise<TuyaCmdProbe> {
  try {
    const j = api === 'v1'
      ? await rawRequest<boolean>('POST', `/v1.0/devices/${id}/commands`, { commands: [{ code, value }] })
      : await rawRequest<unknown>('POST', `/v2.0/cloud/thing/${id}/shadow/properties/issue`, { properties: JSON.stringify({ [code]: value }) });
    return { api, httpOk: true, success: !!j.success, result: j.result ?? null, code: j.code, msg: j.msg };
  } catch (e) {
    return { api, httpOk: false, success: false, result: null, msg: (e as Error).message };
  }
}

export interface TuyaSpec {
  category: string;
  functions: Array<{ code: string; type: string; values: string }>;
  status: Array<{ code: string; type: string; values: string }>;
}

/** Device capability spec (DP ranges/types). Cached 1h — it never changes. */
export function getSpecifications(id: string): Promise<TuyaSpec> {
  return cached(`tuya.spec.${id}`, 3_600_000, () =>
    request<TuyaSpec>('GET', `/v1.0/devices/${id}/specifications`),
  );
}

// ---- Device identity / network (diagnostics) --------------------------------

/** Device detail — carries the LAN ip, model and uuid. Cached 5 min (ip can move). */
export interface TuyaDeviceDetail {
  id?: string;
  ip?: string;
  lat?: string;
  lon?: string;
  model?: string;
  uuid?: string;
  time_zone?: string;
}
export function getDeviceDetail(id: string): Promise<TuyaDeviceDetail> {
  return cached(`tuya.detail.${id}`, 300_000, () =>
    request<TuyaDeviceDetail>('GET', `/v1.0/devices/${id}`),
  );
}

/** Factory infos — the device's hardware MAC + serial. Cached 1h (immutable). */
export interface TuyaFactoryInfo {
  id: string;
  uuid?: string;
  sn?: string;
  mac?: string;
}
export function getFactoryInfos(ids: string[]): Promise<TuyaFactoryInfo[]> {
  const q = encodeURIComponent(ids.join(','));
  return cached(`tuya.factory.${q}`, 3_600_000, () =>
    request<TuyaFactoryInfo[]>('GET', `/v1.0/devices/factory-infos?device_ids=${q}`),
  );
}

// ---- Discovery helpers (for the Settings status panel) ----------------------

/** Human label per Tuya category code, grouped by the app's device-type buckets. */
export const CATEGORY_LABELS: Record<string, string> = {
  // Lights
  dj: 'Lights', dd: 'Light strips', dc: 'Light strings', fwd: 'Ambiance lights',
  xdd: 'Ceiling lights', fsd: 'Fan lights', tgq: 'Dimmers', tgkg: 'Dimmer switches', tyndj: 'Solar lights',
  // Switches / sockets / breakers
  kg: 'Switches', cz: 'Sockets', pc: 'Power strips', tdq: 'Breakers', wkcz: 'Sockets',
  // Covers
  cl: 'Curtains/blinds', clkg: 'Curtain switches',
  // Fans
  fs: 'Fans', fskg: 'Fan switches',
};

/**
 * Proposed app-facing device TYPE per Tuya category code — the onboarding-inference
 * map. Each entry is a coarse type label + a Lucide icon name the inbox renders. This
 * is intentionally broader than CATEGORY_LABELS (which is a fine-grained human label):
 * it buckets every category into one of the handful of types the app reasons about
 * (Light / Blind / Switch / Plug / Fan / Sensor / Climate / Lock / Siren). Categories
 * not listed fall through to "Unknown" (icon 'circle-help'). Extend here as new Tuya
 * categories appear in the wild.
 */
export interface ProposedType {
  /** Short type label shown on the inbox row (e.g. 'Light', 'Plug', 'Sensor'). */
  label: string;
  /** Lucide icon name for the row's icon tile. */
  icon: string;
}

const CATEGORY_TYPES: Record<string, ProposedType> = {
  // Lights
  dj: { label: 'Light', icon: 'lightbulb' },
  dd: { label: 'Light', icon: 'lightbulb' },
  dc: { label: 'Light', icon: 'lightbulb' },
  fwd: { label: 'Light', icon: 'lightbulb' },
  xdd: { label: 'Light', icon: 'lightbulb' },
  tgq: { label: 'Dimmer', icon: 'lightbulb' },
  tgkg: { label: 'Dimmer', icon: 'lightbulb' },
  tyndj: { label: 'Light', icon: 'lightbulb' },
  fsd: { label: 'Fan light', icon: 'fan' },
  // Blinds / curtains
  cl: { label: 'Blind', icon: 'blinds' },
  clkg: { label: 'Blind', icon: 'blinds' },
  // Switches / sockets / plugs / breakers
  cz: { label: 'Plug', icon: 'plug' },
  pc: { label: 'Power strip', icon: 'plug' },
  kg: { label: 'Switch', icon: 'toggle-right' },
  tdq: { label: 'Breaker', icon: 'toggle-right' },
  wkcz: { label: 'Plug', icon: 'plug' },
  // Fans
  fs: { label: 'Fan', icon: 'fan' },
  fskg: { label: 'Fan switch', icon: 'fan' },
  // Sensors
  wsdcg: { label: 'Sensor', icon: 'thermometer' },
  ms: { label: 'Sensor', icon: 'radar' },
  pir: { label: 'Sensor', icon: 'radar' },
  mcs: { label: 'Sensor', icon: 'door-open' },
  cobj: { label: 'Sensor', icon: 'radar' },
  pm25: { label: 'Sensor', icon: 'wind' },
  ywbj: { label: 'Sensor', icon: 'flame' },
  rqbj: { label: 'Sensor', icon: 'flame' },
  sj: { label: 'Sensor', icon: 'droplet' },
  // Climate / thermostat
  wk: { label: 'Climate', icon: 'thermometer-sun' },
  wkf: { label: 'Climate', icon: 'thermometer-sun' },
  qn: { label: 'Heater', icon: 'flame' },
  ktkzq: { label: 'Climate', icon: 'thermometer-sun' },
  // Locks
  jtmspro: { label: 'Lock', icon: 'lock' },
  jtmsbh: { label: 'Lock', icon: 'lock' },
  mk: { label: 'Lock', icon: 'lock' },
  // Sirens / alarms
  sgbj: { label: 'Siren', icon: 'siren' },
  bjq: { label: 'Siren', icon: 'siren' },
};

const UNKNOWN_TYPE: ProposedType = { label: 'Unknown', icon: 'circle-help' };

/** Proposed app-facing type + icon for a Tuya category code (Unknown when unmapped). */
export function proposedType(category: string): ProposedType {
  return CATEGORY_TYPES[category] ?? UNKNOWN_TYPE;
}

/** Summarize a fleet into {label: count} buckets for the connection status UI. */
export function categorize(devices: TuyaDevice[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const d of devices) {
    const label = CATEGORY_LABELS[d.category] ?? `Other (${d.category || '?'})`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/** Validate creds by fetching a token (used by the Settings "test/connect" flow). */
export async function probe(c: TuyaCreds): Promise<void> {
  tokenCache = null; // never trust a stale token from previous creds
  await fetchToken(c);
}
