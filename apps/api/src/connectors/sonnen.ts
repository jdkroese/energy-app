import { config } from '../config';
import { cached } from '../cache';

// Sonnen local REST API v2 (reachable from the VPS over the WireGuard tunnel).
// Read endpoints are open; configuration/control endpoints need the Auth-Token.
const base = () => `http://${config.sonnen.host}/api/v2`;

async function get(path: string, auth = false): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (auth) headers['Auth-Token'] = config.sonnen.token;
  const res = await fetch(`${base()}${path}`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Sonnen ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** Live snapshot: SoC, power flows, production/consumption, grid feed-in. */
export function getStatus(): Promise<unknown> {
  return cached('sonnen.status', 10_000, () => get('/status'));
}

/** Authenticated config read: EM_OperatingMode, EM_USOC (backup reserve), etc. */
export function getConfigurations(): Promise<unknown> {
  return get('/configurations', true);
}

/** latestdata: USOC/RSOC, Pac_total_W, SetPoint_W, FullChargeCapacity, ic_status. */
export function getLatestData(): Promise<unknown> {
  return get('/latestdata');
}

/** Per-channel powermeter: kwh_imported/kwh_exported, w_total, per-phase V/A. */
export function getPowermeter(): Promise<unknown> {
  return get('/powermeter');
}

// ---- Control / write (authenticated) ------------------------------------
// All write paths require the Auth-Token. Callers MUST guardrail-check first;
// these functions are dumb transports and do no clamping themselves.

async function put(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base()}${path}`, {
    method: 'PUT',
    headers: { 'Auth-Token': config.sonnen.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Sonnen PUT ${path} -> HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

async function post(path: string): Promise<unknown> {
  const res = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { 'Auth-Token': config.sonnen.token },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Sonnen POST ${path} -> HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

/** Set EM_OperatingMode: '1' manual, '2' self-consumption, '10' time-of-use. */
export function setOperatingMode(mode: '1' | '2' | '10'): Promise<unknown> {
  return put('/configurations', { EM_OperatingMode: mode });
}

/** Set EM_USOC (backup reserve / min SoC, percent as string). */
export function setReserve(pct: number): Promise<unknown> {
  return put('/configurations', { EM_USOC: String(Math.round(pct)) });
}

/** Force charge at exact watts (manual mode only). Caller clamps 0..4600. */
export function forceCharge(watt: number): Promise<unknown> {
  return post(`/setpoint/charge/${Math.round(watt)}`);
}

/** Force discharge at exact watts (manual mode only). Caller clamps 0..4600. */
export function forceDischarge(watt: number): Promise<unknown> {
  return post(`/setpoint/discharge/${Math.round(watt)}`);
}

export interface SonnenConfigRaw {
  EM_OperatingMode?: number | string;
  EM_USOC?: number | string;
}

/** Read-back of the control-relevant config keys (mode + reserve). */
export async function readControlConfig(): Promise<{ mode: string; reservePct: number }> {
  const raw = (await getConfigurations()) as SonnenConfigRaw;
  const m = raw.EM_OperatingMode;
  const mode = m === undefined ? 'unknown' : String(m);
  const reservePct = Number(raw.EM_USOC ?? 0);
  return { mode, reservePct };
}

// ---- Normalized shape for /api/live -------------------------------------

export interface SonnenStatusRaw {
  USOC?: number; // user state of charge %
  RSOC?: number;
  Pac_total_W?: number; // +discharge / -charge (sign per device; normalized below)
  GridFeedIn_W?: number; // + exporting / - importing
  Production_W?: number;
  Consumption_W?: number;
  RemainingCapacity_Wh?: number;
  OperatingMode?: number | string;
  SystemStatus?: string; // "OnGrid" / "OffGrid"
  BatteryCharging?: boolean;
  BatteryDischarging?: boolean;
}

export interface SonnenNormalized {
  soc: number;
  kwh: number;
  kw: number;
  dir: 'charging' | 'discharging' | 'idle';
  mode?: string;
  productionW: number;
  gridFeedInW: number;
  consumptionW: number;
  online: true;
}

function modeLabel(m: number | string | undefined): string | undefined {
  if (m === undefined) return undefined;
  const n = typeof m === 'string' ? Number(m) : m;
  if (n === 1) return 'manual';
  if (n === 2) return 'self-consumption';
  if (n === 10) return 'time-of-use';
  return typeof m === 'string' ? m : undefined;
}

/** Fetch /status and normalize to the /api/live sonnen shape. */
export async function getNormalized(): Promise<SonnenNormalized> {
  const raw = (await getStatus()) as SonnenStatusRaw;
  const soc = Math.round(raw.USOC ?? raw.RSOC ?? 0);
  const remainingWh = raw.RemainingCapacity_Wh ?? 0;
  const kwh = remainingWh > 0 ? Math.round((remainingWh / 1000) * 10) / 10 : Math.round(soc * 0.092 * 10) / 10;

  // Pac_total_W: on Sonnen, negative = charging, positive = discharging.
  const pac = raw.Pac_total_W ?? 0;
  let dir: SonnenNormalized['dir'] = 'idle';
  if (raw.BatteryCharging || pac < -25) dir = 'charging';
  else if (raw.BatteryDischarging || pac > 25) dir = 'discharging';
  const kw = Math.round((Math.abs(pac) / 1000) * 100) / 100;

  return {
    soc,
    kwh,
    kw,
    dir,
    mode: modeLabel(raw.OperatingMode),
    productionW: raw.Production_W ?? 0,
    gridFeedInW: raw.GridFeedIn_W ?? 0,
    consumptionW: raw.Consumption_W ?? 0,
    online: true,
  };
}
