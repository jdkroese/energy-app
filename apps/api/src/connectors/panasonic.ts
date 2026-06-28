// Panasonic Comfort Cloud connector — cloud-managed WiFi AC units (CS-Z / CS-XZ
// series with built-in WiFi modules). Provides the same ClimateUnit shape as the
// Intesis connector so Panasonic units merge into the same Devices fleet alongside
// Intesis/Airzone, using all the same management pages, scheduling, and surplus rules.
//
// API: REST + JSON over HTTPS to accsmart.panasonic.com.
// Auth: username + password → uToken (session token).  We cache the session for
// SESSION_TTL_MS and re-auth automatically when it expires or a request fails 401.
//
// Validated against the Panasonic Comfort Cloud app v1.21 protocol (2026-06).
// Rate limits: undocumented; we apply the same 30 s/lever guard as Intesis.

import { cached } from '../cache';
import * as store from '../store';
import type { ClimateUnit } from './intesis';

const BASE_URL = 'https://accsmart.panasonic.com';
// Version string the server validates — bump if the API starts returning 401/403.
const APP_VERSION = '1.21.0';
// Session token is reused for up to 4 hours before we re-auth.
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

// ---- Mode maps -------------------------------------------------------------
// Panasonic operationMode: 0=auto 1=dry 2=cool 3=heat 4=fan
const MODE: Record<number, string> = { 0: 'auto', 1: 'dry', 2: 'cool', 3: 'heat', 4: 'fan' };
const MODE_VALUE: Record<string, number> = { auto: 0, dry: 1, cool: 2, heat: 3, fan: 4 };

// ---- Credentials -----------------------------------------------------------

interface PanasonicCreds { username: string; password: string; }

function creds(): PanasonicCreds | null {
  const s = (store.get().integrations as { panasonic?: { username?: string; password?: string } | null }).panasonic;
  if (s?.username && s?.password) return { username: s.username, password: s.password };
  const u = process.env.PANASONIC_CC_USER;
  const p = process.env.PANASONIC_CC_PASS;
  if (u && p) return { username: u, password: p };
  return null;
}

export function isConfigured(): boolean { return creds() !== null; }

// ---- Auth ------------------------------------------------------------------

interface PanasonicSession { uToken: string; clientId: string; expiresAt: number; }

let session: PanasonicSession | null = null;

function commonHeaders(token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json;charset=UTF-8',
    Accept: 'application/json',
    'X-APP-TYPE': '1',
    'X-APP-VERSION': APP_VERSION,
    'X-CFC-API-LEVEL': '2',
    ...(token ? { 'X-User-Authorization': token } : {}),
  };
}

