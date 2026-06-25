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
