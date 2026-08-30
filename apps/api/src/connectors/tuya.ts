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
import { logEvent } from '../events';
import { tuyaConfig } from '../runtime-config';
import * as store from '../store';
import * as tuyaLocal from './tuya-local';

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

// Tuya's HMAC signs the request URL with query params sorted alphabetically by
// key, and the actual request must use that same order — otherwise the API
// returns `1004 sign invalid`. (Single-param calls are unaffected; this matters
// for multi-param GETs like device logs.) Canonicalize so signing and URL agree.
function canonicalQuery(path: string): string {
  const qi = path.indexOf('?');
  if (qi < 0) return path;
  const base = path.slice(0, qi);
  const params = path
    .slice(qi + 1)
    .split('&')
    .filter(Boolean)
    .sort((a, b) => (a.split('=')[0] < b.split('=')[0] ? -1 : 1));
  return `${base}?${params.join('&')}`;
}

// ---- Quota guard -------------------------------------------------------------
// When the IoT Core plan's API quota is exhausted (code 28841004) Tuya suspends the
// whole service — every call fails, but our pollers (button-scan every 5s, fleet
// refreshes, voltage monitor) would keep firing thousands of doomed requests. Cool
// off: after a quota error, fail fast locally and let only one probe through per
// minute to detect recovery. Log ONE high-severity connectivity event per outage
// (forwards to Push/WA/Email) and a cleared event when service returns.

const QUOTA_EXHAUSTED_CODE = 28841004;
const QUOTA_PROBE_MS = 60_000;
let quotaBlockedUntil = 0;
let quotaOutage = false;

function noteQuotaExhausted(msg: string): void {
  quotaBlockedUntil = Date.now() + QUOTA_PROBE_MS;
  if (quotaOutage) return;
  quotaOutage = true;
  logEvent({
    class: 'observation',
    category: 'connectivity',
    severity: 'high',
    state: 'active',
    summary: 'Tuya API quota exhausted — all Tuya devices unavailable until the IoT Core plan is renewed/extended',
    trigger: { source: 'health-probe', detail: msg },
  });
}

