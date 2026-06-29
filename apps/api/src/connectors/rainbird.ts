// Rain Bird irrigation connector — an ESP-TM2 controller with an LNK / LNK2 WiFi
// module on the home LAN (Spain). The mini reaches it directly, same LAN-local
// pattern as the Airzone connector. The local SIP protocol is reverse-engineered;
// the reference is pyrainbird (github.com/allenporter/pyrainbird). The wire crypto,
// opcode table, and HTTP transport live under ./rainbird/.
//
// Hardware: LNK module default IP 192.168.1.159 (owner-confirmed). The host is
// configurable; the PASSWORD is required to talk to the box and is NEVER hardcoded.
//
// The LNK accepts ONE request at a time — the transport serializes all calls; this
// connector adds a ~10s read cache (like airzone) so the Devices poll stays cheap.

import { cached, invalidate } from "../cache";
import * as store from "../store";
import { tunnelSip } from "./rainbird/transport";
import {
  encode,
  decodeModelAndVersion,
  decodeStations,
  decodeIrrigationState,
  decodeRainDelay,
  decodeSerialNumber,
  type ModelAndVersion,
} from "./rainbird/sip";

/** Owner-confirmed LNK module IP. Onboarding then only needs the password. */
const DEFAULT_HOST = "192.168.1.159";

/** Host: Settings store → env → known default (read defensively in case the store
 *  type predates the `rainbird` integration field). */
export function host(): string {
  const integrations = store.get().integrations as {
    rainbird?: { host?: string; password?: string } | null;
  };
  const fromStore = integrations.rainbird?.host?.trim();
  return fromStore || process.env.RAINBIRD_HOST || DEFAULT_HOST;
}

/** Password: Settings store → env → none. Required — there is no safe default. */
export function password(): string {
  const integrations = store.get().integrations as {
    rainbird?: { host?: string; password?: string } | null;
  };
  const fromStore = integrations.rainbird?.password;
  return (fromStore || process.env.RAINBIRD_PASSWORD || "").trim();
}

/** Configured ONLY when BOTH a host (default present) AND a password are set. A host
 *  alone is never enough — without the password we cannot talk to the controller, so
 *  the integration must stay fully inert (empty fleet, no probes). */
export function isConfigured(): boolean {
  return Boolean(host()) && Boolean(password());
}

/** One SIP round-trip with the resolved host/password. Throws if not configured. */
async function sip(
  cmd: Parameters<typeof encode>[0],
  args: number[] = [],
): Promise<string> {
  if (!isConfigured())
    throw new Error("Rain Bird not configured (host + password required)");
  return tunnelSip(host(), password(), encode(cmd, args));
}

// ---- Normalized shape -------------------------------------------------------

/** A normalized irrigation zone (station), mirroring the AirzoneZone shape so it
 *  merges cleanly into the Devices fleet. id = `rb-<station>` (1-based station no.). */
export interface IrrigationZone {
  id: string;
  name: string;
  /** 1-based station/valve number on the controller. */
  station: number;
  /** Currently watering (this station's valve is open). */
  active: boolean;
  /** Wired/available on the controller (reported by AvailableStations). */
  available: boolean;
}

export interface IrrigationInfo {
  model: ModelAndVersion;
  serialNumber: string;
}

// ---- Reads (cached ~10s like airzone) ---------------------------------------

/** All available zones with their live active/idle state. The LNK is single-request,
 *  so these two reads run sequentially through the transport mutex. */
export async function getZones(): Promise<IrrigationZone[]> {
  if (!isConfigured()) return [];
  return cached("rainbird.zones", 10_000, async () => {
    const available = decodeStations(await sip("AvailableStations", [0]));
    const active = decodeStations(await sip("CurrentStationsActive", [0]));
    const activeSet = new Set(active.stations);
    return available.stations.map((station) => ({
      id: `rb-${station}`,
      name: `Zone ${station}`,
      station,
      active: activeSet.has(station),
      available: true,
    }));
  });
}

/** The first currently-active zone, or null when nothing is watering. */
export async function getActiveZone(): Promise<IrrigationZone | null> {
  const zones = await getZones();
  return zones.find((z) => z.active) ?? null;
}

/** Whether the irrigation system reports itself as currently running (any valve). */
export async function getIrrigationState(): Promise<boolean> {
  if (!isConfigured()) return false;
  return cached("rainbird.state", 10_000, async () =>
    decodeIrrigationState(await sip("CurrentIrrigationState")),
  );
}

/** Controller model/version + serial (for the integration status panel / probe). */
export async function getInfo(): Promise<IrrigationInfo> {
  const model = decodeModelAndVersion(await sip("ModelAndVersion"));
  const serialNumber = decodeSerialNumber(await sip("SerialNumber"));
  return { model, serialNumber };
}

/** Rain-delay days currently set on the controller (0 = none). */
export async function getRainDelay(): Promise<number> {
  if (!isConfigured()) return 0;
  return cached("rainbird.raindelay", 10_000, async () =>
    decodeRainDelay(await sip("RainDelayGet")),
  );
}

// ---- Writes -----------------------------------------------------------------
// These actuate water hardware. The arm/admin gate lives in the route layer
// (control/irrigation-execute.ts) — this connector just talks to the box.

/** Invalidate cached reads after a write so the next poll reflects reality immediately. */
function bustReadCache(): void {
  invalidate("rainbird.zones");
  invalidate("rainbird.state");
  invalidate("rainbird.raindelay");
}

/** Start watering station N (from `rb-<n>`) for `minutes`. Returns nothing; callers
 *  read back via getActiveZone(). Minutes are clamped to the protocol's 1..2 byte range. */
export async function startZone(id: string, minutes: number): Promise<void> {
  const station = stationFromId(id);
  const mins = Math.max(1, Math.min(0xffff, Math.round(minutes)));
  await sip("ManuallyRunStation", [station, mins]);
  bustReadCache();
}

/** Stop ALL irrigation immediately (StopIrrigation). */
export async function stopAll(): Promise<void> {
  await sip("StopIrrigation");
  bustReadCache();
}

/** Set the controller rain-delay to `days` (0 clears it). Clamped to a 2-byte field. */
export async function setRainDelay(days: number): Promise<void> {
  const d = Math.max(0, Math.min(0xffff, Math.round(days)));
  await sip("RainDelaySet", [d]);
  bustReadCache();
}

/** Parse the 1-based station number out of an `rb-<n>` device id. */
export function stationFromId(id: string): number {
  const m = /^rb-(\d+)$/.exec(id);
  if (!m) throw new Error(`Rain Bird bad device id: ${id}`);
  return Number(m[1]);
}
