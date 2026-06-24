import { config } from '../config';

// Tesla Fleet API (cloud, EU host). Uses the stored refresh token to mint
// short-lived access tokens; energy endpoints are plain Bearer REST (no signing).
let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.exp > now + 60_000) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.tesla.clientId,
    refresh_token: config.tesla.refreshToken,
  });
  if (config.tesla.clientSecret) body.set('client_secret', config.tesla.clientSecret);

  const res = await fetch(config.tesla.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tesla token refresh -> HTTP ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  cached = { token: json.access_token, exp: now + (json.expires_in ?? 28_800) * 1000 };
  return cached.token;
}

/** Live power flow for the energy site (solar/battery/load/grid + SoC). */
export async function getLiveStatus(): Promise<unknown> {
  if (!config.tesla.siteId) throw new Error('TESLA_ENERGY_SITE_ID not set');
  const token = await accessToken();
  const url = `${config.tesla.audience}/api/1/energy_sites/${config.tesla.siteId}/live_status`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tesla live_status -> HTTP ${res.status}`);
  const json = (await res.json()) as { response?: unknown };
  return json.response ?? json;
}
