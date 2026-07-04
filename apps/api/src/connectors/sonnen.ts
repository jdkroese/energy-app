import { cached } from '../cache';
import { config } from '../config';
import { sonnenHost, sonnenToken } from '../runtime-config';

// Sonnen local REST API v2 (reachable from the VPS over the WireGuard tunnel).
// Read endpoints are open; configuration/control endpoints need the Auth-Token.
// Host + token are runtime-overridable (Settings → Connections); env is the fallback.
const base = () => `http://${sonnenHost()}/api/v2`;

async function get(path: string, auth = false): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (auth) headers['Auth-Token'] = sonnenToken();
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
    headers: { 'Auth-Token': sonnenToken(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Sonnen PUT ${path} -> HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

async function post(path: string): Promise<unknown> {
  const res = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { 'Auth-Token': sonnenToken() },
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
  Uac?: number; // inverter AC terminal voltage (V) — governs the over-voltage trip
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
  /** Inverter AC terminal voltage (V, rounded). 0 when the device omits it. Runs
   *  higher than the breaker meter and governs the over-voltage protection trip. */
  uacV: number;
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

// ---- Read-only fault/health status (rule-sonnen-fault; monitoring only) ------
// The sonnenBatterie eco firmware exposes a rich health/error bitfield under
// `ic_status` in /api/v2/latestdata, plus a coarse `SystemStatus` (OnGrid/OffGrid) in
// /status. `ic_status` is a nested object whose exact keys vary by firmware, so we read
// DEFENSIVELY across the documented shapes and only report a fault on a CLEARLY-negative
// signal — never inventing one. The canonical fault indicators on eco hardware are the
// front "Eclipse Led" going Solid/Blinking RED, and any non-zero DC-shutdown / secondary
// error code. Everything here is READ-ONLY and fail-soft; a missing field ⇒ no fault.

export interface SonnenFaultStatus {
  /** true only when a reliable field clearly indicates a fault/comms-error state. */
  fault: boolean;
  /** Human-readable reason for the fault (for the alert sub-line). Empty when none. */
  reason: string;
  /** Whether we actually found a field to evaluate (so callers can stay conservative). */
  known: boolean;
}

/** Case-insensitively pluck the first present key from an object. */
function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined;
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const hit = lower.get(k.toLowerCase());
    if (hit !== undefined && obj[hit] !== undefined && obj[hit] !== null) return obj[hit];
  }
  return undefined;
}

/**
 * Read /latestdata (+ /status) and derive a conservative fault signal. Reads only fields
 * documented as reliably present on eco firmware; if none are found, returns
 * { fault:false, known:false } so the rule stays silent rather than guessing.
 */
export async function getFaultStatus(): Promise<SonnenFaultStatus> {
  const ld = (await getLatestData().catch(() => null)) as
    | (Record<string, unknown> & { ic_status?: Record<string, unknown> })
    | null;
  const ic = ld?.ic_status;

  let known = false;
  const reasons: string[] = [];

  // 1) Eclipse LED — the front status LED. Solid/blinking RED = fault/comms-error. The
  //    key is an object of boolean state flags on eco firmware.
  const eclipse = pick(ic, 'Eclipse Led', 'eclipse_led') as Record<string, unknown> | undefined;
  if (eclipse && typeof eclipse === 'object') {
    known = true;
    for (const [state, on] of Object.entries(eclipse)) {
      if (on === true && /red/i.test(state)) reasons.push(`status LED ${state}`);
    }
  }

  // 2) DC shutdown / secondary error codes — any non-zero value is a real fault reason.
  const dcShutdown = pick(ic, 'DC Shutdown Reason', 'dc_shutdown_reason');
  if (dcShutdown !== undefined) {
    known = true;
    const n = typeof dcShutdown === 'string' ? Number(dcShutdown) : (dcShutdown as number);
    if (Number.isFinite(n) && n > 0) reasons.push(`DC shutdown reason ${n}`);
  }
  const secErr = pick(ic, 'secondary_error', 'Secondary Error', 'error');
  if (secErr !== undefined) {
    known = true;
    const n = typeof secErr === 'string' ? Number(secErr) : (secErr as number);
    if (Number.isFinite(n) && n > 0) reasons.push(`error code ${n}`);
  }

  return { fault: reasons.length > 0, reason: reasons.join('; '), known };
}

/** Fetch /status and normalize to the /api/live sonnen shape. */
export async function getNormalized(): Promise<SonnenNormalized> {
  const raw = (await getStatus()) as SonnenStatusRaw;
  const soc = Math.round(raw.USOC ?? raw.RSOC ?? 0);
  // Stored *usable* energy. The device's RemainingCapacity_Wh reports GROSS cell
  // capacity, which exceeds the nameplate usable (and even nominal) kWh — using it
  // made "stored" overshoot usable and pushed the combined SoC past 100%. Derive
  // from SoC against the configured usable capacity so stored ≤ usable always.
  const kwh = Math.round((soc / 100) * config.assets.sonnenUsableKwh * 10) / 10;

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
    uacV: Number.isFinite(raw.Uac) ? Math.round(raw.Uac as number) : 0,
    online: true,
  };
}
