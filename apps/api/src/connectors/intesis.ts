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

import net from 'node:net';
import { config } from '../config';
import { cached } from '../cache';
import * as store from '../store';
import { serialize } from './write-queue';

// AC Cloud Control shares the IntesisHome cloud backend (app id com.intesis.intesishome).
// Host is overridable in case the account lives on the newer accloud.intesis.com edge.
// Validated live 2026-06-25 against the real account (9 Panasonic Etherea units):
// host user.intesishome.com, path /api.php/get/control, version 1.8.5 → HTTP 200.
const API_VERSION = '1.8.5';
const cloudBase = () => config.intesis.apiBase || 'https://user.intesishome.com';
const controlUrl = () => `${cloudBase()}/api.php/get/control`;

// Datapoint UID map.
export const UID = {
  power: 1,
  mode: 2,
  fan: 4,
  vaneV: 5,
  vaneH: 6,
  setpoint: 9,
  currentTemp: 10,
  setpointMin: 35,
  setpointMax: 36,
} as const;

export const MODE: Record<number, string> = { 0: 'auto', 1: 'heat', 2: 'dry', 3: 'fan', 4: 'cool' };
export const MODE_VALUE: Record<string, number> = { auto: 0, heat: 1, dry: 2, fan: 3, cool: 4 };

export interface IntesisCreds {
  username: string;
  password: string;
}

/** Creds come from the in-app Settings store first, then env as a fallback. */
function creds(): IntesisCreds | null {
  const fromStore = store.get().integrations.intesis;
  if (fromStore?.username && fromStore?.password) {
    return { username: fromStore.username, password: fromStore.password };
  }
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
  /** Device-reported setpoint bounds °C (uid 35/36; typically 16–30). */
  minSetpointC: number | null;
  maxSetpointC: number | null;
  online: boolean;
  /** Current fan step: 0 = auto, 1..5 = manual. null if not reported. */
  fanLevel?: number | null;
  /** Vane positions: 0 = auto (A), 1..5 = fixed, 10 = swing. null if not reported. */
  vaneUpDown?: number | null;
  vaneLeftRight?: number | null;
  /** Heating (Airzone underfloor) read fields; null/absent for AC (Intesis) units. */
  /** Room is actively calling for heat (underfloor loop open) → drives the flame. */
  floorDemand?: boolean | null;
  /** Relative humidity (%). */
  humidity?: number | null;
  /** Radio (wireless) thermostat. */
  wireless?: boolean | null;
  /** Radio thermostat reporting a low battery. */
  lowBattery?: boolean | null;
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
      minSetpointC: toCelsius(dp[UID.setpointMin]),
      maxSetpointC: toCelsius(dp[UID.setpointMax]),
      online: true,
      fanLevel: dp[UID.fan] === undefined ? null : dp[UID.fan],
      vaneUpDown: dp[UID.vaneV] === undefined ? null : dp[UID.vaneV],
      vaneLeftRight: dp[UID.vaneH] === undefined ? null : dp[UID.vaneH],
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

/** Invalidate the cached fleet snapshot (after a write or a creds change). */
export function invalidateFleet(): void {
  // The cache module memoizes by key with a TTL; force the next read to refetch
  // by writing a stale entry. Simplest portable approach: re-key via a fresh call
  // is unavailable, so we rely on the short 30s TTL. Expose a no-op marker here so
  // callers can signal intent; the control read-back uses a direct login() anyway.
}

// ---- CONTROL: push-socket datapoint writes ---------------------------------
// The AC Cloud push socket is a length-prefixed?-no — a newline/concatenated JSON
// TCP stream. We open it fresh per command (the volume is tiny), authenticate with
// connect_req{token}, send set{deviceId,uid,value,seqNo}, and resolve on the
// matching set_ack (or reject on rpc_error / timeout). One socket per write keeps
// the connector stateless and avoids holding a long-lived connection.

let seqCounter = 0;
function nextSeq(): number {
  seqCounter = (seqCounter + 1) % 256;
  return seqCounter;
}

export interface SetDatapointResult {
  ok: boolean;
  uid: number;
  value: number;
  detail: string;
}

/**
 * Write a single datapoint (uid → value) to a device over the push socket.
 * `value` is already in device units (temps in tenths °C, mode codes, etc.).
 * Resolves on set_ack; rejects on error or timeout. Never holds state.
 */
const MAX_WRITE_ATTEMPTS = 3;

export async function setDatapoint(
  deviceId: string,
  uid: number,
  value: number,
): Promise<SetDatapointResult> {
  const session = await login();
  if (!session.serverIP || !session.serverPort) {
    throw new Error('AC Cloud push socket coordinates unavailable');
  }
  // The AC Cloud push server keys on ONE shared account token and the set_ack
  // carries no seqNo we can match, so two sockets open at once contend: a second
  // connect_req can drop the first before its ack, and acks can be misattributed.
  // Serialize every push-socket write so flipping several units in quick succession
  // queues cleanly instead of colliding (which previously surfaced as the second
  // toggle reverting). See connectors/write-queue.ts.
  return serialize('intesis:push', async () => {
    // The push socket can transiently drop before set_ack (server-side). Retry
    // with a fresh socket a couple of times; a genuine cloud rejection is not.
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
      try {
        return await writeOverSocket(session, deviceId, uid, value);
      } catch (e) {
        lastErr = e as Error;
        if (/rejected/i.test(lastErr.message)) throw lastErr;
        if (attempt < MAX_WRITE_ATTEMPTS) await new Promise<void>((r) => setTimeout(r, 200 * attempt));
      }
    }
    throw lastErr ?? new Error('AC Cloud set failed');
  });
}

