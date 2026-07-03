// iSolarCloud OpenAPI connector — the LAN-INDEPENDENT cloud backstop for the Sungrow
// SG5.0RS inverters (docs/44, Phase B). READ-ONLY: it only reads per-device real-time
// power + yield + device state so outage detection has a source of truth that does NOT
// die with the WiNet-S dongle or the home LAN. It NEVER issues a command and touches no
// control/armed/battery path.
//
// GATED: every entry point no-ops (returns null / []) until the integration is fully
// configured (appkey + access-key + RSA public key + account + password). Until the
// owner's OpenAPI key lands this ships disabled, so it can't affect /api/live at all.
//
// Protocol (reverse-engineered EU OpenAPI, references github.com/bugjam/pysolarcloud +
// github.com/MickMake/GoSungrow + jsanchezdelvillar/Sungrow-API):
//   • Host: gateway.isolarcloud.eu (region-configurable).
//   • Every request body is JSON, AES-128-ECB / PKCS7 encrypted with a per-request
//     random 16-char key, hex-uppercase encoded. That AES key is itself RSA-encrypted
//     (PKCS1 v1.5) with the account's OpenAPI RSA public key (X.509 DER, base64url) and
//     sent as the `x-random-secret-key` header; the response is AES-decrypted with the
//     same key. `x-access-key` carries the access key; `sys_code:901` is required.
//   • Login: POST /openapi/login { appkey, login_type:"1", user_account, user_password,
//     api_key_param:{nonce,timestamp} } → result_data.token (cached, re-minted on expiry).
//   • Data: POST /openapi/getDeviceRealTimeData { appkey, device_type:1, ps_key_list,
//     point_id_list } → result_data.device_point_list[].device_point.p83002 (Inverter AC
//     power W), p83022 (daily yield Wh). Device online/fault state is in the response
//     METADATA (dev_status / dev_fault_status), NOT a p-point. Plant/device discovery:
//     /openapi/getPowerStationList, /openapi/getDeviceList.
//
// UNVERIFIED against real credentials until the owner's key is issued — the signing +
// endpoint shapes are covered by unit tests (mock HTTP) but the live handshake is pending.

import * as crypto from 'node:crypto';
import { cached } from '../cache';
import { isolarcloudConfig, type IsolarcloudConfig } from '../runtime-config';

// ---- Normalized cloud reading (per device) ---------------------------------

export interface CloudDevice {
  /** Device serial (dev_sn) — the key we match to a local dongle. */
  serial: string;
  /** ps_key (e.g. "<sn>_11_0_0") used in the real-time-data query. */
  psKey: string;
  /** Live AC active power (W), or null when not reported. */
  acPowerW: number | null;
  /**
   * The RAW p83002 reading exactly as the cloud returned it (before any W→kW handling),
   * plus its unit string when the point was an {value, unit} object — surfaced in the Test
   * so a 1000× unit mismatch (kW vs W) is visible against real production. null when p83002
   * was absent.
   */
  rawAcPower: number | null;
  /** Unit string reported alongside p83002 (e.g. "W" or "kW"), or null when none/scalar. */
  rawAcPowerUnit: string | null;
  /** Today's yield (kWh), or null. */
  dailyKwh: number | null;
  /** Device run/fault state label, or null. */
  deviceState: string | null;
  /** True when the cloud marks the device offline/faulted (outage source of truth). */
  offline: boolean;
  /**
   * When the expected AC-power point (p83002) AND the plant-power fallback (p83033) are both
   * MISSING for this device, the actual point keys present in its device_point object
   * (sorted), so a wrong point-id set is visible in the Test detail. null when power WAS
   * reported (normal case).
   */
  pointsPresent: string[] | null;
}

export interface CloudSnapshot {
  devices: CloudDevice[];
  /** ISO timestamp of this snapshot. */
  ts: string;
}

// ---- Protocol constants ----------------------------------------------------

