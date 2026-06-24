import { config } from '../config';

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
  return get('/status');
}

/** Authenticated config read: EM_OperatingMode, EM_USOC (backup reserve), etc. */
export function getConfigurations(): Promise<unknown> {
  return get('/configurations', true);
}