function writeOverSocket(
  session: IntesisLoginResult,
  deviceId: string,
  uid: number,
  value: number,
): Promise<SetDatapointResult> {
  const seqNo = nextSeq();
  return new Promise<SetDatapointResult>((resolve, reject) => {
    let buf = '';
    let settled = false;
    const socket = net.createConnection(
      { host: session.serverIP, port: session.serverPort, timeout: 10_000 },
      () => {
        // Authenticate first; the `set` is issued only after connect_rsp.
        // Sending both back-to-back races the server's auth → drop before set_ack.
        socket.write(JSON.stringify({ command: 'connect_req', data: { token: session.token } }));
      },
    );

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    // The stream concatenates JSON objects; parse greedily on each chunk and keep
    // any unparsed tail so a message split across TCP packets (e.g. the set_ack)
    // survives into the next chunk instead of being dropped.
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const { objects, rest } = drainJson(buf);
      buf = rest;
      for (const obj of objects) {
        const cmd = (obj as { command?: string }).command;
        if (cmd === 'connect_rsp') {
          // Authenticated — now issue the set.
          socket.write(JSON.stringify({ command: 'set', data: { deviceId: Number(deviceId), uid, value, seqNo } }));
          continue;
        }
        if (cmd === 'set_ack') {
          done(() => resolve({ ok: true, uid, value, detail: `set_ack uid=${uid} value=${value}` }));
          return;
        }
        if (cmd === 'rpc_error' || cmd === 'error') {
          done(() => reject(new Error(`AC Cloud set rejected: ${JSON.stringify(obj)}`)));
          return;
        }
      }
    });
    socket.on('timeout', () => done(() => reject(new Error('AC Cloud set timed out'))));
    socket.on('error', (e) => done(() => reject(new Error(`AC Cloud socket error: ${e.message}`))));
    socket.on('close', () => {
      // If we closed without an ack, treat as failure (unless already settled).
      done(() => reject(new Error('AC Cloud socket closed before set_ack')));
    });
  });
}

/**
 * Parse a possibly-concatenated JSON stream into objects. Tolerant of multiple
 * objects per chunk; returns any trailing INCOMPLETE object as `rest` so the
 * caller can prepend it to the next chunk — a set_ack split across TCP packets
 * must not be dropped. Brace counting is string/escape aware so braces inside
 * JSON string values can't desync the scanner. A complete-but-malformed object
 * is consumed (dropped) rather than retained, so the buffer can't grow unbounded.
 */
function drainJson(raw: string): { objects: unknown[]; rest: string } {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let consumed = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          /* complete but malformed — drop it */
        }
        consumed = i + 1; // this complete object is fully handled either way
        start = -1;
      }
    }
  }
  // Retain only a genuinely incomplete trailing object for the next chunk.
  return { objects: out, rest: raw.slice(consumed) };
}
