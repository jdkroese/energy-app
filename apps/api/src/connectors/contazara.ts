// Contazara CZ3000 NB-IoT water-meter connector (AMJASA telelectura network, docs/51).
// Unofficial, reverse-engineered API captured 2026-08-30 (mitmproxy, no cert pinning,
// capture files destroyed). Base https://api.contazara.es/api/2019-06-01/, Keycloak
// password-grant auth (public client, no secret, no CAPTCHA).
//
// GATED: every entry point no-ops (returns null / []) until the integration is fully
// configured (email + password + meter serial). Until the owner enters credentials in
// Settings this ships disabled, so it can never affect the armed control loop.
//
// FAIL-SOFT IS THE WHOLE POINT: this process also runs the ARMED battery/irrigation
// control loop. Every public function here returns null/[]/{ok:false} on error and
// NEVER throws into that loop (mirrors the header contract of isolarcloud.ts and
// db/sqlite.ts).
//
// Cadence: the meter is hourly-READ, ~daily-UPLOAD — this is NOT a live feed. For a
// several-hourly poll we simply re-do the password grant each time rather than bother
// with the refresh_token dance (access ~10min / refresh ~30min per the captured
// response, both far shorter than our poll interval).
//
// All volumes returned by the API are LITRES. `indexVol` is the lifetime running total.

import { cached } from '../cache';
import { contazaraConfig, type ContazaraConfig } from '../runtime-config';

const TOKEN_URL = 'https://api.contazara.es/auth/realms/cz-iot-platform/protocol/openid-connect/token';
const API_BASE = 'https://api.contazara.es/api/2019-06-01';
const CLIENT_ID = 'service-iot-api';
const HTTP_TIMEOUT_MS = 12_000;
// Cadence is hourly-read/daily-upload (docs/51) — poll gently. The actual poll interval
// is owner-configurable (ContazaraConfig.pollHours); this TTL just bounds the in-process
// snapshot cache between callers within one poll window.
const SNAPSHOT_TTL_MS = 30 * 60_000;

// ---- HTTP (mockable) --------------------------------------------------------

let fetchImpl: typeof fetch = fetch;
/** TEST ONLY: inject a mock fetch. Restore with setFetchForTest(fetch). */
export function setFetchForTest(f: typeof fetch): void {
  fetchImpl = f;
}

// ---- Madrid local-time helpers (self-contained; mirrors routes/history.ts) --------
// The meter's own timestamps ("YYYYMMDDHHmmss") are Madrid WALL-CLOCK, not UTC — we
// need a correct local→UTC-epoch conversion (DST-safe) to align them to our hourly
// bucket_ts (unix seconds).

function madridOffsetMin(d: Date): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUTC - d.getTime()) / 60000);
}

/** The epoch SECONDS whose Madrid wall-clock equals the given Y-M-D H:Mi:S. */
export function madridLocalToEpochSec(y: number, m: number, d: number, H: number, Mi: number, S: number): number {
  let guess = Date.UTC(y, m - 1, d, H, Mi, S, 0);
  for (let i = 0; i < 2; i++) {
    const off = madridOffsetMin(new Date(guess));
    guess = Date.UTC(y, m - 1, d, H, Mi, S, 0) - off * 60000;
  }
  return Math.floor(guess / 1000);
}

/** Madrid-local calendar day key (YYYY-MM-DD) for a Date. */
export function madridDayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** "YYYYMMDD" (no separators) for a Date — the query-param format every endpoint wants. */
export function yyyymmdd(d: Date): string {
  return madridDayKey(d).replace(/-/g, '');
}

/**
 * Parse the meter's own "YYYYMMDDHHmmss" Madrid wall-clock string into an epoch-second
 * bucket + local hour-of-day + day key. Pure. Returns null on an unparseable string
 * (fail-soft — the caller skips the point rather than throwing).
 */
export function parseMeterTimestamp(s: unknown): { epochSec: number; hour: number; dayKey: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const H = Number(m[4]);
  const Mi = Number(m[5]);
  const S = Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || H > 23 || Mi > 59 || S > 59) return null;
  return {
    epochSec: madridLocalToEpochSec(y, mo, d, H, Mi, S),
    hour: H,
    dayKey: `${m[1]}-${m[2]}-${m[3]}`,
  };
}

// ---- Token (password grant) --------------------------------------------------

