// Airzone connector — underfloor heating, per-room, via the **Local API** (REST on
// the home LAN). The mini reaches the Airzone webserver/Aidoo directly, so there is
// no cloud dependency or auth (the Local API is LAN-trusted). Mirrors the shape of
// `intesis.ts` so Airzone rooms merge into the same Devices fleet.
//
// Validated live 2026-06-25 against the real system (webserver 192.168.1.165:3000,
// ws_firmware 4.08, Local API v1.71): 1 system, 6 zones (Living room, Kitchen,
// Master bed, Guest down, Office, Guest up). Read + write both confirmed.
//
// API (http://<host>:3000/api/v1/...):
//  - READ  : POST /hvac {"systemID":0,"zoneID":0} -> {systems:[{data:[zone,...]}]}.
//            A single-zone query {"systemID":s,"zoneID":z} returns {data:[zone]}.
//  - WRITE : PUT /hvac {"systemID":s,"zoneID":z, setpoint|on|mode|speed|sleep}
//            -> 200 {data:[{...changed fields}]}. `mode` is PER-ZONE (apply on the
//            target zoneID, like power/setpoint — user-confirmed 2026-06-26). Temps
//            are whole °C with 0.5° steps (NOT tenths).
//  - INFO  : POST /webserver, POST /version.

import { cached, invalidate } from '../cache';
import * as store from '../store';
import { serialize } from './write-queue';

const DEFAULT_HOST = '192.168.1.165';
const PORT = 3000;

/** Host comes from the in-app Settings store first, then env, then the known default.
 *  Read defensively so the connector compiles whether or not the store type has an
 *  `airzone` integration field yet. */
function host(): string {
  const integrations = store.get().integrations as { airzone?: { host?: string } | null };
  const fromStore = integrations.airzone?.host;
  return fromStore || process.env.AIRZONE_HOST || DEFAULT_HOST;
}

/** Airzone is "configured" once we have a host (default present) — control stays gated
 *  behind the Devices arm/admin model regardless. */
export function isConfigured(): boolean {
  return Boolean(host());
}

const base = () => `http://${host()}:${PORT}/api/v1`;

// Airzone modes (per-zone; reported and written per zone).
export const MODE: Record<number, string> = { 1: 'stop', 2: 'cool', 3: 'heat', 4: 'fan', 5: 'dry', 7: 'auto' };
export const MODE_VALUE: Record<string, number> = { stop: 1, cool: 2, heat: 3, fan: 4, dry: 5, auto: 7 };

// ---- Raw API types (loosely typed; validated live) --------------------------

interface RawZone {
  systemID: number;
  zoneID: number;
  name?: string;
  on?: number;
  roomTemp?: number;
  setpoint?: number;
  minTemp?: number;
  maxTemp?: number;
  temp_step?: number;
  mode?: number;
  modes?: number[];
  humidity?: number;
  air_demand?: number;
  floor_demand?: number;
  units?: number; // 0=°C, 1=°F
  thermos_radio?: number; // 1 = wireless thermostat
  battery?: string | number;
  errors?: unknown[];
  speed?: number;
}

interface RawHvac {
  systems?: Array<{ data?: RawZone[] }>;
  data?: RawZone[];
  errors?: unknown[];
}

