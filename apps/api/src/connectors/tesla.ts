import { config } from '../config';
import * as store from '../store';
import { cached as memo } from '../cache';
import { teslaSiteId } from '../runtime-config';

// Tesla Fleet API (cloud, EU host). Uses the stored refresh token to mint
// short-lived access tokens; energy endpoints are plain Bearer REST (no signing).
let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.exp > now + 60_000) return cached.token;

  // Prefer a rotated refresh token persisted to the store, else the env-configured one.
  const refreshToken = store.get().teslaRefreshToken ?? config.tesla.refreshToken;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.tesla.clientId,
    refresh_token: refreshToken,
  });
  if (config.tesla.clientSecret) body.set('client_secret', config.tesla.clientSecret);

  const res = await fetch(config.tesla.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tesla token refresh -> HTTP ${res.status}`);
  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  };
  cached = { token: json.access_token, exp: now + (json.expires_in ?? 28_800) * 1000 };

  // Tesla Fleet refresh tokens are usually reusable, but persist a rotated one if returned.
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    store.update((s) => {
      s.teslaRefreshToken = json.refresh_token as string;
    });
    console.log('[tesla] refresh token rotated — persisted to store');
  }
  return cached.token;
}

/**
 * Validate a candidate refresh token via an isolated token refresh and ONLY
 * persist it (rotated form, if Tesla returns one) on success — so a bad token
 * can never replace a working one. Primes the access-token cache on success.
 */
export async function reauth(refreshToken: string): Promise<void> {
  const tok = refreshToken.trim();
  if (!tok) throw new Error('refresh token required');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.tesla.clientId,
    refresh_token: tok,
  });
  if (config.tesla.clientSecret) body.set('client_secret', config.tesla.clientSecret);
  const res = await fetch(config.tesla.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`token refresh rejected — HTTP ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
  const persisted = json.refresh_token || tok;
  store.update((s) => {
    s.teslaRefreshToken = persisted;
  });
  cached = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 28_800) * 1000 };
  console.log('[tesla] re-authenticated via Settings — refresh token persisted');
}

/** UNCACHED live_status probe for a site (defaults to the configured one). Throws on failure. */
export async function probeLive(siteId?: string): Promise<void> {
  await apiGet('/live_status', siteId ?? teslaSiteId());
}

async function apiGet(path: string, siteId = teslaSiteId()): Promise<unknown> {
  if (!siteId) throw new Error('TESLA_ENERGY_SITE_ID not set');
  const token = await accessToken();
  const url = `${config.tesla.audience}/api/1/energy_sites/${siteId}${path}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tesla ${path} -> HTTP ${res.status}`);
  const json = (await res.json()) as { response?: unknown };
  return json.response ?? json;
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const siteId = teslaSiteId();
  if (!siteId) throw new Error('TESLA_ENERGY_SITE_ID not set');
  const token = await accessToken();
  const url = `${config.tesla.audience}/api/1/energy_sites/${siteId}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tesla POST ${path} -> HTTP ${res.status}`);
  const json = (await res.json()) as { response?: unknown };
  return json.response ?? json;
}

/** Live power flow for the energy site (solar/battery/load/grid + SoC). */
export function getLiveStatus(): Promise<unknown> {
  return memo('tesla.live', 15_000, () => apiGet('/live_status'));
}

/** Site settings + nameplate: backup_reserve_percent, nameplate_energy, export rule, etc. */
export function getSiteInfo(): Promise<unknown> {
  return memo('tesla.site', 300_000, () => apiGet('/site_info'));
}

/**
 * Rich history. kind = energy|power|soe|backup|self_consumption.
 * period = day|week|month|year. tz = Europe/Madrid (Tesla buckets accordingly).
 *
 * `window` anchors the period in the PAST: Tesla's calendar_history accepts ISO
 * `start_date`/`end_date`, so passing a window returns that historical day/week/
 * month/year instead of the current one. Omit it for the live/current period
 * (unchanged behaviour + a longer-lived cache).
 */
export function getCalendarHistory(
  kind: 'energy' | 'power' | 'soe' | 'self_consumption' | 'backup' = 'energy',
  period: 'day' | 'week' | 'month' | 'year' = 'day',
  window?: { startDate: string; endDate: string },
): Promise<unknown> {
  const tz = encodeURIComponent('Europe/Madrid');
  let url = `/calendar_history?kind=${kind}&period=${period}&time_zone=${tz}`;
  if (window) {
    url += `&start_date=${encodeURIComponent(window.startDate)}&end_date=${encodeURIComponent(window.endDate)}`;
  }
  // Current period changes minute-to-minute (short TTL); a past window is fixed
  // history (cache hard, keyed by the window so offsets don't collide).
  const key = window ? `tesla.hist.${kind}.${period}.${window.endDate}` : `tesla.hist.${kind}.${period}`;
  const ttl = window ? 3_600_000 : 120_000;
  return memo(key, ttl, () => apiGet(url));
}

// ---- Control / write ----------------------------------------------------
// Policy-level levers only (Tesla has no exact-W command). Callers MUST
// guardrail-check first. After a write the memoized site_info is stale, so
// readControlConfig() does an UNCACHED /site_info fetch for confirmation.

