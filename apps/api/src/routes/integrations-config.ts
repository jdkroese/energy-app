// Configurable connections (Settings → Connections). Each writer VALIDATES the
// candidate config against the real service BEFORE persisting, so a bad value
// can never replace a working one. Tokens are never returned to the client.

import * as store from '../store';
import * as tesla from '../connectors/tesla';
import * as sungrow from '../connectors/sungrow';
import * as isolarcloud from '../connectors/isolarcloud';
import {
  sonnenHost,
  sonnenToken,
  teslaSiteId,
  weatherCoords,
  airzoneHost,
  sungrowConfig,
  isolarcloudConfig,
  type IsolarcloudConfig,
} from '../runtime-config';

function badInput(msg: string): never {
  const e = new Error(msg) as Error & { code?: string };
  e.code = 'BAD_INPUT';
  throw e;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** Current effective config (resolved value + whether a Settings override is set). Never leaks the token. */
export function getIntegrationsConfig(): unknown {
  const i = store.get().integrations;
  const coords = weatherCoords();
  return {
    ts: new Date().toISOString(),
    sonnen: { host: sonnenHost(), hasToken: Boolean(sonnenToken()), overridden: Boolean(i?.sonnen?.host || i?.sonnen?.token) },
    tesla: { siteId: teslaSiteId(), overridden: Boolean(i?.tesla?.siteId) },
    weather: { lat: coords.lat, lon: coords.lon, overridden: Boolean(i?.weather) },
    airzone: { host: airzoneHost(), overridden: Boolean(i?.airzone?.host) },
    sungrow: {
      // lastSeen surfaces IP drift (a DHCP move) between polls without triggering one.
      dongles: sungrowConfig().map((d) => ({ ip: d.ip, name: d.name ?? '', lastSeen: sungrow.lastSeenFor(d.ip) })),
      overridden: Boolean(i?.sungrow?.dongles && i.sungrow.dongles.length > 0),
    },
    isolarcloud: {
      // Gated cloud backstop (docs/44) — never leaks the appkey/accessKey/RSA/password.
      configured: isolarcloudConfig() !== null,
      region: i?.isolarcloud?.region?.trim() || 'gateway.isolarcloud.eu',
      account: i?.isolarcloud?.account?.trim() || '',
      hasAppkey: Boolean(i?.isolarcloud?.appkey),
      hasAccessKey: Boolean(i?.isolarcloud?.accessKey),
      hasRsaKey: Boolean(i?.isolarcloud?.rsaPublicKey),
    },
  };
}

// ---- Sonnen -------------------------------------------------------------

const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/i;

/** Probe a candidate Sonnen host (+ optional token) without persisting. */
async function probeSonnen(host: string, token?: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`http://${host}/api/v2/status`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, detail: `status returned HTTP ${res.status}` };
    if (token) {
      const a = await fetch(`http://${host}/api/v2/latestdata`, {
        headers: { 'Auth-Token': token },
        signal: AbortSignal.timeout(8000),
      });
      if (a.status === 401 || a.status === 403) return { ok: false, detail: 'auth token rejected' };
      if (!a.ok) return { ok: false, detail: `auth check HTTP ${a.status}` };
      return { ok: true, detail: 'reachable · token valid' };
    }
    return { ok: true, detail: 'reachable' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message || 'unreachable' };
  }
}

export async function testSonnen(hostRaw?: unknown, tokenRaw?: unknown): Promise<ProbeResult> {
  const host = String(hostRaw ?? sonnenHost()).trim();
  const token = tokenRaw ? String(tokenRaw) : sonnenToken();
  if (!host) badInput('host required');
  return probeSonnen(host, token || undefined);
}

export async function setSonnen(hostRaw?: unknown, tokenRaw?: unknown): Promise<unknown> {
  const host = String(hostRaw ?? '').trim();
  if (!host || !HOST_RE.test(host)) badInput('Enter a valid host/IP (e.g. 192.168.1.197)');
  // If no new token is given, keep the current effective one for validation.
  const token = tokenRaw ? String(tokenRaw) : sonnenToken();
  const probe = await probeSonnen(host, token || undefined);
  if (!probe.ok) badInput(`Could not reach Sonnen at ${host} — ${probe.detail}`);
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.sonnen = {
      host,
      token: tokenRaw ? String(tokenRaw) : s.integrations.sonnen?.token,
    };
  });
  return { ts: new Date().toISOString(), ...probe, config: getIntegrationsConfig() };
}

// ---- Weather ------------------------------------------------------------