const SYS_CODE = '901';
const LOGIN_TYPE = '1';
// Sungrow device_type for the units we monitor. 1 = string/PV inverter (SG series, e.g.
// the owner's 2× SG5.0RS); 11 = hybrid/storage inverter (SH series). The owner's Test
// confirmed the plant's devices report device_type 1 (seen list [1,7,22]) — 11 matched
// nothing. Overridable via ISOLARCLOUD_DEVICE_TYPE so we can retune without a deploy if a
// future unit reports differently; defaults to 1.
const DEVICE_TYPE_INVERTER = ((): number => {
  const raw = process.env.ISOLARCLOUD_DEVICE_TYPE?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1;
})();
// Point ids we read (GoSungrow/Sungrow-API point map). CRITICAL: p83033 is "Plant Power"
// — a PLANT-level point, so it is NEVER returned for a DEVICE query (getDeviceRealTimeData);
// that's why an earlier build saw "no p83033" against real inverters. The correct DEVICE-level
// point is p83002 = Inverter AC Power. So:
//   • 83002 = Inverter AC Power (DEVICE-level, W or kW)   ← the intended acPowerW source
//   • 83022 = Daily yield (kWh/Wh)                        ← dailyKwh
//   • 83025 = Running state (kept as a harmless extra / metadata fallback)
//   • 83033 = Plant Power (PLANT-level — WRONG for a device query; still requested + parsed
//             as a last-resort fallback for acPowerW, but 83002 is the real source)
// Device online/fault detection comes from the response METADATA (dev_status /
// dev_fault_status), not a p-point (see parseRealTimeData). Kept small so we stay well
// under any point quota.
const POINT_ACTIVE_POWER = '83002'; // Inverter AC Power (device-level)
const POINT_PLANT_POWER = '83033'; // Plant Power (plant-level — fallback only, usually absent)
const POINT_DAILY_YIELD = '83022';
const POINT_RUN_STATE = '83025';
const POINT_ID_LIST = [POINT_ACTIVE_POWER, POINT_DAILY_YIELD, POINT_RUN_STATE, POINT_PLANT_POWER];
const HTTP_TIMEOUT_MS = 12_000;
// Cloud is the SLOW/rate-limited backstop — poll every 5 min (config TTL below).
const CLOUD_TTL_MS = 5 * 60_000;

// ---- Crypto (pure, unit-testable) ------------------------------------------

/** A random 16-char alphanumeric AES key (matches the reference client's alphabet). */
export function randomAesKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** A 32-char alphanumeric nonce for api_key_param. */
export function randomNonce(len = 32): string {
  return crypto.randomBytes(len).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, len).padEnd(len, '0');
}

/**
 * AES-128-ECB / PKCS7 encrypt `plaintext` with a 16-char key → hex-uppercase string.
 * (The OpenAPI uses the raw UTF-8 key bytes right-padded/truncated to 16.)
 */
export function aesEncrypt(plaintext: string, key: string): string {
  const keyBuf = Buffer.alloc(16, ' ');
  Buffer.from(key, 'utf8').copy(keyBuf, 0, 0, 16);
  const cipher = crypto.createCipheriv('aes-128-ecb', keyBuf, null);
  cipher.setAutoPadding(true); // PKCS7
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return enc.toString('hex').toUpperCase();
}

/** AES-128-ECB / PKCS7 decrypt a hex-uppercase body with the same 16-char key → UTF-8. */
export function aesDecrypt(hex: string, key: string): string {
  const keyBuf = Buffer.alloc(16, ' ');
  Buffer.from(key, 'utf8').copy(keyBuf, 0, 0, 16);
  const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, null);
  decipher.setAutoPadding(true);
  const dec = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * Build a crypto public key from the owner-pasted Settings field, accepting BOTH forms:
 *   • a bare base64 X.509/SPKI DER body (what the OpenAPI docs give), or
 *   • a full PEM block with `-----BEGIN PUBLIC KEY-----` armor (what a user often pastes).
 * The field is free text, so we detect PEM armor and hand the PEM straight to
 * createPublicKey (which parses armor + line wrapping natively); otherwise we base64-decode
 * the bare body as DER/SPKI. Pure; throws only on a genuinely unparseable key (the caller
 * is fail-soft). Exported for unit testing.
 */