function noteQuotaRecovered(): void {
  if (!quotaOutage) return;
  quotaOutage = false;
  quotaBlockedUntil = 0;
  logEvent({
    class: 'observation',
    category: 'connectivity',
    severity: 'low',
    state: 'cleared',
    summary: 'Tuya API quota restored — Tuya devices reachable again',
    trigger: { source: 'health-probe' },
  });
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  retry = true,
): Promise<T> {
  if (Date.now() < quotaBlockedUntil) {
    throw new Error('Tuya API quota exhausted (cooling off; renew the IoT Core plan in the Tuya console)');
  }
  const c = mustCreds();
  const token = await getToken(c);
  const signedPath = canonicalQuery(path);
  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const contentSha = body === undefined ? EMPTY_BODY_SHA256 : sha256(bodyStr);
  const t = Date.now().toString();
  const stringToSign = [method, contentSha, '', signedPath].join('\n');
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

  const res = await fetch(`${host(c.region)}${signedPath}`, {
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
    if (json.code === QUOTA_EXHAUSTED_CODE) noteQuotaExhausted(`${path}: ${json.msg ?? ''}`);
    throw new Error(`Tuya ${path} failed: ${json.msg ?? 'error'} (code ${json.code ?? '?'})`);
  }
  noteQuotaRecovered();
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
  return supplementDroppedDevices(out);
}

// ---- Fleet self-heal --------------------------------------------------------
// Tuya's associated-users listing can silently DROP devices that are still
// registered + online on the project (cloud-link decay: on 2026-07-02 it lost 13
// at once — dimmers, blinds, plugs, a breaker — which emptied them out of the
// Lights/Blinds/Rooms surfaces). The per-device endpoint keeps working for them,
// so every fleet read supplements the bulk list with a direct read of each id
// the app knows about that's missing. Runs inside the fleet cache, and each
// direct read carries its own 20s/300s SWR cache, so the recovery adds at most
// one extra call per missing device per refresh.

/** Ids the app knows: set-up devices, room assignments, light-scene members. */
function knownDeviceIds(): string[] {
  try {
    const s = store.get();
    const ids = new Set<string>([
      ...Object.keys(s.deviceOnboarding.configured),
      ...Object.keys(s.deviceSettings),
    ]);
    for (const scene of s.lightScenes) for (const m of scene.members) ids.add(m.lightId);
    // Only Tuya-shaped ids — deviceSettings also holds climate/irrigation ids ('air-1-1', 'rb-…').
    return [...ids].filter((id) => /^bf[0-9a-z]{10,}$/.test(id));
  } catch {
    return [];
  }
}

// One probe per missing device per fleet refresh burned real API quota (~12 extra calls
// per 20s refresh helped exhaust the IoT Core trial pack on 2026-07-03). Re-probe at most
// every 2 min; between probes fold in the last recovered snapshot. Writes stay snappy —
// invalidateFleet() (called after every successful command) clears this snapshot too, so
// a just-commanded device is re-read fresh on the next refresh.
const SUPPLEMENT_PROBE_MS = 120_000;
let supplementCache: { ts: number; devices: TuyaDevice[] } | null = null;

/** Called from invalidateFleet — a write just happened, drop the recovered snapshot. */
function invalidateSupplement(): void {
  supplementCache = null;
}

async function supplementDroppedDevices(fleet: TuyaDevice[]): Promise<TuyaDevice[]> {
  const have = new Set(fleet.map((d) => d.id));
  const missing = knownDeviceIds().filter((id) => !have.has(id));
  if (!missing.length) {
    lastDropoutKey = '';
    supplementCache = null;
    return fleet;
  }
  if (supplementCache && Date.now() - supplementCache.ts < SUPPLEMENT_PROBE_MS) {
    return [...fleet, ...supplementCache.devices.filter((d) => !have.has(d.id))];
  }
  const recovered = (await Promise.all(missing.map((id) => getDeviceDirect(id)))).filter(
    (d): d is TuyaDevice => d !== null,
  );
  supplementCache = { ts: Date.now(), devices: recovered };
  noteFleetDropout(missing, recovered);
  return [...fleet, ...recovered];
}

let lastDropoutKey = '';

/** Event-log a dropout once per distinct missing-set (not on every 20s refresh). */
function noteFleetDropout(missing: string[], recovered: TuyaDevice[]): void {
  const key = missing.slice().sort().join(',');
  if (key === lastDropoutKey) return;
  lastDropoutKey = key;
  logEvent({
    class: 'system',
    category: 'connectivity',
    severity: 'medium',
    summary: `Tuya fleet list dropped ${missing.length} known device(s); ${recovered.length} recovered via direct reads`,
    trigger: { source: 'health-probe', detail: 'associated-users listing missing known devices' },
    data: {
      missing,
      recovered: recovered.map((d) => `${d.name} (${d.id})`),
      unrecoverable: missing.filter((id) => !recovered.some((d) => d.id === id)),
    },
  });
}

// ---- Local fleet fallback (docs/49 Change 2/3) -------------------------------------------
// The fleet listing was the LAST hidden cloud dependency: even with local-first
// getStatus/sendCommands, the device LIST itself only ever came from listDevices() (the
// cloud's associated-users/devices call) — see docs/49 "Problem" #1. Once a device's dp-map
// is persisted (Change 1), its LAN status can be read directly, so a whole fleet snapshot can
// be assembled with zero cloud calls. getDevices() below reaches for this the moment cloud is
// unusable (quota-blocked, unconfigured, or listDevices() itself throwing).

const LOCAL_FLEET_CONCURRENCY = 6;

/** Run `fn` over `items` with at most `limit` in flight at once — LAN sockets, unlike cloud
 *  HTTP calls, must not be opened 40-at-once (each Tuya device accepts only one local session
 *  at a time; see tuya-local.ts's connection-pool comment). Exported for tests. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Build a fleet snapshot entirely from the LOCAL registry + LAN reads — zero cloud calls.
 *  Only includes devices that are BOTH locally capable (key + LAN ip + a supported protocol
 *  version — tuya-local.ts's isLocalCapable) AND already have a persisted dp-map (Change 1)
 *  to translate raw dps with; every other registry device (no key/ip yet, an unsupported
 *  version, or a Zigbee/BLE sub-device that is never LAN-reachable at all) simply doesn't
 *  appear — acceptable during a blackout (docs/49 "Goal": sub-devices may degrade). A
 *  per-device LAN read failure degrades that ONE entry to `online:false, status:[]` rather
 *  than dropping it from the list or failing the whole snapshot. Exported for tests. */
export async function localFleetSnapshot(): Promise<TuyaDevice[]> {
  const entries = tuyaLocal
    .listRegistry()
    .filter((e) => tuyaLocal.isLocalCapable(e.id) && tuyaLocal.getDpMap(e.id) !== null);

  return mapWithConcurrency(entries, LOCAL_FLEET_CONCURRENCY, async (entry): Promise<TuyaDevice> => {
    const maps = tuyaLocal.getDpMap(entry.id); // pure map read, no I/O — safe to call again per-device
    try {
      const dps = await tuyaLocal.readStatus(entry.id);
      const status = maps ? tuyaLocal.translateStatus(dps, maps.dpToCode) : [];
      return { id: entry.id, name: entry.name, category: entry.category, online: true, status, localKey: entry.localKey };
    } catch {
      return { id: entry.id, name: entry.name, category: entry.category, online: false, status: [], localKey: entry.localKey };
    }
  });
}

const FLEET_KEY = 'tuya.devices';
const LOCAL_FLEET_KEY = 'tuya.devices.local';
const FLEET_TTL_MS = 20_000;
// docs/49 Change 3: once local control is proven out, the interactive hot paths
// (getStatus/sendCommands — both already local-first) no longer need the FLEET listing
// refreshed every 20s; that 20s cloud poll is exactly what exhausted a fresh dev account's
// monthly quota in ~10 days (docs/49 "Problem"). Conservative choice per the brief: cloud
// stays PRIMARY for the full fleet whenever it's healthy — so sub-devices (Zigbee/BLE, never
// locally reachable, the app's only INPUT devices) keep appearing exactly as before;
// localFleetSnapshot() above never lists them. Only the REFRESH CADENCE changes: 5 minutes
// instead of 20s while local control is enabled. Local is reached for only on an outright
// cloud failure (not configured, quota-blocked, or listDevices() itself throwing) — that's
// what turns a blackout into a non-event without risking a sub-device regression during
// normal operation. This cadence (20s -> 5min) is the exact number to verify on the mini.
const FLEET_TTL_LOCAL_HEALTHY_MS = 300_000;

function localFleetSnapshotCached(): Promise<TuyaDevice[]> {
  // Distinct 20s-TTL key from FLEET_KEY (the cloud snapshot) — a blackout falling back here
  // must never clobber whatever cloud snapshot is still sitting in the cache under FLEET_KEY,
  // so cloud recovery can resume serving it immediately without a cold refetch.
  return cached(LOCAL_FLEET_KEY, 20_000, localFleetSnapshot);
}

/** Cached fleet snapshot. Cloud-primary whenever a project is configured and not
 *  quota-blocked (refresh cadence depends on whether local control is enabled — see
 *  FLEET_TTL_LOCAL_HEALTHY_MS above); falls back to the LOCAL LAN snapshot (docs/49 Change 2)
 *  on any cloud failure, or when no project is configured at all but local control is on.
 *  With local control OFF this is byte-for-byte the pre-docs/49 cloud-only behaviour —
 *  isLocalEnabled() short-circuits every local branch before it does anything. */
export function getDevices(): Promise<TuyaDevice[]> {
  const localOn = tuyaLocal.isLocalEnabled();
  if (!isConfigured()) {
    return localOn ? localFleetSnapshotCached() : Promise.resolve([]);
  }
  // During a quota cooldown, don't even attempt cloud when local can serve. When local is
  // OFF, fall through to the cloud cache below instead — so this path stays byte-for-byte the
  // pre-docs/49 behaviour (stale-while-revalidate grace, then the quota error), never [].
  if (localOn && Date.now() < quotaBlockedUntil) {
    return localFleetSnapshotCached();
  }
  // Serve an expired-but-recent snapshot instantly and refresh in the background, so a
  // slow Tuya Cloud response never blocks the Devices page. Writes call invalidateFleet,
  // so control-action freshness is preserved. (Mirrors the climate connectors.)
  const cloud = cached(FLEET_KEY, localOn ? FLEET_TTL_LOCAL_HEALTHY_MS : FLEET_TTL_MS, listDevices, { staleMs: 300_000 });
  return localOn ? cloud.catch(() => localFleetSnapshotCached()) : cloud;
}

/** Force the next getDevices() to refetch — call right after a successful write. */
export function invalidateFleet(): void {
  invalidate(FLEET_KEY);
  invalidate(LOCAL_FLEET_KEY);
  invalidateSupplement();
}

/**
 * Direct single-device read (bypasses the bulk associated-users list). Used to RECOVER a
 * configured device that has fallen out of the fleet list — e.g. its cloud link dropped so it
 * no longer appears in /associated-users/devices even though it's still registered to the
 * project. The per-device endpoint still returns its record (with last-known status + the
 * online flag). Returns null when the device truly isn't on the project, or on any error.
 * Cached 20s (same TTL as the fleet) so a missing device costs at most one extra call/cycle.
 */
export function getDeviceDirect(id: string): Promise<TuyaDevice | null> {
  if (!isConfigured()) return Promise.resolve(null);
  return cached(
    `tuya.device.${id}`,
    20_000,
    async () => {
      try {
        const d = await request<TuyaRawDevice>('GET', `/v1.0/devices/${id}`);
        return d && d.id ? normalizeRaw(d) : null;
      } catch {
        return null;
      }
    },
    { staleMs: 300_000 },
  );
}

/** Fresh per-device status (bypasses the fleet cache). Tries LOCAL (LAN) first when
 *  docs/44 Phase 2 local control is enabled and this device is locally capable — falls
 *  back to the unchanged cloud read on ANY local failure (translation, timeout, offline),
 *  so behaviour never regresses when local isn't available or the flag is off. */
export async function getStatus(id: string): Promise<TuyaStatusItem[]> {
  if (tuyaLocal.isLocalEnabled() && tuyaLocal.isLocalCapable(id)) {
    try {
      const { dpToCode } = await dpMapsFor(id);
      if (dpToCode.size > 0) {
        const dps = await tuyaLocal.readStatus(id);
        const items = tuyaLocal.translateStatus(dps, dpToCode);
        if (items.length > 0) return items;
      }
    } catch {
      // Local unavailable/failed for any reason — fall through to the cloud read below.
    }
  }
  return request<TuyaStatusItem[]>('GET', `/v1.0/devices/${id}/status`);
}

// ---- Device logs (DP-report history) ----------------------------------------

export interface TuyaDeviceLog {
  event_time: number;
  code: string;
  value: string;
  event_id?: number;
}
export interface TuyaDeviceLogs {
  logs?: TuyaDeviceLog[];
  has_next?: boolean;
}

// Log the first successful logs response once so we can confirm the shape on the mini.
/**
 * Timestamped datapoint-report history for a device. `type=7` = "data point report"
 * — the rows needed to detect momentary events (e.g. scene-switch button presses,
 * including repeated identical ones, which a status poll cannot distinguish).
 * Times are epoch-ms. Query params are sorted by request() for Tuya's signature.
 */
export async function getDeviceLogs(
  id: string,
  startMs: number,
  endMs: number,
  size = 20,
): Promise<TuyaDeviceLogs> {
  return request<TuyaDeviceLogs>(
    'GET',
    `/v1.0/devices/${id}/logs?type=7&start_time=${startMs}&end_time=${endMs}&size=${size}`,
  );
}

/** Cloud-only v1.0 command POST (no local branch) — the raw fallback used by both
 *  sendCommands (after a local miss) and sendCommandsDual's fan-out. */
function cloudSendCommands(id: string, commands: Array<{ code: string; value: unknown }>): Promise<boolean> {
  return request<boolean>('POST', `/v1.0/devices/${id}/commands`, { commands });
}

/** Issue one or more datapoint commands to a device. Tries LOCAL (LAN) first when local
 *  control is enabled and the device is locally capable (docs/44), falling back to the cloud
 *  v1.0 command API on ANY local failure. This is the single-API choke point that native
 *  lights, blinds and the schedule/surplus coordinators call directly — routing local HERE
 *  means those paths get LAN control too, not only the configured-device path that flows
 *  through sendCommandsDual. With local off/incapable this is byte-for-byte the old cloud POST. */
export async function sendCommands(id: string, commands: Array<{ code: string; value: unknown }>): Promise<boolean> {
  if (tuyaLocal.isLocalEnabled() && tuyaLocal.isLocalCapable(id)) {
    try {
      const { codeToDp } = await dpMapsFor(id);
      await tuyaLocal.sendCommands(id, commands, codeToDp);
      return true;
    } catch {
      // Local unavailable/failed for any reason — fall through to the cloud command below.
    }
  }
  return cloudSendCommands(id, commands);
}

/** Issue properties via the NEWER v2.0 "thing model" API. Some devices (often newer
 *  metering plugs / Matter-era firmware) silently ignore the v1.0 command endpoint
 *  and only actuate through this one. `properties` is a code→value map. */
export function sendThingCommands(id: string, properties: Record<string, unknown>): Promise<unknown> {
  return request<unknown>('POST', `/v2.0/cloud/thing/${id}/shadow/properties/issue`, {
    properties: JSON.stringify(properties),
  });
}

/** Issue commands via the iot-03 "general" command API — the path some newer device
 *  models accept when the classic /v1.0/devices/{id}/commands is a silent no-op. */
export function sendIot03Commands(id: string, commands: Array<{ code: string; value: unknown }>): Promise<unknown> {
  return request<unknown>('POST', `/v1.0/iot-03/devices/${id}/commands`, { commands });
}

/**
 * Issue a DP command set through EVERY Tuya control API — legacy v1.0 commands, the
 * iot-03 command path, and the v2.0 thing-model properties — succeeding if ANY is
 * accepted. Devices vary wildly: older Tuya devices obey v1, while newer metering plugs
 * / Matter-era firmware accept v1 (success:true) yet only physically actuate via the
 * thing-model or iot-03 path. Each command sets an ABSOLUTE value (e.g. switch_1=true),
 * so issuing them all is idempotent — the device lands in the same state whichever path
 * delivers. Best-effort per API; throws only when ALL fail. Returns which APIs accepted.
 *
 * docs/44 Phase 2: LOCAL (LAN) is tried FIRST when enabled (TUYA_LOCAL_ENABLED=1) and the
 * device is locally capable. A local success returns immediately — the cloud fan-out below
 * is skipped entirely, which is the whole point (zero cloud calls on the hot path). ANY
 * local failure (untranslatable code, offline, timeout, cooldown) falls through to the
 * cloud fan-out UNCHANGED, so behaviour never regresses; with the flag off this function
 * is byte-for-byte what it was before (the local branch is skipped before touching
 * anything, including the network — isLocalEnabled() short-circuits the `&&`).
 */
export async function sendCommandsDual(
  id: string, commands: Array<{ code: string; value: unknown }>,
): Promise<{ v1: boolean; iot03: boolean; thing: boolean; local: boolean }> {
  if (tuyaLocal.isLocalEnabled() && tuyaLocal.isLocalCapable(id)) {
    try {
      const { codeToDp } = await dpMapsFor(id);
      await tuyaLocal.sendCommands(id, commands, codeToDp);
      return { v1: false, iot03: false, thing: false, local: true };
    } catch {
      // Local unavailable/failed for any reason — fall through to the cloud fan-out below.
    }
  }

  const properties: Record<string, unknown> = {};
  for (const c of commands) properties[c.code] = c.value;
  let v1 = false;
  let iot03 = false;
  let thing = false;
  let lastErr: unknown = null;
  try { await cloudSendCommands(id, commands); v1 = true; } catch (e) { lastErr = e; }
  try { await sendIot03Commands(id, commands); iot03 = true; } catch (e) { lastErr = e; }
  try { await sendThingCommands(id, properties); thing = true; } catch (e) { lastErr = e; }
  if (!v1 && !iot03 && !thing) throw lastErr instanceof Error ? lastErr : new Error('command rejected on all Tuya APIs');
  return { v1, iot03, thing, local: false };
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

export type CmdApi = 'v1' | 'iot03' | 'v2';
export interface TuyaCmdProbe {
  api: CmdApi;
  httpOk: boolean;
  success: boolean;
  result: unknown;
  code?: number;
  msg?: string;
}

/** Diagnostic: fire a single DP command through the chosen command API and return the
 *  RAW Tuya response (success/result/code/msg) so we can see exactly what the device
 *  accepts. 'v1' = legacy commands; 'iot03' = iot-03 commands; 'v2' = thing-model. */
export async function probeCommand(
  id: string, code: string, value: unknown, api: CmdApi,
): Promise<TuyaCmdProbe> {
  try {
    const j =
      api === 'v1' ? await rawRequest<boolean>('POST', `/v1.0/devices/${id}/commands`, { commands: [{ code, value }] })
      : api === 'iot03' ? await rawRequest<unknown>('POST', `/v1.0/iot-03/devices/${id}/commands`, { commands: [{ code, value }] })
      : await rawRequest<unknown>('POST', `/v2.0/cloud/thing/${id}/shadow/properties/issue`, { properties: JSON.stringify({ [code]: value }) });
    return { api, httpOk: true, success: !!j.success, result: j.result ?? null, code: j.code, msg: j.msg };
  } catch (e) {
    return { api, httpOk: false, success: false, result: null, msg: (e as Error).message };
  }
}

export interface TuyaSpec {
  category: string;
  // `dp_id` is optional because most existing callers never needed it (only the local-
  // control DP translation below does) — the raw Tuya response always carries it.
  functions: Array<{ code: string; type: string; values: string; dp_id?: number }>;
  status: Array<{ code: string; type: string; values: string; dp_id?: number }>;
}

/** Device capability spec (DP ranges/types). Cached 1h — it never changes. */
export function getSpecifications(id: string): Promise<TuyaSpec> {
  return cached(`tuya.spec.${id}`, 3_600_000, () =>
    request<TuyaSpec>('GET', `/v1.0/devices/${id}/specifications`),
  );
}

// ---- Local (LAN) control wiring — docs/44 Phase 2 ---------------------------------
// The cloud and local protocols name a device's datapoints differently (cloud: human
// `code` strings; local: small numeric `dp` indices). getSpecifications()'s `dp_id` field
// is the only source of that mapping, so it's built here (once per device, then cached for
// as long as this process runs — the mapping never changes for a device) and handed to
// tuya-local.ts, which never fetches anything cloud-side itself. This keeps tuya-local.ts
// import-free of this file (avoids a circular import that could break the esbuild bundle)
// while still amortizing the one-time cloud lookup against the SAME 1h spec cache every
// other Tuya diagnostics/onboarding path already warms.

interface DpMaps {
  codeToDp: Map<string, number>;
  dpToCode: Map<number, string>;
}

// Per-device, process-lifetime cache — the underlying getSpecifications() call already has
// its own 1h TTL cache, but a DP layout never changes for a given device at all, so once
// built here it's reused for as long as the process runs (cleared only on the (rare) error
// path, so a device that failed to resolve isn't stuck retrying nothing forever).
const dpMapCache = new Map<string, DpMaps>();

/** Parse a Tuya thing-model JSON string into a code -> local-dp map. Each property carries
 *  `abilityId`, which IS the numeric local datapoint the LAN protocol uses. Pure + tolerant
 *  (bad JSON / missing fields -> empty map, never throws). Exported for tests. */
export function parseThingModelDpMap(modelJson: string): Map<string, number> {
  const map = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelJson);
  } catch {
    return map;
  }
  const services =
    (parsed as { services?: Array<{ properties?: Array<{ code?: unknown; abilityId?: unknown }> }> })
      .services ?? [];
  for (const svc of services) {
    for (const prop of svc.properties ?? []) {
      if (typeof prop.code === 'string' && typeof prop.abilityId === 'number') {
        map.set(prop.code, prop.abilityId);
      }
    }
  }
  return map;
}

