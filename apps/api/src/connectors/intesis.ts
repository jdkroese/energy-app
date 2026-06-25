// Intesis "AC Cloud Control" connector (the cloud behind the "AC Cloud" app).
// Reads — and later controls — the Panasonic Etherea units over the internet via
// the IntesisHome cloud API. The energy-app backend talks to AC Cloud exactly the
// way the phone app does; nothing here touches the home LAN/VPN.
//
// Protocol (per the long-established pyintesishome reverse-engineering):
//  - LOGIN: POST form to <CLOUD>/api/php/get/control with username+password+cmd.
//    The response carries the installations, every device + its datapoints, the
//    last-known datapoint VALUES, and a push-socket {serverIP, serverPort, token}.
//  - READ (this file, slice A): we poll the login/control endpoint and read state
//    straight from the response — no persistent socket needed for monitoring.
//  - CONTROL (slice B, TODO): open the TCP push socket and send
//    {command:"set", data:{deviceId, uid, value, seqNo}}.
//
// Datapoint UIDs: power=1, mode=2 (0 auto/1 heat/2 dry/3 fan/4 cool), fan=4,
// vaneV=5, vaneH=6, setpoint=9, currentTemp=10. Temperatures are tenths of °C
// (e.g. 210 => 21.0 °C). ⚠️ The exact response SHAPE + temp scaling are validated
// live against the real account on first connect (see normalizeDevices()).

import { config } from '../config';
import { cached } from '../cache';

// AC Cloud Control shares the IntesisHome cloud backend (app id com.intesis.intesishome).
// Host is overridable in case the account lives on the newer accloud.intesis.com edge.
const API_VERSION = '1.8.5';
const cloudBase = () => config.intesis.apiBase || 'https://user.intesishome.com';
const controlUrl = () => `${cloudBase()}/api/php/get/control`;

// Datapoint UID map.
export const UID = {
  power: 1,
  mode: 2,
  fan: 4,
  vaneV: 5,
  vaneH: 6,
  setpoint: 9,
  currentTemp: 10,
} as const;

export const MODE: Record<number, string> = { 0: 'auto', 1: 'heat', 2: 'dry', 3: 'fan', 4: 'cool' };
export const MODE_VALUE: Record<string, number> = { auto: 0, heat: 1, dry: 2, fan: 3, cool: 4 };

export interface IntesisCreds {
  username: string;
  password: string;
}

/** Creds come from the in-app Settings store first, then env as a fallback. */
function creds(): IntesisCreds | null {
  const u = config.intesis.username;
  const p = config.intesis.password;
  if (u && p) return { username: u, password: p };
  return null;
}

export interface IntesisLoginResult {
  token: number;
  serverIP: string;
  serverPort: number;
  /** Flat datapoint values: deviceId -> uid -> value. */
  state: Record<string, Record<number, number>>;
  devices: IntesisDeviceMeta[];
}

export interface IntesisDeviceMeta {
  id: string;
  name: string;
  /** Installation / facility name (e.g. "Tarrac"). */
  installation?: string;
  /** Zone (e.g. "Mezzanine"). */
  zone?: string;
  model?: string;
}

/**
 * Authenticate against AC Cloud and return the device list + last-known state +
 * the push-socket coordinates (used by the control slice). Throws on bad creds
 * or transport failure — callers decide how to surface it.
 */
export async function login(c: IntesisCreds = mustCreds()): Promise<IntesisLoginResult> {
  const body = new URLSearchParams({
    username: c.username,
    password: c.password,
    version: API_VERSION,
    cmd: JSON.stringify({ status: { hash: 'x' }, config: { deviceFetch: 1, hash: 'x' } }),
  });

  const res = await fetch(controlUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`AC Cloud login -> HTTP ${res.status}`);
  const json = (await res.json()) as IntesisRawLogin;

  if (json.errorCode || json.errorMessage) {
    throw new Error(`AC Cloud login rejected: ${json.errorMessage ?? json.errorCode}`);
  }
  return parseLogin(json);
}

function mustCreds(): IntesisCreds {
  const c = creds();
  if (!c) throw new Error('AC Cloud not connected — add your account in Settings');
  return c;
}

/** Whether the account has been connected (creds present). */
export function isConfigured(): boolean {
  return creds() !== null;
}

// ---- Raw response shape (loosely typed; validated live) ---------------------

interface IntesisRawLogin {
  errorCode?: number;
  errorMessage?: string;
  config?: {
    token?: number;
    serverIP?: string;
    serverPort?: number;
    inst?: Array<{ name?: string; devices?: IntesisRawDevice[] }>;
  };
  status?: { status?: Array<{ deviceId: number | string; uid: number; value: number }> };
}

interface IntesisRawDevice {
  id: number | string;
  name?: string;
  zoneName?: string;
  modelId?: string | number;
}

function parseLogin(json: IntesisRawLogin): IntesisLoginResult {
  const cfg = json.config ?? {};
  const devices: IntesisDeviceMeta[] = [];
  for (const inst of cfg.inst ?? []) {
    for (const d of inst.devices ?? []) {
      devices.push({
        id: String(d.id),
        name: d.name ?? `AC ${d.id}`,
        installation: inst.name,
        zone: d.zoneName,
        model: d.modelId !== undefined ? String(d.modelId) : undefined,
      });
    }
  }

  const state: Record<string, Record<number, number>> = {};
  for (const s of json.status?.status ?? []) {
    const id = String(s.deviceId);
    (state[id] ??= {})[s.uid] = s.value;
  }

  return {
    token: cfg.token ?? 0,
    serverIP: cfg.serverIP ?? '',
    serverPort: cfg.serverPort ?? 0,
    devices,
    state,
  };
}

// ---- Normalized shape for /api/climate --------------------------------------

export interface ClimateUnit {
  id: string;
  name: string;
  zone?: string;
  installation?: string;
  power: boolean;
  mode: string; // 'auto'|'heat'|'dry'|'fan'|'cool'|'unknown'
  /** Target setpoint °C (null if the unit doesn't report one). */
  setpointC: number | null;
  /** Measured room temperature °C. */
  currentTempC: number | null;
  online: boolean;
}

/** Tenths-of-°C -> °C, tolerating units that already report whole degrees. */
function toCelsius(raw: number | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  // Heuristic validated on first connect: cloud reports tenths (e.g. 210 = 21.0).
  return raw > 80 ? Math.round((raw / 10) * 10) / 10 : raw;
}

export function normalizeDevices(login: IntesisLoginResult): ClimateUnit[] {
  return login.devices.map((d) => {
    const dp = login.state[d.id] ?? {};
    return {
      id: d.id,
      name: d.name,
      zone: d.zone,
      installation: d.installation,
      power: dp[UID.power] === 1,
      mode: MODE[dp[UID.mode]] ?? 'unknown',
      setpointC: toCelsius(dp[UID.setpoint]),
      currentTempC: toCelsius(dp[UID.currentTemp]),
      online: true,
    };
  });
}

/**
 * Read-only fleet snapshot for /api/climate. Cached 30s to keep the polling UI
 * cheap and stay well under any AC Cloud rate limits. Returns [] when the
 * account isn't connected yet (so the UI can show an "empty/connect" state).
 */
export async function getFleet(): Promise<ClimateUnit[]> {
  if (!isConfigured()) return [];
  return cached('intesis.fleet', 30_000, async () => normalizeDevices(await login()));
}