async function probeWeather(lat: number, lon: number): Promise<ProbeResult> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m&forecast_days=1&timezone=Europe%2FMadrid`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, detail: `Open-Meteo HTTP ${res.status}` };
    const j = (await res.json()) as { hourly?: { temperature_2m?: number[] } };
    if (!j.hourly?.temperature_2m?.length) return { ok: false, detail: 'no forecast for these coordinates' };
    return { ok: true, detail: 'forecast available' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message || 'unreachable' };
  }
}

export async function setWeather(latRaw?: unknown, lonRaw?: unknown): Promise<unknown> {
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) badInput('Latitude must be between -90 and 90');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) badInput('Longitude must be between -180 and 180');
  const probe = await probeWeather(lat, lon);
  if (!probe.ok) badInput(`Could not get a forecast — ${probe.detail}`);
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.weather = { lat, lon };
  });
  return { ts: new Date().toISOString(), ...probe, config: getIntegrationsConfig() };
}

// ---- Tesla --------------------------------------------------------------

export async function testTesla(): Promise<ProbeResult> {
  try {
    await tesla.probeLive();
    return { ok: true, detail: 'live read OK' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message || 'unreachable' };
  }
}

export async function setTeslaSite(siteIdRaw?: unknown): Promise<unknown> {
  const siteId = String(siteIdRaw ?? '').trim();
  if (!/^\d{5,}$/.test(siteId)) badInput('Enter a numeric Tesla energy site id');
  try {
    await tesla.probeLive(siteId); // validate against the live API before persisting
  } catch (e) {
    badInput(`Site id did not validate — ${(e as Error).message}`);
  }
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.tesla = { siteId };
  });
  return { ts: new Date().toISOString(), ok: true, config: getIntegrationsConfig() };
}

export async function reauthTesla(tokenRaw?: unknown): Promise<unknown> {
  const token = String(tokenRaw ?? '').trim();
  if (!token) badInput('Paste a Tesla refresh token');
  try {
    await tesla.reauth(token); // validates by refreshing; only persists on success
  } catch (e) {
    badInput(`Re-authentication failed — ${(e as Error).message}`);
  }
  // Confirm the new token actually reads the site.
  const probe = await testTesla();
  return { ts: new Date().toISOString(), ok: probe.ok, detail: probe.detail };
}

// ---- Airzone ------------------------------------------------------------

/** Probe a candidate Airzone webserver (Local API, port 3000) without persisting. */
async function probeAirzone(host: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`http://${host}:3000/api/v1/hvac`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemID: 0, zoneID: 0 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, detail: `Local API HTTP ${res.status}` };
    const j = (await res.json()) as { systems?: { data?: unknown[] }[]; data?: unknown[] };
    const zones = Array.isArray(j.systems)
      ? j.systems.reduce((n, s) => n + (s.data?.length ?? 0), 0)
      : j.data?.length ?? 0;
    if (!zones) return { ok: false, detail: 'reachable but no zones reported' };
    return { ok: true, detail: `reachable · ${zones} zone${zones === 1 ? '' : 's'}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message || 'unreachable' };
  }
}

export async function testAirzone(hostRaw?: unknown): Promise<ProbeResult> {
  const host = String(hostRaw ?? airzoneHost()).trim();
  if (!host) badInput('host required');
  return probeAirzone(host);
}

export async function setAirzone(hostRaw?: unknown): Promise<unknown> {
  const host = String(hostRaw ?? '').trim();
  if (!host || !HOST_RE.test(host)) badInput('Enter a valid host/IP (e.g. 192.168.1.165)');
  const probe = await probeAirzone(host);
  if (!probe.ok) badInput(`Could not reach Airzone at ${host} — ${probe.detail}`);
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.airzone = { host };
  });
  return { ts: new Date().toISOString(), ...probe, config: getIntegrationsConfig() };
}

// ---- Sungrow solar inverters --------------------------------------------
// Two WiNet-S dongles (one per SG5.0RS). Probe each via the confirmed-open local
// REST product endpoint (guest; no dongle reconfig needed — docs/36). A test/save is
// OK if AT LEAST ONE dongle answers (at night both may be asleep, which is expected).

/** Probe a candidate set of dongle IPs without persisting. */
async function probeSungrow(ips: string[]): Promise<ProbeResult> {
  const results = await Promise.allSettled(ips.map((ip) => sungrow.probeProduct(ip)));
  const okCount = results.filter((r) => r.status === 'fulfilled').length;
  if (okCount === 0) {
    const first = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    return { ok: false, detail: (first?.reason as Error)?.message?.slice(0, 60) ?? 'no dongle reachable (asleep at night?)' };
  }
  const names = results
    .map((r) => (r.status === 'fulfilled' ? r.value.productName : null))
    .filter(Boolean);
  return { ok: true, detail: `${okCount}/${ips.length} reachable · ${names.join(', ') || 'WiNet-S'}` };
}

/** Parse a raw dongles payload (array of {ip,name}) into a validated IP/name list. */
function parseDongles(raw: unknown): { ip: string; name?: string }[] {
  if (!Array.isArray(raw)) badInput('dongles must be an array of { ip, name }');
  const out: { ip: string; name?: string }[] = [];
  for (const d of raw) {
    const ip = String((d as { ip?: unknown })?.ip ?? '').trim();
    if (!ip) continue;
    if (!HOST_RE.test(ip)) badInput(`Invalid dongle IP: ${ip}`);
    const name = String((d as { name?: unknown })?.name ?? '').trim();
    out.push(name ? { ip, name } : { ip });
  }
  if (out.length === 0) badInput('Enter at least one dongle IP (e.g. 192.168.1.67)');
  return out;
}

export async function testSungrow(donglesRaw?: unknown): Promise<ProbeResult> {
  const ips =
    donglesRaw === undefined ? sungrowConfig().map((d) => d.ip) : parseDongles(donglesRaw).map((d) => d.ip);
  if (ips.length === 0) badInput('at least one dongle IP required');
  return probeSungrow(ips);
}

export async function setSungrow(donglesRaw?: unknown): Promise<unknown> {
  const dongles = parseDongles(donglesRaw);
  const probe = await probeSungrow(dongles.map((d) => d.ip));
  // Save even if asleep-at-night (probe.ok false) is NOT allowed — but a night save
  // with no reachable dongle would look broken. Require at least one reachable so the
  // owner can't accidentally save an unreachable typo; they can retry in daylight.
  if (!probe.ok) badInput(`Could not reach any Sungrow dongle — ${probe.detail}`);
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.sungrow = { dongles };
  });
  return { ts: new Date().toISOString(), ...probe, config: getIntegrationsConfig() };
}

// ---- iSolarCloud (Phase B — cloud backstop, docs/44) --------------------
// The LAN-independent source of truth for the Sungrow inverters. GATED: no-op until
// fully configured. Test authenticates against the real OpenAPI (login → token) before
// persisting; secrets (appkey/accessKey/RSA/password) are stored server-side and NEVER
// returned. Ships UNVERIFIED against real credentials until the owner's key is issued.

/** Build a candidate config from raw input, merging kept secrets from the current store. */
function isolarcloudCandidate(raw: Record<string, unknown>): IsolarcloudConfig {
  const cur = store.get().integrations?.isolarcloud ?? {};
  const str = (v: unknown, keep: string | undefined) => {
    const s = v === undefined || v === null ? '' : String(v).trim();
    return s || (keep ?? '');
  };
  return {
    appkey: str(raw.appkey, cur.appkey),
    accessKey: str(raw.accessKey, cur.accessKey),
    rsaPublicKey: str(raw.rsaPublicKey, cur.rsaPublicKey),
    account: str(raw.account, cur.account),
    // Password is write-only from the UI — keep the stored one when omitted.
    password: raw.password ? String(raw.password) : (cur.password ?? ''),
    region: str(raw.region, cur.region) || 'gateway.isolarcloud.eu',
  };
}

function requireComplete(c: IsolarcloudConfig): void {
  const missing: string[] = [];
  if (!c.appkey) missing.push('appkey');
  if (!c.accessKey) missing.push('access key');
  if (!c.rsaPublicKey) missing.push('RSA public key');
  if (!c.account) missing.push('account');
  if (!c.password) missing.push('password');
  if (missing.length) badInput(`Missing ${missing.join(', ')}`);
}

export async function testIsolarcloud(raw?: unknown): Promise<ProbeResult> {
  const c = isolarcloudCandidate((raw ?? {}) as Record<string, unknown>);
  requireComplete(c);
  // Run the FULL read chain (login → discover → real-time), not just login, so the Test
  // button is truthful about whether the app can actually read a device end-to-end. The
  // SAVE gate (setIsolarcloud) still uses login-only probe, so valid creds save even
  // before the service APIs are whitelisted.
  const { ok, detail } = await isolarcloud.diagnose(c);
  return { ok, detail };
}

export async function setIsolarcloud(raw?: unknown): Promise<unknown> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const c = isolarcloudCandidate(input);
  requireComplete(c);
  const probe = await isolarcloud.probe(c);
  if (!probe.ok) badInput(`iSolarCloud did not authenticate — ${probe.detail}`);
  // Optional owner serial→dongle-IP map (cloud device ↔ local dongle).
  let serialMap: Record<string, string> | undefined;
  if (input.serialMap && typeof input.serialMap === 'object') {
    serialMap = {};
    for (const [k, v] of Object.entries(input.serialMap as Record<string, unknown>)) {
      const ip = String(v ?? '').trim();
      if (k.trim() && ip) serialMap[k.trim()] = ip;
    }
  }
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.isolarcloud = {
      appkey: c.appkey,
      accessKey: c.accessKey,
      rsaPublicKey: c.rsaPublicKey,
      account: c.account,
      password: c.password,
      region: c.region,
      ...(serialMap && Object.keys(serialMap).length ? { serialMap } : {}),
    };
  });
  return { ts: new Date().toISOString(), ...probe, config: getIntegrationsConfig() };
}
