// Runtime-overridable integration config. Values entered in Settings (persisted
// in the store) take precedence over the env-configured defaults in config.ts.
// Connectors read through these so changes apply without a restart.

import { config } from './config';
import * as store from './store';

export function sonnenHost(): string {
  return store.get().integrations?.sonnen?.host?.trim() || config.sonnen.host;
}

export function sonnenToken(): string {
  return store.get().integrations?.sonnen?.token || config.sonnen.token;
}

export function teslaSiteId(): string {
  return store.get().integrations?.tesla?.siteId?.trim() || config.tesla.siteId;
}

export function weatherCoords(): { lat: number; lon: number } {
  const w = store.get().integrations?.weather;
  return {
    lat: typeof w?.lat === 'number' ? w.lat : config.site.lat,
    lon: typeof w?.lon === 'number' ? w.lon : config.site.lon,
  };
}

/** Airzone webserver host — same precedence the connector uses (store → env → default). */
export function airzoneHost(): string {
  return store.get().integrations?.airzone?.host?.trim() || process.env.AIRZONE_HOST || '192.168.1.165';
}

export function tuyaConfig(): { region: string; accessId: string; accessSecret: string } {
  const t = store.get().integrations?.tuya;
  return {
    region: t?.region?.trim() || config.tuya.region,
    accessId: t?.accessId?.trim() || config.tuya.accessId,
    accessSecret: t?.accessSecret || config.tuya.accessSecret,
  };
}

/** One Sungrow WiNet-S dongle: its LAN IP + an optional friendly name. */
export interface SungrowDongle {
  ip: string;
  name?: string;
  /**
   * Nameplate AC rating (kW) of the inverter behind this dongle. Used by the connector's
   * per-inverter plausibility guard to reject physically-impossible catch-up spikes.
   * Defaults to the SG5.0RS's 5.0 kW when unset. Tunable per dongle via the Settings override.
   */
  ratedKw?: number;
}

/**
 * Sungrow dongle list — the two WiNet-S dongles (one per SG5.0RS inverter), keyed on
 * dongle IP (both COM names are identical). Precedence mirrors airzoneHost()/sonnenHost():
 * a Settings override (store.integrations.sungrow.dongles) wins, else the env fallback
 * (SUNGROW_HOST_1 / SUNGROW_HOST_2), else the discovered defaults (docs/36). Always
 * returns ≥1 entry so the connector/health-probe have something to poll.
 */
export function sungrowConfig(): SungrowDongle[] {
  const s = store.get().integrations?.sungrow;
  const configured = s?.dongles?.filter((d) => d && typeof d.ip === 'string' && d.ip.trim());
  if (configured && configured.length > 0) {
    return configured.map((d) => ({
      ip: d.ip.trim(),
      name: d.name?.trim() || undefined,
      ...(typeof d.ratedKw === 'number' && d.ratedKw > 0 ? { ratedKw: d.ratedKw } : {}),
    }));
  }
  const ip1 = process.env.SUNGROW_HOST_1?.trim() || '192.168.1.67';
  const ip2 = process.env.SUNGROW_HOST_2?.trim() || '192.168.1.181';
  return [
    { ip: ip1, name: 'Solar Inverter 1' },
    { ip: ip2, name: 'Solar Inverter 2' },
  ];
}

/**
 * How often we actually hit the WiNet-S dongles (seconds), driving the connector's
 * getNormalized() cache TTL. The WiNet-S dongle's embedded server crashes under
 * repeated local polling (openHAB-community-confirmed lockup, incident 2026-07-03),
 * so we deliberately poll GENTLY — default 60s (was 20s). Env `SUNGROW_POLL_SEC`
 * overrides; clamped to a sane 20–600s so a bad env can't hammer or freeze the read.
 */
export function sungrowPollSec(): number {
  const raw = Number(process.env.SUNGROW_POLL_SEC);
  if (!Number.isFinite(raw) || raw <= 0) return 60;
  return Math.max(20, Math.min(600, Math.round(raw)));
}

/**
 * iSolarCloud OpenAPI config (Phase B — cloud backstop). Read from the Settings
 * store (store.integrations.isolarcloud) with an env fallback. Returns `null` when
 * unconfigured so the connector no-ops (disabled/gated until the owner's key lands).
 * All secrets stay server-side; the config route never returns appkey/accessKey/rsa.
 */
export interface IsolarcloudConfig {
  /** OpenAPI application key (x-access-key pairs with appkey). */
  appkey: string;
  /** OpenAPI access key (sent as the `x-access-key` header). */
  accessKey: string;
  /** RSA public key (PEM body, base64) used to encrypt the AES session key. */
  rsaPublicKey: string;
  /** iSolarCloud account login (email/username) for the login grant. */
  account: string;
  /** iSolarCloud account password for the login grant. */
  password: string;
  /** Region host, default the EU gateway. */
  region: string;
  /** Optional owner-set serial→dongle-IP map (cloud dev ↔ local dongle). */
  serialMap?: Record<string, string>;
}

const ISC_DEFAULT_REGION = 'gateway.isolarcloud.eu';

export function isolarcloudConfig(): IsolarcloudConfig | null {
  const c = store.get().integrations?.isolarcloud;
  const appkey = (c?.appkey?.trim() || process.env.ISOLARCLOUD_APPKEY?.trim() || '');
  const accessKey = (c?.accessKey?.trim() || process.env.ISOLARCLOUD_ACCESS_KEY?.trim() || '');
  const rsaPublicKey = (c?.rsaPublicKey?.trim() || process.env.ISOLARCLOUD_RSA_KEY?.trim() || '');
  const account = (c?.account?.trim() || process.env.ISOLARCLOUD_ACCOUNT?.trim() || '');
  const password = (c?.password || process.env.ISOLARCLOUD_PASSWORD || '');
  const region = (c?.region?.trim() || process.env.ISOLARCLOUD_REGION?.trim() || ISC_DEFAULT_REGION);
  // Fully configured means we can both authenticate (account+password) and sign
  // (appkey+accessKey+rsa). Anything short of that → disabled (return null).
  if (!appkey || !accessKey || !rsaPublicKey || !account || !password) return null;
  return {
    appkey,
    accessKey,
    rsaPublicKey,
    account,
    password,
    region,
    ...(c?.serialMap && typeof c.serialMap === 'object' ? { serialMap: c.serialMap } : {}),
  };
}
