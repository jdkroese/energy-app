// Configurable connections (Settings → Connections). Each writer VALIDATES the
// candidate config against the real service BEFORE persisting, so a bad value
// can never replace a working one. Tokens are never returned to the client.

import * as store from '../store';
import * as tesla from '../connectors/tesla';
import { sonnenHost, sonnenToken, teslaSiteId, weatherCoords } from '../runtime-config';

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