interface ThingModelResp {
  model?: string;
}

/** Fetch the thing model and derive its code -> dp map. Cached 1h (a DP layout is immutable). */
async function thingModelDpMap(id: string): Promise<Map<string, number>> {
  const resp = await cached(`tuya.thingmodel.${id}`, 3_600_000, () =>
    request<ThingModelResp>('GET', `/v2.0/cloud/thing/${id}/model`),
  );
  return resp?.model ? parseThingModelDpMap(resp.model) : new Map<string, number>();
}

/** Normalize a Tuya dp code to a token-set key so different spellings of the SAME datapoint
 *  collapse together — e.g. a dimmer relay is `switch_led_1` in the cloud spec but
 *  `led_switch_1` in the thing model; both normalize to `1_led_switch`. Exported for tests. */
export function normCode(code: string): string {
  return code
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join('_');
}

/** Exported for docs/49 Change 4 (captureDpMaps) and tests — everywhere else in this file
 *  still just calls it directly. */
export async function dpMapsFor(id: string): Promise<DpMaps> {
  const hit = dpMapCache.get(id);
  if (hit) return hit;

  // docs/49 Change 1: a dp-map persisted to tuya-local.json (captured on a PAST successful
  // cloud fetch — see the bottom of this function) needs zero cloud calls to reuse. This is
  // what removes the second hidden cloud dependency a quota blackout used to hit — before
  // this, an expired dpMapCache entry (process restart, or simply this being the first call
  // this process lifetime) always re-fetched the thing model from the cloud, which fails
  // during a blackout exactly like the fleet listing does.
  const persisted = tuyaLocal.getDpMap(id);
  if (persisted) {
    dpMapCache.set(id, persisted);
    return persisted;
  }

  const codeToDp = new Map<string, number>();
  const dpToCode = new Map<number, string>();

  // PRIMARY source: the thing model. Its `abilityId` is the local dp number, and it is
  // present across projects/regions — unlike /specifications' `dp_id`, which some projects
  // (ours) omit entirely, silently leaving this map empty so every local command/read failed
  // translation and fell back to the cloud. See parseThingModelDpMap.
  try {
    for (const [code, dp] of await thingModelDpMap(id)) {
      codeToDp.set(code, dp);
      dpToCode.set(dp, code);
    }
  } catch {
    // Thing model unavailable (offline / quota) — fall through to the /specifications path.
  }

  // BRIDGE cloud/status code spellings to the thing-model dp numbers. Tuya can name the SAME
  // datapoint differently across API surfaces (e.g. a dimmer relay is `switch_led_1` in the
  // cloud spec but `led_switch_1` in the thing model). The app builds commands from the CLOUD
  // codes, so without this alias their local write fails translation and — with cloud control
  // now quota-limited (code 60001001) — the device becomes uncontrollable. Add only an
  // UNAMBIGUOUS alias (normalized code that maps to exactly one dp); never override an exact code.
  if (codeToDp.size > 0) {
    try {
      const spec = await getSpecifications(id);
      const byNorm = new Map<string, number[]>();
      for (const [code, dp] of codeToDp) {
        const k = normCode(code);
        const arr = byNorm.get(k);
        if (arr) arr.push(dp);
        else byNorm.set(k, [dp]);
      }
      for (const entry of [...spec.functions, ...spec.status]) {
        if (codeToDp.has(entry.code)) continue;
        const dps = byNorm.get(normCode(entry.code));
        if (dps && dps.length === 1) codeToDp.set(entry.code, dps[0]);
      }
    } catch {
      // Spec unavailable — the thing-model map alone still serves any exactly-matching code.
    }
  }

  // FALLBACK: /specifications' `dp_id`, for any device/region that does include it.
  if (codeToDp.size === 0) {
    try {
      const spec = await getSpecifications(id);
      for (const entry of [...spec.functions, ...spec.status]) {
        if (typeof entry.dp_id === 'number') {
          codeToDp.set(entry.code, entry.dp_id);
          dpToCode.set(entry.dp_id, entry.code);
        }
      }
    } catch {
      // Nothing available — empty maps mean the caller falls back to cloud. Not cached, so
      // the next call retries (both underlying fetches are themselves cheaply cached).
      return { codeToDp, dpToCode };
    }
  }

  // Never cache an empty map — a transient miss shouldn't wedge local control off for the
  // whole process lifetime; retry on the next call instead.
  if (codeToDp.size === 0) return { codeToDp, dpToCode };
  const result = { codeToDp, dpToCode };
  dpMapCache.set(id, result);
  // Persist for next time (docs/49 Change 1) — the DP layout is immutable per device, so
  // this cloud fetch (and every one after it, forever) is the LAST one this device will
  // ever need. Best-effort/no-op-safe (see setDpMap); never blocks the caller.
  tuyaLocal.setDpMap(id, codeToDp);
  return result;
}