async function api(method: 'POST' | 'PUT', path: string, body: unknown): Promise<RawHvac> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Airzone ${method} ${path} -> HTTP ${res.status}`);
  return (await res.json()) as RawHvac;
}

/** Both response shapes ({systems:[{data}]} for all, {data} for one zone) -> flat zones. */
function flattenZones(raw: RawHvac): RawZone[] {
  if (Array.isArray(raw.systems)) return raw.systems.flatMap((s) => s.data ?? []);
  return raw.data ?? [];
}

// ---- Normalized shapes ------------------------------------------------------

/** Airzone-native zone (richer than the generic ClimateUnit; for the detail view). */
export interface AirzoneZone {
  id: string; // `air-<system>-<zone>`
  systemID: number;
  zoneID: number;
  name: string;
  on: boolean;
  mode: string; // per-zone mode
  availableModes: string[];
  roomTempC: number | null;
  setpointC: number | null;
  minSetpointC: number;
  maxSetpointC: number;
  step: number;
  humidity: number | null;
  /** The room is actively calling for heat (underfloor loop open). */
  floorDemand: boolean;
  airDemand: boolean;
  wireless: boolean;
  lowBattery: boolean;
  errors: unknown[];
}

function normalizeZone(z: RawZone): AirzoneZone {
  return {
    id: `air-${z.systemID}-${z.zoneID}`,
    systemID: z.systemID,
    zoneID: z.zoneID,
    name: z.name ?? `Zone ${z.zoneID}`,
    on: z.on === 1,
    mode: MODE[z.mode ?? -1] ?? 'unknown',
    availableModes: (z.modes ?? []).map((m) => MODE[m] ?? String(m)),
    roomTempC: z.roomTemp ?? null,
    setpointC: z.setpoint ?? null,
    minSetpointC: z.minTemp ?? 15,
    maxSetpointC: z.maxTemp ?? 30,
    step: z.temp_step && z.temp_step > 0 ? z.temp_step : 0.5,
    humidity: z.humidity ? z.humidity : null,
    floorDemand: z.floor_demand === 1,
    airDemand: z.air_demand === 1,
    wireless: z.thermos_radio === 1,
    lowBattery: typeof z.battery === 'string' ? /low/i.test(z.battery) : false,
    errors: z.errors ?? [],
  };
}

/**
 * Generic ClimateUnit shape (kept structurally compatible with `intesis.ts` so the
 * Devices fleet aggregator can merge AC + underfloor without special-casing).
 */
export interface ClimateUnit {
  id: string;
  name: string;
  zone?: string;
  installation?: string;
  power: boolean;
  mode: string;
  setpointC: number | null;
  currentTempC: number | null;
  minSetpointC: number | null;
  maxSetpointC: number | null;
  online: boolean;
  /** Heating (Airzone) read fields surfaced through to the Devices view. */
  floorDemand?: boolean | null;
  humidity?: number | null;
  wireless?: boolean | null;
  lowBattery?: boolean | null;
}

export function toClimateUnit(z: AirzoneZone): ClimateUnit {
  return {
    id: z.id,
    name: z.name,
    zone: z.name,
    installation: 'Airzone',
    power: z.on,
    mode: z.mode,
    setpointC: z.setpointC,
    currentTempC: z.roomTempC,
    minSetpointC: z.minSetpointC,
    maxSetpointC: z.maxSetpointC,
    online: true,
    floorDemand: z.floorDemand,
    humidity: z.humidity,
    wireless: z.wireless,
    lowBattery: z.lowBattery,
  };
}

// ---- Reads ------------------------------------------------------------------

/** All zones as Airzone-native records (cached 10s to keep polling cheap). */
export async function getZones(): Promise<AirzoneZone[]> {
  if (!isConfigured()) return [];
  return cached('airzone.zones', 10_000, async () =>
    flattenZones(await api('POST', '/hvac', { systemID: 0, zoneID: 0 })).map(normalizeZone),
  );
}

/** Drop the cached zones so the next read reflects a write immediately (not after TTL). */
export function invalidateFleet(): void {
  invalidate('airzone.zones');
}

/** Fleet as generic ClimateUnits, for merging into /api/devices. */
export async function getFleet(): Promise<ClimateUnit[]> {
  return (await getZones()).map(toClimateUnit);
}

/** Webserver info (mac, firmware, wifi, type) — for the integration status panel. */
export async function getInfo(): Promise<Record<string, unknown>> {
  const res = await fetch(`${base()}/webserver`, {
    method: 'POST',
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Airzone webserver -> HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

// ---- Control ----------------------------------------------------------------

export type AirzoneLever = 'power' | 'setpoint' | 'mode';

export interface AirzoneSetResult {
  ok: boolean;
  zone: AirzoneZone;
  detail: string;
}

/**
 * Write one lever to a zone and read the result back (the Devices guardrail layer
 * does the clamping; this just talks to the box). `id` is `air-<system>-<zone>`.
 *  - power: boolean -> {"on":0|1}
 *  - setpoint: °C (caller clamps to min/max & 0.5° step) -> {"setpoint":N}
 *  - mode: string (heat|cool|fan|stop|dry|auto) -> {"mode":N} (per-zone, written on
 *    the target zoneID — same as power/setpoint)
 */
export async function setLever(
  id: string,
  lever: AirzoneLever,
  value: boolean | number | string,
): Promise<AirzoneSetResult> {
  const m = /^air-(\d+)-(\d+)$/.exec(id);
  if (!m) throw new Error(`Airzone bad device id: ${id}`);
  const systemID = Number(m[1]);
  const zoneID = Number(m[2]);

  const patch: Record<string, number> = { systemID, zoneID };
  if (lever === 'power') patch.on = value ? 1 : 0;
  else if (lever === 'setpoint') patch.setpoint = Number(value);
  else if (lever === 'mode') {
    const code = MODE_VALUE[String(value)];
    if (!code) throw new Error(`Airzone unknown mode: ${value}`);
    patch.mode = code;
  }

  // The underfloor controller is a small embedded webserver that mishandles
  // overlapping requests, so serialize writes: flipping several zones off at once
  // queues one-at-a-time instead of racing (which surfaced as a toggle reverting).
  // The PUT and its authoritative read-back stay together inside the critical
  // section so no other write interleaves between them. See write-queue.ts.
  return serialize('airzone', async () => {
    await api('PUT', '/hvac', patch);
    // Read the zone back so callers get authoritative post-write state.
    const back = flattenZones(await api('POST', '/hvac', { systemID, zoneID })).map(normalizeZone)[0];
    return { ok: true, zone: back, detail: `${lever}=${String(value)} on ${id}` };
  });
}
