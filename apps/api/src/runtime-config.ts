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
    return configured.map((d) => ({ ip: d.ip.trim(), name: d.name?.trim() || undefined }));
  }
  const ip1 = process.env.SUNGROW_HOST_1?.trim() || '192.168.1.67';
  const ip2 = process.env.SUNGROW_HOST_2?.trim() || '192.168.1.181';
  return [
    { ip: ip1, name: 'Solar Inverter 1' },
    { ip: ip2, name: 'Solar Inverter 2' },
  ];
}