// ---- One-shot dp-map capture (docs/49 Change 4) ------------------------------------------
// The chicken-and-egg docs/49 calls out: capturing a device's dp-map needs one successful
// cloud thing-model fetch, so this front-loads it for the whole fleet while cloud is briefly
// alive (e.g. right after the owner extends the IoT-Core trial), guaranteeing local-only
// coverage BEFORE the next blackout instead of hoping every device happened to get a normal
// getStatus/sendCommands call (and therefore a dpMapsFor lookup) during the healthy window.

export interface CaptureDpMapsResult {
  total: number;
  captured: number;
  alreadyHad: number;
  failed: number;
  /** Ids that could not resolve a non-empty dp-map this run — for admin troubleshooting;
   *  never includes localKey or any other sensitive field. */
  failedIds: string[];
}

/** Iterate the registry (docs/44's harvested fleet — tuya-local.json), calling dpMapsFor()
 *  for every device EXCEPT Zigbee/BLE gateway sub-devices, to force a cloud fetch + persist
 *  for any that don't already have one. Deliberately broader than "currently locally
 *  capable" (key + LAN ip + supported version — tuya-local.ts's isLocalCapable): a device
 *  that's missing its LAN ip today (not discovered yet) or even its key (pending a
 *  re-harvest) can still become locally capable LATER, and capturing its dp-map NOW — while
 *  cloud is briefly alive — means it needs zero cloud calls the moment it does. Sub-devices
 *  are the one permanent exclusion: they are never LAN-reachable at all, so a dp-map for one
 *  could never be used locally regardless of what else changes. Bounded concurrency; a
 *  single device's failure never aborts the run (each device's fetch already fails closed on
 *  its own — see dpMapsFor's try/catch chain — this just also catches anything dpMapsFor
 *  itself might throw, e.g. no Tuya project configured at all). */
export async function captureDpMaps(): Promise<CaptureDpMapsResult> {
  const entries = tuyaLocal.listRegistry().filter((e) => !e.sub);
  let captured = 0;
  let alreadyHad = 0;
  let failed = 0;
  const failedIds: string[] = [];

  await mapWithConcurrency(entries, LOCAL_FLEET_CONCURRENCY, async (entry) => {
    const hadBefore = tuyaLocal.getDpMap(entry.id) !== null;
    try {
      const { codeToDp } = await dpMapsFor(entry.id);
      if (codeToDp.size === 0) {
        failed++;
        failedIds.push(entry.id);
        return;
      }
      if (hadBefore) alreadyHad++;
      else captured++;
    } catch {
      failed++;
      failedIds.push(entry.id);
    }
  });

  return { total: entries.length, captured, alreadyHad, failed, failedIds };
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
  // Scene / wireless switches
  wxkg: 'Scene switches',
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
  // Scene / wireless switches (INPUT devices — buttons bind to whole-home scenes)
  wxkg: { label: 'Scene switch', icon: 'radio' },
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