export function publicKeyFromField(rsaPublicKey: string): crypto.KeyObject {
  const trimmed = rsaPublicKey.trim();
  if (/-----BEGIN[\w ]*PUBLIC KEY-----/.test(trimmed)) {
    // Full PEM armor present — let Node parse it directly (handles CRLF/soft-wraps).
    return crypto.createPublicKey({ key: trimmed, format: 'pem' });
  }
  // Bare base64 DER body (strip any stray whitespace/newlines before decoding).
  const der = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64');
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * RSA-encrypt the AES key with the account's OpenAPI public key (bare base64 X.509 DER
 * OR full PEM), PKCS1 v1.5 padding, → base64url. This becomes the `x-random-secret-key`
 * header.
 */
export function rsaEncryptKey(aesKey: string, rsaPublicKey: string): string {
  const keyObj = publicKeyFromField(rsaPublicKey);
  const enc = crypto.publicEncrypt(
    { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey, 'utf8'),
  );
  return enc.toString('base64url');
}

/** Build the signed headers + encrypted body for one request. Pure (crypto only). */
export function buildSignedRequest(
  cfg: Pick<IsolarcloudConfig, 'accessKey' | 'rsaPublicKey'>,
  bodyObj: Record<string, unknown>,
  token?: string,
): { headers: Record<string, string>; body: string; aesKey: string } {
  const aesKey = randomAesKey();
  const xRandom = rsaEncryptKey(aesKey, cfg.rsaPublicKey);
  const headers: Record<string, string> = {
    'User-Agent': 'EnergyApp',
    'x-access-key': cfg.accessKey,
    'x-random-secret-key': xRandom,
    'Content-Type': 'application/json',
    sys_code: SYS_CODE,
  };
  if (token) headers.token = token;
  const body = aesEncrypt(JSON.stringify(bodyObj), aesKey);
  return { headers, body, aesKey };
}

// ---- HTTP (mockable) -------------------------------------------------------

/** The fetch used for cloud calls — swappable in tests via setFetchForTest(). */
let fetchImpl: typeof fetch = fetch;
/** TEST ONLY: inject a mock fetch. Restore with setFetchForTest(fetch). */
export function setFetchForTest(f: typeof fetch): void {
  fetchImpl = f;
}

function apiKeyParam(): { nonce: string; timestamp: string } {
  return { nonce: randomNonce(), timestamp: String(Date.now()) };
}

/**
 * POST one signed+encrypted request and return the AES-decrypted JSON. Throws on a
 * transport error, a non-200, an undecryptable body, or a non-"1" result_code (the
 * caller decides how to fail-soft). Never logs the plaintext credentials.
 */