async function login(c: PanasonicCreds): Promise<PanasonicSession> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: commonHeaders(),
    body: JSON.stringify({ loginId: c.username, password: c.password, language: 0 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Panasonic CC login → HTTP ${res.status}`);
  const json = (await res.json()) as { result?: number; uToken?: string; clientId?: string; message?: string };
  if (json.result !== 0 || !json.uToken) {
    throw new Error(`Panasonic CC login rejected: ${json.message ?? String(json.result)}`);
  }
  return { uToken: json.uToken, clientId: json.clientId ?? '', expiresAt: Date.now() + SESSION_TTL_MS };
}

async function getSession(): Promise<PanasonicSession> {
  const c = creds();
  if (!c) throw new Error('Panasonic CC not connected — add credentials in Settings or .env');
  if (session && session.expiresAt > Date.now()) return session;
  session = await login(c);
  return session;
}

function invalidateSession(): void { session = null; }

// ---- Raw API types ---------------------------------------------------------

interface PanasonicParameters {
  operate?: number;         // 0=off, 1=on
  operationMode?: number;   // 0=auto 1=dry 2=cool 3=heat 4=fan
  temperatureSet?: number;  // target °C (decimal)
  temperatureNow?: number;  // current room °C
  fanSpeed?: number;        // 0=auto, 1=slowest … 5=fastest
  airSwingUD?: number;      // vertical vane: 0=auto, 1–5=positions, others=swing
  airSwingLR?: number;      // horizontal vane
}

interface PanasonicDevice {
  deviceGuid: string;
  deviceType?: number;
  deviceName: string;
  parameters?: PanasonicParameters;
}

interface PanasonicGroup {
  groupId?: number;
  groupName?: string;
  deviceList?: PanasonicDevice[];
}

// ---- Internal ID -----------------------------------------------------------
// deviceGuid may contain '+' (URL-unsafe). We prefix 'pan-' and replace '+' with '-'.
// A Map lets the write path look up the real GUID from our safe internal ID.
const guidByInternalId = new Map<string, string>();

function internalId(guid: string): string {
  const id = `pan-${guid.replace(/\+/g, '-')}`;
  guidByInternalId.set(id, guid);
  return id;
}

export function guidFor(id: string): string {
  const g = guidByInternalId.get(id);
  if (!g) throw new Error(`Panasonic device not in session cache: ${id}. Fetch the fleet first.`);
  return g;
}

// ---- Vane mapping ----------------------------------------------------------
// Panasonic: 0=auto, 1–5=fixed positions. Swing is either a high value or a
// separate `airSwingAutoUD` flag (device-dependent). We map anything outside
// 0–5 to auto on read; on write we pass swing as value 6 (safest common code).
function toVane(v?: number): number | null {
  if (v === undefined || v === null) return null;
  if (v === 0) return 0;                    // auto
  if (v >= 1 && v <= 5) return v;          // fixed position
  return 10;                                // swing / other → our swing sentinel
}

function fromVane(v: number): number {
  if (v === 0) return 0;
  if (v === 10) return 6;                   // our swing → Panasonic swing code 6
  return Math.min(5, Math.max(1, v));
}

// ---- Normalize device → ClimateUnit ----------------------------------------

function toClimateUnit(d: PanasonicDevice): ClimateUnit {
  const p = d.parameters ?? {};
  return {
    id: internalId(d.deviceGuid),
    name: d.deviceName,
    installation: 'Panasonic CC',
    power: p.operate === 1,
    mode: MODE[p.operationMode ?? -1] ?? 'unknown',
    setpointC: p.temperatureSet ?? null,
    currentTempC: p.temperatureNow ?? null,
    minSetpointC: 16,
    maxSetpointC: 30,
    online: true,
    fanLevel: p.fanSpeed ?? null,
    vaneUpDown: toVane(p.airSwingUD),
    vaneLeftRight: toVane(p.airSwingLR),
  };
}

// ---- Fleet read ------------------------------------------------------------

async function fetchFleet(): Promise<ClimateUnit[]> {
  const sess = await getSession();
  const res = await fetch(`${BASE_URL}/device/group`, {
    headers: commonHeaders(sess.uToken),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) {
    invalidateSession();
    throw new Error('Panasonic CC session expired — will re-auth next poll');
  }
  if (!res.ok) throw new Error(`Panasonic CC getGroups → HTTP ${res.status}`);
  const json = (await res.json()) as { groupList?: PanasonicGroup[] };
  return (json.groupList ?? []).flatMap((g) => (g.deviceList ?? []).map(toClimateUnit));
}

/** Cached 30 s fleet snapshot; returns [] when not configured. */
export async function getFleet(): Promise<ClimateUnit[]> {
  if (!isConfigured()) return [];
  return cached('panasonic.fleet', 30_000, () => fetchFleet());
}

// ---- Control ---------------------------------------------------------------

export type PanasonicLever = 'power' | 'mode' | 'setpoint' | 'fan' | 'vaneUpDown' | 'vaneLeftRight';

export interface PanasonicSetResult { ok: boolean; detail: string; }

/** Write one lever to a Panasonic unit. Caller (climate-execute) applies guardrails
 *  and rate-limiting; this just talks to the cloud. */
export async function setLever(
  id: string,
  lever: PanasonicLever,
  value: boolean | number | string,
): Promise<PanasonicSetResult> {
  const sess = await getSession();
  const guid = guidFor(id);

  const parameters: Record<string, number> = {};
  if (lever === 'power') {
    parameters.operate = value ? 1 : 0;
  } else if (lever === 'mode') {
    const code = MODE_VALUE[String(value)];
    if (code === undefined) throw new Error(`Panasonic CC unknown mode: ${value}`);
    parameters.operationMode = code;
  } else if (lever === 'setpoint') {
    parameters.temperatureSet = Number(value);
  } else if (lever === 'fan') {
    parameters.fanSpeed = Math.max(0, Math.round(Number(value)));
  } else if (lever === 'vaneUpDown') {
    parameters.airSwingUD = fromVane(Number(value));
  } else if (lever === 'vaneLeftRight') {
    parameters.airSwingLR = fromVane(Number(value));
  }

  const res = await fetch(`${BASE_URL}/deviceStatus/control`, {
    method: 'POST',
    headers: commonHeaders(sess.uToken),
    body: JSON.stringify({ deviceGuid: guid, parameters }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) {
    invalidateSession();
    throw new Error('Panasonic CC session expired mid-write — will re-auth next request');
  }
  if (!res.ok) throw new Error(`Panasonic CC set → HTTP ${res.status}`);
  const json = (await res.json()) as { result?: number; message?: string };
  if (json.result !== 0) throw new Error(`Panasonic CC set rejected: ${json.message ?? String(json.result)}`);
  return { ok: true, detail: `${lever}=${String(value)} on ${id}` };
}