export type TeslaMode = 'self_consumption' | 'autonomous' | 'backup';
export type TeslaExportRule = 'pv_only' | 'battery_ok' | 'never';

/** Set default_real_mode (self_consumption | autonomous | backup). */
export function setMode(mode: TeslaMode): Promise<unknown> {
  return apiPost('/operation', { default_real_mode: mode });
}

/** Set backup_reserve_percent (0..100). Caller clamps. */
export function setReserve(pct: number): Promise<unknown> {
  return apiPost('/backup', { backup_reserve_percent: Math.round(pct) });
}

/** Set grid-charge enable + export rule in one call. */
export function setGridImportExport(
  disallowCharge: boolean,
  exportRule: TeslaExportRule,
): Promise<unknown> {
  return apiPost('/grid_import_export', {
    disallow_charge_from_grid_with_solar_installed: disallowCharge,
    customer_preferred_export_rule: exportRule,
  });
}

export interface TeslaControlConfig {
  mode: string;
  reservePct: number;
  /** true when grid-charging is allowed (disallow flag is false). */
  gridChargeAllowed: boolean;
  exportRule: string;
}

interface TeslaSiteInfoControlRaw extends TeslaSiteInfoRaw {
  disallow_charge_from_grid_with_solar_installed?: boolean;
  components?: { customer_preferred_export_rule?: string; disallow_charge_from_grid_with_solar_installed?: boolean };
}

/** UNCACHED /site_info read of the control-relevant settings, for read-back. */
export async function readControlConfig(): Promise<TeslaControlConfig> {
  const info = (await apiGet('/site_info')) as TeslaSiteInfoControlRaw;
  const exportRule =
    info.customer_preferred_export_rule ?? info.components?.customer_preferred_export_rule ?? 'unknown';
  const disallow =
    info.disallow_charge_from_grid_with_solar_installed ??
    info.components?.disallow_charge_from_grid_with_solar_installed ??
    false;
  return {
    mode: info.default_real_mode ?? 'unknown',
    reservePct: typeof info.backup_reserve_percent === 'number' ? info.backup_reserve_percent : 0,
    gridChargeAllowed: !disallow,
    exportRule,
  };
}

// ---- Normalized shapes --------------------------------------------------

export interface TeslaLiveRaw {
  solar_power?: number;
  load_power?: number;
  battery_power?: number; // + discharging / - charging (Tesla convention)
  grid_power?: number; // + importing / - exporting
  percentage_charged?: number;
  grid_status?: string;
  island_status?: string; // 'on_grid' when grid-tied
  storm_mode_active?: boolean;
}

export interface TeslaSiteInfoRaw {
  backup_reserve_percent?: number;
  nameplate_energy?: number;
  nameplate_power?: number;
  battery_count?: number;
  default_real_mode?: string;
  customer_preferred_export_rule?: string;
}

export interface TeslaNormalized {
  soc: number;
  kwh: number;
  kw: number;
  dir: 'charging' | 'discharging' | 'idle';
  reservePct: number;
  backupKwh: number;
  backupHours: number;
  island: boolean;
  solarKw: number;
  loadKw: number;
  gridKw: number;
  mode?: string;
  online: true;
}

/** Combine live_status + site_info into the /api/live tesla shape. */
export async function getNormalized(reservePctFallback = 20): Promise<TeslaNormalized> {
  const live = (await getLiveStatus()) as TeslaLiveRaw;
  let reservePct = reservePctFallback;
  let mode: string | undefined;
  let usableKwh: number = config.assets.teslaUsableKwh;
  try {
    const info = (await getSiteInfo()) as TeslaSiteInfoRaw;
    if (typeof info.backup_reserve_percent === 'number') reservePct = info.backup_reserve_percent;
    mode = info.default_real_mode;
    if (typeof info.nameplate_energy === 'number' && info.nameplate_energy > 0) {
      usableKwh = info.nameplate_energy / 1000 > 5 ? info.nameplate_energy / 1000 : info.nameplate_energy;
    }
  } catch {
    // best-effort; keep fallback reserve
  }

  const soc = Math.round(live.percentage_charged ?? 0);
  const kwh = Math.round(((soc / 100) * usableKwh) * 10) / 10;
  const batt = live.battery_power ?? 0;
  let dir: TeslaNormalized['dir'] = 'idle';
  if (batt < -25) dir = 'charging';
  else if (batt > 25) dir = 'discharging';

  // Backup autonomy: energy above reserve floor / critical-load draw.
  const backupKwh = Math.max(0, Math.round((((soc - reservePct) / 100) * usableKwh) * 10) / 10);
  const backupHours = Math.round((backupKwh / config.assets.criticalLoadKw) * 10) / 10;

  return {
    soc,
    kwh,
    kw: Math.round((Math.abs(batt) / 1000) * 100) / 100,
    dir,
    reservePct,
    backupKwh,
    backupHours,
    island: live.island_status ? live.island_status !== 'on_grid' : false,
    solarKw: Math.round(((live.solar_power ?? 0) / 1000) * 100) / 100,
    loadKw: Math.round(((live.load_power ?? 0) / 1000) * 100) / 100,
    gridKw: Math.round(((live.grid_power ?? 0) / 1000) * 100) / 100,
    mode,
    online: true,
  };
}