export async function signedPost(
  cfg: IsolarcloudConfig,
  path: string,
  bodyObj: Record<string, unknown>,
  token?: string,
): Promise<Record<string, unknown>> {
  const { headers, body, aesKey } = buildSignedRequest(cfg, bodyObj, token);
  const url = `https://${cfg.region}${path}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`iSolarCloud HTTP ${res.status}`);
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    // Some endpoints answer plaintext JSON on an auth/handshake error; try that first.
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = JSON.parse(aesDecrypt(text.trim(), aesKey)) as Record<string, unknown>;
  }
  const code = String(json.result_code ?? '');
  if (code !== '1') {
    throw new Error(`iSolarCloud result_code ${code || 'missing'} (${String(json.result_msg ?? 'error')})`);
  }
  return json;
}

// ---- Token (login) ---------------------------------------------------------

interface TokenState {
  token: string;
  /** Epoch ms this token was minted (we re-login well inside the server's window). */
  mintedAt: number;
}
let tokenState: TokenState | null = null;
const TOKEN_TTL_MS = 60 * 60_000; // re-login hourly (conservative)

/** TEST ONLY: reset the cached login token. */
export function resetTokenForTest(): void {
  tokenState = null;
}

async function login(cfg: IsolarcloudConfig): Promise<string> {
  const json = await signedPost(cfg, '/openapi/login', {
    api_key_param: apiKeyParam(),
    appkey: cfg.appkey,
    login_type: LOGIN_TYPE,
    user_account: cfg.account,
    user_password: cfg.password,
  });
  const data = (json.result_data ?? {}) as { token?: unknown; login_state?: unknown };
  const token = String(data.token ?? '');
  if (!token) throw new Error('iSolarCloud login returned no token');
  tokenState = { token, mintedAt: Date.now() };
  return token;
}

async function ensureToken(cfg: IsolarcloudConfig): Promise<string> {
  if (tokenState && Date.now() - tokenState.mintedAt < TOKEN_TTL_MS) return tokenState.token;
  return login(cfg);
}

// ---- Parsing (pure) --------------------------------------------------------

/**
 * Coerce a getDeviceRealTimeData point to a number. A point may arrive as a scalar
 * (number/string) OR as an object `{ value, unit }` — read `.value` in the object case.
 * Tolerant of locale strings ("--", blanks, thousands are NOT assumed). Null on anything
 * unparseable.
 */
function toNum(v: unknown): number | null {
  if (v != null && typeof v === 'object') {
    // { value, unit } point shape — recurse into value.
    return toNum((v as Record<string, unknown>).value);
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '' || t === '--') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The unit string of a `{ value, unit }` point, or null for a scalar / no unit. */
function pointUnit(v: unknown): string | null {
  if (v != null && typeof v === 'object') {
    const u = (v as Record<string, unknown>).unit;
    if (u != null && String(u).trim() !== '') return String(u).trim();
  }
  return null;
}

/**
 * Truthy iff a string/number looks like a "running / normal / online" device state.
 * Tolerant of numeric codes, English/Chinese labels, and locale casing.
 */
function looksRunning(s: string): boolean {
  return /(^|[^a-z])(run|running|online|normal|ok)([^a-z]|$)|正常|运行|在线|^1$/i.test(s.trim());
}

/** Truthy iff a fault-status field indicates an actual fault (non-zero / "fault"/"alarm"). */
function looksFaulted(s: string): boolean {
  const t = s.trim();
  if (t === '' || t === '0' || t === '--') return false;
  if (/^0+$/.test(t)) return false; // "00", "0.0" style zeros = no fault
  if (/no\s*fault|normal|正常|无故障/i.test(t)) return false;
  const n = Number(t);
  if (Number.isFinite(n)) return n > 0; // any non-zero fault code = faulted
  return /fault|alarm|error|故障|告警/i.test(t); // textual fault labels
}

/**
 * Parse a getDeviceRealTimeData response into normalized per-device readings. Pure +
 * side-effect-free (unit-tested). Tolerant to missing points and to points arriving as a
 * scalar OR an `{ value, unit }` object. Power is read from p83002 (Inverter AC Power,
 * DEVICE-level) with p83033 (Plant Power) as a last-resort fallback; daily yield (p83022)
 * is normalized to kWh.
 *
 * OFFLINE/RUNNING detection is derived PRIMARILY from the response METADATA — dev_status
 * and dev_fault_status ARE present for a device query (unlike a run-state p-point), so a
 * fault there ⇒ offline and a running dev_status ⇒ online. We fall back to the old
 * p83025/power heuristic only when neither metadata field is present, so the cloud stays a
 * trustworthy outage source.
 */
export function parseRealTimeData(json: Record<string, unknown>): CloudDevice[] {
  const data = (json.result_data ?? {}) as { device_point_list?: unknown };
  const list = Array.isArray(data.device_point_list) ? data.device_point_list : [];
  const out: CloudDevice[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const point = (rec.device_point ?? {}) as Record<string, unknown>;
    // Metadata (dev_status / dev_fault_status / dev_sn …) may sit on the entry OR inside
    // device_point depending on the endpoint shape — look in both (device_point wins).
    const meta = (k: string): unknown => (k in point ? point[k] : rec[k]);
    const serial = String(meta('dev_sn') ?? meta('device_sn') ?? rec.ps_key ?? '').trim();
    const psKey = String(rec.ps_key ?? point.ps_key ?? '').trim();

    // Power: p83002 (device-level Inverter AC Power) first; p83033 (plant-level) fallback.
    const p83002 = point[`p${POINT_ACTIVE_POWER}`];
    const p83033 = point[`p${POINT_PLANT_POWER}`];
    const rawAcPower = toNum(p83002);
    const acPowerW = rawAcPower != null ? rawAcPower : toNum(p83033);
    const rawAcPowerUnit = pointUnit(p83002) ?? pointUnit(p83033);
    const dailyWh = toNum(point[`p${POINT_DAILY_YIELD}`]);

    // Run/fault state — prefer metadata, fall back to the p83025 run-state point.
    const devStatus = meta('dev_status');
    const devFault = meta('dev_fault_status');
    const runState = point[`p${POINT_RUN_STATE}`];
    const statusStr = devStatus == null ? null : String(devStatus);
    const faultStr = devFault == null ? null : String(devFault);
    const runStateStr = runState == null ? null : String(runState);
    // Human-readable state label for the Test: metadata status when present, else run-state.
    const stateStr = statusStr ?? runStateStr;

    let offline: boolean;
    if (statusStr != null || faultStr != null) {
      // Metadata path (authoritative): a real fault ⇒ offline; else honour dev_status.
      const faulted = faultStr != null && looksFaulted(faultStr);
      const running = statusStr != null ? looksRunning(statusStr) : true;
      offline = faulted || !running;
    } else {
      // Legacy heuristic (no metadata): no live power AND not running by p83025.
      const running = runStateStr != null && looksRunning(runStateStr);
      offline = (acPowerW == null || acPowerW <= 0) && !running;
    }

    // Safety net: if BOTH the device-level (p83002) and plant-level (p83033) power keys are
    // absent for this device, capture the keys that ARE present so a wrong point-id set is
    // diagnosable in ONE Test. Only when both keys are missing — a present-but-null/"--"
    // reading is a real zero, not a point-id mismatch.
    const powerKeyPresent = `p${POINT_ACTIVE_POWER}` in point || `p${POINT_PLANT_POWER}` in point;
    const pointsPresent = powerKeyPresent ? null : Object.keys(point).sort();
    out.push({
      serial,
      psKey,
      acPowerW,
      rawAcPower,
      rawAcPowerUnit,
      dailyKwh: dailyWh == null ? null : dailyWh / 1000,
      deviceState: stateStr,
      offline,
      pointsPresent,
    });
  }
  return out;
}

// ---- Public API (gated + cached + fail-soft) -------------------------------

/** True when the cloud backstop is fully configured (credentials present). */
export function isConfigured(): boolean {
  return isolarcloudConfig() !== null;
}

/** Raw topology walk result — the counts diagnose() surfaces to tell propagation from a filter bug. */
export interface DiscoveryDetail {
  /** ps_key candidates derived (inverter devices only). */
  psKeys: string[];
  /** Number of plants getPowerStationList returned. */
  plantCount: number;
  /** ps_id/ps_name pairs seen, for the human detail. */
  plants: { psId: unknown; psName: string | null }[];
  /** Total devices seen across all plants (getDeviceList). */
  deviceCount: number;
  /** DISTINCT device_type values seen across all plants (sorted). */
  deviceTypes: number[];
  /** True when the owner's serialMap short-circuited discovery (no plant/device walk ran). */
  fromSerialMap: boolean;
}

/**
 * Discover the ps_key_list to query PLUS the raw topology counts — the un-cached body.
 * Prefers the owner's serial→dongle map keys (the ps_key is derived as "<serial>_11_0_0"
 * when only serials are mapped); else walks the plant + device lists. Kept cache-free so
 * the manual Test button (diagnose) can hit the live topology endpoints directly and see
 * the raw counts; the hot path wraps discoverPsKeys() below.
 */
async function discoverTopology(cfg: IsolarcloudConfig, token: string): Promise<DiscoveryDetail> {
  // If the owner mapped serials explicitly, derive the standard inverter ps_key.
  const mapped = cfg.serialMap ? Object.keys(cfg.serialMap) : [];
  if (mapped.length > 0) {
    return {
      psKeys: mapped.map((sn) => `${sn}_${DEVICE_TYPE_INVERTER}_0_0`),
      plantCount: 0,
      plants: [],
      deviceCount: 0,
      deviceTypes: [],
      fromSerialMap: true,
    };
  }
  // Otherwise discover: plant list → device list per plant → inverter ps_keys.
  const plants = await signedPost(cfg, '/openapi/getPowerStationList', {
    api_key_param: apiKeyParam(),
    appkey: cfg.appkey,
    curPage: 1,
    size: 100,
  }, token);
  const pdata = (plants.result_data ?? {}) as { pageList?: unknown };
  const plantList = Array.isArray(pdata.pageList) ? pdata.pageList : [];
  const psKeys: string[] = [];
  const plantsSeen: { psId: unknown; psName: string | null }[] = [];
  const deviceTypeSet = new Set<number>();
  let deviceCount = 0;
  for (const p of plantList) {
    const prec = (p ?? {}) as Record<string, unknown>;
    const psId = prec.ps_id;
    const psName = prec.ps_name != null ? String(prec.ps_name).trim() : null;
    plantsSeen.push({ psId, psName: psName || null });
    if (psId == null) continue;
    const devs = await signedPost(cfg, '/openapi/getDeviceList', {
      api_key_param: apiKeyParam(),
      appkey: cfg.appkey,
      ps_id: psId,
      curPage: 1,
      size: 100,
    }, token);
    const ddata = (devs.result_data ?? {}) as { pageList?: unknown };
    const devList = Array.isArray(ddata.pageList) ? ddata.pageList : [];
    for (const d of devList) {
      const rec = d as Record<string, unknown>;
      deviceCount += 1;
      const dt = Number(rec.device_type);
      if (Number.isFinite(dt)) deviceTypeSet.add(dt);
      if (dt !== DEVICE_TYPE_INVERTER) continue;
      const psKey = String(rec.ps_key ?? '').trim();
      if (psKey) psKeys.push(psKey);
    }
  }
  return {
    psKeys,
    plantCount: plantList.length,
    plants: plantsSeen,
    deviceCount,
    deviceTypes: [...deviceTypeSet].sort((a, b) => a - b),
    fromSerialMap: false,
  };
}

/** ps_key discovery for the hot path — just the keys (topology counts are diagnose-only). */
async function discoverPsKeysUncached(cfg: IsolarcloudConfig, token: string): Promise<string[]> {
  return (await discoverTopology(cfg, token)).psKeys;
}

// A NON-empty discovery is stable topology → cache 30 min. An EMPTY result is NEVER cached:
// right after the owner authorizes the plant, Sungrow needs a few minutes to propagate, and
// a stale-empty cache would wedge us on "no inverters found" for half an hour. Leaving empty
// uncached means each 5-min snapshot poll re-discovers, so the plant is picked up on the very
// next poll once it propagates. Concurrent callers are still coalesced.
const PSKEYS_TTL_FULL_MS = 30 * 60_000;
let pskeysCache: { at: number; keys: string[] } | null = null;
let pskeysInflight: Promise<string[]> | null = null;

/** TEST ONLY: clear the ps_keys discovery cache. */
export function resetPsKeysCacheForTest(): void {
  pskeysCache = null;
  pskeysInflight = null;
}

/**
 * Discover the ps_key_list to query, cached longer than the data poll (topology rarely
 * changes) — BUT an EMPTY result is never cached (see note above), so a freshly-authorized
 * plant is picked up on the next poll instead of being stuck stale for 30 min. Coalesces
 * concurrent callers. We manage the cache inline (rather than via `cached()`) because empty
 * results must be skipped.
 */
export async function discoverPsKeys(cfg: IsolarcloudConfig, token: string): Promise<string[]> {
  if (pskeysCache && Date.now() - pskeysCache.at < PSKEYS_TTL_FULL_MS) return pskeysCache.keys;
  if (pskeysInflight) return pskeysInflight;
  pskeysInflight = discoverPsKeysUncached(cfg, token)
    .then((keys) => {
      // Only cache a NON-empty topology; an empty list re-probes on the next call.
      if (keys.length > 0) pskeysCache = { at: Date.now(), keys };
      return keys;
    })
    .finally(() => {
      pskeysInflight = null;
    });
  return pskeysInflight;
}

/**
 * Read the cloud snapshot (per-device live power + yield + offline flag), or null when
 * the integration is unconfigured / the read fails. Cached ~5 min (rate-limit-friendly)
 * + coalesced. Fail-soft: any error → null so it can NEVER break /api/live.
 */
export function getCloudSnapshot(): Promise<CloudSnapshot | null> {
  const cfg = isolarcloudConfig();
  if (!cfg) return Promise.resolve(null); // gated — disabled until configured
  return cached('isolarcloud.snapshot', CLOUD_TTL_MS, async () => {
    try {
      const token = await ensureToken(cfg);
      const psKeys = await discoverPsKeys(cfg, token);
      if (psKeys.length === 0) return null;
      const json = await signedPost(cfg, '/openapi/getDeviceRealTimeData', {
        api_key_param: apiKeyParam(),
        appkey: cfg.appkey,
        device_type: DEVICE_TYPE_INVERTER,
        point_id_list: POINT_ID_LIST,
        ps_key_list: psKeys,
      }, token);
      return { devices: parseRealTimeData(json), ts: new Date().toISOString() };
    } catch (e) {
      // On an auth error the token may have expired — drop it so the next poll re-logs in.
      tokenState = null;
      console.error('[isolarcloud] snapshot failed:', (e as Error).message);
      return null;
    }
  });
}

/**
 * Probe the cloud integration WITHOUT persisting anything — used by the SAVE gate. Only
 * proves login (a valid credential set can be saved even before the service APIs are
 * whitelisted). Returns a short human detail. Never throws.
 */
export async function probe(cfg: IsolarcloudConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const token = await login(cfg);
    return { ok: Boolean(token), detail: token ? 'authenticated · token issued' : 'no token returned' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message?.slice(0, 80) || 'unreachable' };
  }
}

/** Trim a raw error/result message for display in the Test detail (single-line, capped). */
function trimDetail(msg: string, max = 200): string {
  const one = msg.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Render the discovered plants as a compact " (Javea, Barn)" suffix (names when present,
 * else ps_id), or '' when none/unknown — used inside the diagnose detail strings.
 */
function describePlants(topo: DiscoveryDetail): string {
  const names = topo.plants
    .map((p) => (p.psName ? p.psName : p.psId != null ? String(p.psId) : ''))
    .filter((s) => s.length > 0);
  return names.length > 0 ? ` (${names.join(', ')})` : '';
}

/**
 * FULL read-chain diagnostic — used by the Settings "Test" button. Unlike probe() (login
 * only), this runs the ENTIRE data path the hot snapshot uses (login → discover ps_keys →
 * getDeviceRealTimeData) and reports EXACTLY where it stops, so a permission/whitelist gap
 * is visible instead of hidden behind a green "login OK". Bypasses the 5-min snapshot cache
 * (fresh login + un-cached discovery) since it's a manual button. Strictly read-only and
 * fail-soft: it NEVER throws.
 */
export async function diagnose(
  cfg: IsolarcloudConfig,
): Promise<{ ok: boolean; detail: string; devices?: CloudDevice[] }> {
  // 1) Login.
  let token: string;
  try {
    token = await login(cfg);
    if (!token) return { ok: false, detail: 'login failed — no token returned' };
  } catch (e) {
    return { ok: false, detail: `login failed — ${trimDetail((e as Error).message || 'unreachable')}` };
  }

  // 2) Discover inverter ps_keys (getPowerStationList → getDeviceList), un-cached, and
  //    capture the RAW topology counts so we can tell propagation from a filter bug.
  let topo: DiscoveryDetail;
  try {
    topo = await discoverTopology(cfg, token);
  } catch (e) {
    tokenState = null;
    return {
      ok: false,
      detail:
        `login OK, but device discovery failed — ${trimDetail((e as Error).message || 'error')}. ` +
        'Enable getPowerStationList/getDeviceList in Service API management and set the app to ' +
        'direct account authorization (OAuth2.0 = No), or authorize the plant.',
    };
  }
  const psKeys = topo.psKeys;
  // Log the raw discovery to the mini logs regardless of outcome (server-side visibility).
  console.error(
    `[isolarcloud] discovery: ${
      topo.fromSerialMap
        ? `serialMap → ${psKeys.length} ps_key(s)`
        : `${topo.plantCount} plant(s) ${JSON.stringify(topo.plants)} · ${topo.deviceCount} device(s) · ` +
          `device_types [${topo.deviceTypes.join(',')}] · ${psKeys.length} inverter ps_key(s)`
    }`,
  );

  if (psKeys.length === 0) {
    // Three distinct empty cases — surface WHICH so propagation ≠ filter bug ≠ genuinely empty.
    if (!topo.fromSerialMap && topo.plantCount === 0) {
      return {
        ok: false,
        detail:
          'login OK · getPowerStationList returned 0 plants (Sungrow may still be propagating the ' +
          'authorization — retry in a few min). If it persists, enable getPowerStationList/getDeviceList ' +
          'in Service API management and set OAuth2.0 = No, or authorize the plant',
      };
    }
    if (!topo.fromSerialMap && topo.deviceCount > 0) {
      const plantLabel = describePlants(topo);
      return {
        ok: false,
        detail:
          `login OK · ${topo.plantCount} plant${topo.plantCount === 1 ? '' : 's'}${plantLabel} · ` +
          `${topo.deviceCount} device${topo.deviceCount === 1 ? '' : 's'} but 0 are inverters ` +
          `(device_types seen: [${topo.deviceTypes.join(',')}]) — device_type filter may need adjusting ` +
          `(expected ${DEVICE_TYPE_INVERTER})`,
      };
    }
    // Plants exist but have no devices at all (or serialMap derived nothing).
    const plantLabel = describePlants(topo);
    return {
      ok: false,
      detail:
        `login OK · ${topo.plantCount} plant${topo.plantCount === 1 ? '' : 's'}${plantLabel} · ` +
        '0 devices — getDeviceList returned nothing (Sungrow may still be propagating, or ' +
        'getDeviceList is not enabled for this app)',
    };
  }

  // 3) Read live per-device data.
  let devices: CloudDevice[];
  try {
    const json = await signedPost(cfg, '/openapi/getDeviceRealTimeData', {
      api_key_param: apiKeyParam(),
      appkey: cfg.appkey,
      device_type: DEVICE_TYPE_INVERTER,
      point_id_list: POINT_ID_LIST,
      ps_key_list: psKeys,
    }, token);
    devices = parseRealTimeData(json);
  } catch (e) {
    tokenState = null;
    return {
      ok: false,
      detail: `login + ${psKeys.length} device(s) found, but real-time read failed — ${trimDetail(
        (e as Error).message || 'error',
      )}`,
    };
  }
  if (devices.length === 0) {
    return {
      ok: false,
      detail: `login OK, ${psKeys.length} inverter ps_key(s) discovered, but the real-time query returned no device data — check point-id/service permissions`,
    };
  }

  // Success — per-device serial + kW + offline flag so real numbers are visible, plus the
  // raw discovery counts (plants / devices / device_types) so the topology is legible.
  const parts = devices.map((d) => {
    const id = d.serial || d.psKey || '?';
    // If BOTH power points were MISSING, the point ids likely differ for this device_type —
    // show the keys actually present so the right ids are visible in ONE Test.
    if (d.pointsPresent) {
      const present = d.pointsPresent.length ? d.pointsPresent.join(',') : 'none';
      return `${id}: no p${POINT_ACTIVE_POWER}/p${POINT_PLANT_POWER} — points present: ${present}`;
    }
    const kw = d.acPowerW == null ? '—' : `${(d.acPowerW / 1000).toFixed(2)}kW`;
    // Surface the RAW p83002 value (+ unit if the point was an object) so a 1000× unit
    // mismatch (kW returned where we assume W) is visible against real production.
    const raw =
      d.rawAcPower == null ? '' : ` [raw p${POINT_ACTIVE_POWER}=${d.rawAcPower}${d.rawAcPowerUnit ? d.rawAcPowerUnit : ''}]`;
    const state = d.deviceState ? ` ${d.deviceState}` : '';
    return `${id} ${kw}${raw}${d.offline ? ' (offline)' : ''}${state}`;
  });
  const topoLabel = topo.fromSerialMap
    ? 'serialMap'
    : `${topo.plantCount} plant${topo.plantCount === 1 ? '' : 's'}${describePlants(topo)} · ` +
      `${topo.deviceCount} device${topo.deviceCount === 1 ? '' : 's'} · device_types [${topo.deviceTypes.join(',')}]`;
  return {
    ok: true,
    detail:
      `login OK · ${topoLabel} · ${devices.length} inverter${devices.length === 1 ? '' : 's'} · ${parts.join(', ')}`,
    devices,
  };
}