interface TokenState {
  accessToken: string;
  refreshToken: string;
  mintedAt: number;
  expiresInMs: number;
}
let tokenState: TokenState | null = null;

/** TEST ONLY: reset the cached login token. */
export function resetTokenForTest(): void {
  tokenState = null;
}

async function login(cfg: ContazaraConfig): Promise<TokenState> {
  const body = new URLSearchParams({
    username: cfg.email,
    password: cfg.password,
    grant_type: 'password',
    client_id: CLIENT_ID,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Contazara token grant -> HTTP ${res.status}`);
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new Error('Contazara token grant returned no access_token');
  const state: TokenState = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? '',
    mintedAt: Date.now(),
    // Captured response: expires_in ≈ 599s. Default to that when absent.
    expiresInMs: (json.expires_in ?? 599) * 1000,
  };
  tokenState = state;
  return state;
}

/** Mint (or reuse) an access token, well inside its expiry window. */
async function ensureToken(cfg: ContazaraConfig): Promise<string> {
  if (tokenState && Date.now() - tokenState.mintedAt < tokenState.expiresInMs - 30_000) {
    return tokenState.accessToken;
  }
  const s = await login(cfg);
  return s.accessToken;
}

// ---- Generic authenticated GET ------------------------------------------------

async function apiGet(token: string, path: string): Promise<unknown> {
  const res = await fetchImpl(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Contazara ${path} -> HTTP ${res.status}`);
  return res.json();
}

// ---- Parsing (pure) ------------------------------------------------------------

export interface SubscriberMeter {
  idCustomer: unknown;
  customerName: string | null;
  idSubscriber: unknown;
  serialNumber: string;
  address: string | null;
  indexVol: number | null;
  lastReading: string | null; // raw "YYYYMMDDHHmmss"
  model: string | null;
}

export interface SubscriberInfo {
  userName: string | null;
  userEmail: string | null;
  notificationsConfig: {
    pushEnabled?: boolean;
    lang?: string;
    monthlyConsumption?: number;
    nightlyConsumption?: number;
  } | null;
  meters: SubscriberMeter[];
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Parse GET /subscribers/info. Pure; returns null on an unrecognisable shape. */
export function parseSubscriberInfo(json: unknown): SubscriberInfo | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  const rawMeters = Array.isArray(r.subscriberMeters) ? r.subscriberMeters : [];
  const meters: SubscriberMeter[] = rawMeters
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map((m) => ({
      idCustomer: m.idCustomer,
      customerName: m.customerName != null ? String(m.customerName) : null,
      idSubscriber: m.idSubscriber,
      serialNumber: String(m.serialNumber ?? '').trim(),
      address: m.address != null ? String(m.address) : null,
      indexVol: num(m.indexVol),
      lastReading: m.lastReading != null ? String(m.lastReading) : null,
      model: m.model != null ? String(m.model) : null,
    }))
    .filter((m) => m.serialNumber.length > 0);
  const nc = r.notificationsConfig;
  return {
    userName: r.userName != null ? String(r.userName) : null,
    userEmail: r.userEmail != null ? String(r.userEmail) : null,
    notificationsConfig:
      nc && typeof nc === 'object'
        ? {
            pushEnabled: Boolean((nc as Record<string, unknown>).pushEnabled),
            lang: (nc as Record<string, unknown>).lang != null ? String((nc as Record<string, unknown>).lang) : undefined,
            monthlyConsumption: num((nc as Record<string, unknown>).monthlyConsumption) ?? undefined,
            nightlyConsumption: num((nc as Record<string, unknown>).nightlyConsumption) ?? undefined,
          }
        : null,
    meters,
  };
}

export interface DailyPoint {
  day: string; // YYYY-MM-DD (Madrid)
  litres: number;
  indexVol: number | null;
}

/** Parse consumption/daily (`cmd` field) or accumulatedDaily (`volume` field). Pure. */
export function parseDaily(json: unknown, volumeKey: 'cmd' | 'volume' = 'cmd'): DailyPoint[] {
  const arr = Array.isArray(json) ? json : [];
  const out: DailyPoint[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const dateStr = String(r.readDate ?? '').trim();
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(dateStr);
    if (!m) continue;
    const litres = num(r[volumeKey]);
    if (litres === null) continue;
    out.push({ day: `${m[1]}-${m[2]}-${m[3]}`, litres, indexVol: num(r.indexVol) });
  }
  return out;
}

export interface HourlyPoint {
  epochSec: number; // bucket start, unix seconds
  hour: number; // Madrid local hour-of-day (0..23) from the raw string
  litres: number;
  indexVol: number | null;
}

/** Parse consumption/hourly (`cmh` litres/hour). Pure; drops any unparseable point. */
export function parseHourly(json: unknown): HourlyPoint[] {
  const arr = Array.isArray(json) ? json : [];
  const out: HourlyPoint[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const ts = parseMeterTimestamp(r.readDateTime);
    if (!ts) continue;
    const litres = num(r.cmh);
    if (litres === null) continue;
    out.push({ epochSec: ts.epochSec, hour: ts.hour, litres, indexVol: num(r.indexVol) });
  }
  return out.sort((a, b) => a.epochSec - b.epochSec);
}

/** Litres drawn in the 00:00–05:59 Madrid night slot from a day's hourly points
 *  (VERIFIED alignment with the timeslot endpoint's "night" value, docs/51). */
export function nightLitresFromHourly(hours: HourlyPoint[]): number {
  return hours.filter((h) => h.hour >= 0 && h.hour <= 5).reduce((s, h) => s + h.litres, 0);
}

export interface TimeslotPoint {
  day: string;
  morning: number;
  afternoon: number;
  evening: number;
  night: number;
}

/** Parse consumption/timeslot: `{morning:[...], afternoon:[...], evening:[...], night:[...]}`,
 *  each an array of `{readDate, volume}`. Pure — merges the four arrays by day. */
export function parseTimeslot(json: unknown): TimeslotPoint[] {
  if (!json || typeof json !== 'object') return [];
  const r = json as Record<string, unknown>;
  const byDay = new Map<string, TimeslotPoint>();
  const parts: Array<[keyof Omit<TimeslotPoint, 'day'>, unknown]> = [
    ['morning', r.morning],
    ['afternoon', r.afternoon],
    ['evening', r.evening],
    ['night', r.night],
  ];
  for (const [part, raw] of parts) {
    const arr = Array.isArray(raw) ? raw : [];
    for (const p of arr) {
      if (!p || typeof p !== 'object') continue;
      const pr = p as Record<string, unknown>;
      const dateStr = String(pr.readDate ?? '').trim();
      const m = /^(\d{4})(\d{2})(\d{2})/.exec(dateStr);
      if (!m) continue;
      const day = `${m[1]}-${m[2]}-${m[3]}`;
      const vol = num(pr.volume) ?? 0;
      const entry = byDay.get(day) ?? { day, morning: 0, afternoon: 0, evening: 0, night: 0 };
      entry[part] = vol;
      byDay.set(day, entry);
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ---- Fetchers (each mints/reuses a token) --------------------------------------

export async function fetchSubscriberInfo(cfg: ContazaraConfig, token: string): Promise<SubscriberInfo | null> {
  return parseSubscriberInfo(await apiGet(token, '/subscribers/info'));
}

export async function fetchDaily(
  cfg: ContazaraConfig,
  token: string,
  serial: string,
  fromDateYYYYMMDD: string,
  toDateYYYYMMDD: string,
): Promise<DailyPoint[]> {
  const json = await apiGet(
    token,
    `/subscribers/meters/${encodeURIComponent(serial)}/consumption/daily?fromDate=${fromDateYYYYMMDD}&toDate=${toDateYYYYMMDD}`,
  );
  return parseDaily(json, 'cmd');
}

export async function fetchAccumulatedDaily(
  cfg: ContazaraConfig,
  token: string,
  serial: string,
  fromDateYYYYMMDD: string,
  toDateYYYYMMDD: string,
): Promise<DailyPoint[]> {
  const json = await apiGet(
    token,
    `/subscribers/meters/${encodeURIComponent(serial)}/consumption/accumulatedDaily?fromDate=${fromDateYYYYMMDD}&toDate=${toDateYYYYMMDD}`,
  );
  return parseDaily(json, 'volume');
}

export async function fetchHourly(
  cfg: ContazaraConfig,
  token: string,
  serial: string,
  dateYYYYMMDD: string,
): Promise<HourlyPoint[]> {
  const json = await apiGet(token, `/subscribers/meters/${encodeURIComponent(serial)}/consumption/hourly?date=${dateYYYYMMDD}`);
  return parseHourly(json);
}

export async function fetchTimeslot(
  cfg: ContazaraConfig,
  token: string,
  serial: string,
  fromDateYYYYMMDD: string,
  toDateYYYYMMDD: string,
): Promise<TimeslotPoint[]> {
  const json = await apiGet(
    token,
    `/subscribers/meters/${encodeURIComponent(serial)}/consumption/timeslot?fromDate=${fromDateYYYYMMDD}&toDate=${toDateYYYYMMDD}`,
  );
  return parseTimeslot(json);
}

/** Mint (or reuse) a token for an external orchestrator (water-history backfill/poll)
 *  that needs to make several fetches without re-logging in for each. Throws on failure
 *  (the caller is responsible for fail-soft handling — mirrors isolarcloud's login()). */
export async function getToken(cfg: ContazaraConfig): Promise<string> {
  return ensureToken(cfg);
}

// ---- Public API (gated + cached + fail-soft) -----------------------------------

/** True when the connector is fully configured (email + password + serial present). */
export function isConfigured(): boolean {
  return contazaraConfig() !== null;
}

export interface WaterSnapshot {
  meter: SubscriberMeter | null;
  hoursToday: HourlyPoint[];
  ts: string;
}

/** Pick the configured serial's meter, falling back to the first meter returned. */
function pickMeter(info: SubscriberInfo | null, serial: string): SubscriberMeter | null {
  if (!info || info.meters.length === 0) return null;
  return info.meters.find((m) => m.serialNumber === serial) ?? info.meters[0];
}

/**
 * Read the cached snapshot (meter info + today's hourly points), or null when
 * unconfigured / the read fails. Fail-soft: any error → null, never throws.
 */
export function getSnapshot(): Promise<WaterSnapshot | null> {
  const cfg = contazaraConfig();
  if (!cfg) return Promise.resolve(null);
  return cached('contazara.snapshot', SNAPSHOT_TTL_MS, async () => {
    try {
      const token = await ensureToken(cfg);
      const info = await fetchSubscriberInfo(cfg, token);
      const meter = pickMeter(info, cfg.serial);
      if (!meter) return null;
      const hoursToday = await fetchHourly(cfg, token, meter.serialNumber, yyyymmdd(new Date()));
      return { meter, hoursToday, ts: new Date().toISOString() };
    } catch (e) {
      tokenState = null; // auth may have expired — force a re-login next poll
      console.error('[contazara] snapshot failed:', (e as Error).message);
      return null;
    }
  });
}

/** Cheap probe (login only) — used by the SAVE gate. Never throws. */
export async function probe(cfg: ContazaraConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const t = await login(cfg);
    return { ok: Boolean(t.accessToken), detail: t.accessToken ? 'authenticated · token issued' : 'no token returned' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message?.slice(0, 120) || 'unreachable' };
  }
}

function trimDetail(msg: string, max = 200): string {
  const one = msg.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * FULL read-chain diagnostic (login → subscribers/info → today's hourly) — used by the
 * Settings "Test" button. Never throws.
 */
export async function diagnose(
  cfg: ContazaraConfig,
): Promise<{ ok: boolean; detail: string; meter?: SubscriberMeter }> {
  let token: string;
  try {
    token = (await login(cfg)).accessToken;
  } catch (e) {
    return { ok: false, detail: `login failed — ${trimDetail((e as Error).message || 'unreachable')}` };
  }
  try {
    const info = await fetchSubscriberInfo(cfg, token);
    if (!info || info.meters.length === 0) {
      return { ok: false, detail: 'login OK · subscribers/info returned no meters' };
    }
    const meter = pickMeter(info, cfg.serial);
    if (!meter) return { ok: false, detail: 'login OK · no meter matched the configured serial' };
    const hours = await fetchHourly(cfg, token, meter.serialNumber, yyyymmdd(new Date()));
    const detail =
      `login OK · meter ${meter.serialNumber}${meter.address ? ` (${meter.address})` : ''} · ` +
      `index ${meter.indexVol ?? '—'} L · ${hours.length} hourly point(s) today`;
    return { ok: true, detail, meter };
  } catch (e) {
    tokenState = null;
    return { ok: false, detail: `login OK, but read failed — ${trimDetail((e as Error).message || 'error')}` };
  }
}
