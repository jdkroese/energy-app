// Irrigation HTTP surface (Rain Bird). Reads are any-authed; commands + the
// integration probe/connect are admin-gated at the route in index.ts. Everything
// degrades gracefully when Rain Bird is not connected (empty zones / not connected).
//
// Irrigation zones ALSO merge into /api/devices as type 'irrigation' (see
// routes/devices.ts), so they appear in the unified fleet; this dedicated surface
// drives the Irrigation screen's run/stop/rain-delay levers (which the climate
// command path can't express).

import * as rainbird from "../connectors/rainbird";
import * as store from "../store";
import { resolveRoomId } from "../rooms";
import {
  issueIrrigation,
  type IrrigationLever,
} from "../control/irrigation-execute";

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = "BAD_INPUT";
  return e;
}

/** A zone enriched with its assigned room (cross-cutting Rooms model). */
export interface IrrigationZoneView extends rainbird.IrrigationZone {
  roomId: string | null;
  roomName: string | null;
}

function viewZone(z: rainbird.IrrigationZone): IrrigationZoneView {
  const roomId = resolveRoomId(z.id);
  const roomName = roomId ? (store.get().rooms[roomId]?.name ?? null) : null;
  // Honor a user display-name override (deviceSettings[id].name), like lights.
  const name = store.get().deviceSettings[z.id]?.name ?? z.name;
  return { ...z, name, roomId, roomName };
}

/** Turn an opaque transport error into something diagnosable. Node's `fetch` collapses
 *  every network failure to "fetch failed" and hides the real reason in `error.cause.code`
 *  — which is exactly what we need to tell "wrong IP / isolated WiFi" (EHOSTUNREACH) from
 *  "nothing listening on the Rain Bird port" (ECONNREFUSED) from "box asleep" (timeout).
 *  Non-network errors (wrong password, HTTP status, SIP error) pass through unchanged. */
function describeReachError(e: unknown, host: string): string {
  const err = e as {
    name?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  if (err?.name === "TimeoutError" || err?.name === "AbortError")
    return `no response from ${host} within timeout — controller asleep/off, wrong IP, or WiFi client-isolation blocking the mini`;
  switch (err?.cause?.code) {
    case "ECONNREFUSED":
      return `connection refused at ${host} — something is at this IP but not answering on the Rain Bird port (wrong device at this IP, or the LNK web service is off)`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `${host} unreachable — the mini can't route to it (LNK on a different subnet / isolated IoT-WiFi, or wrong IP)`;
    case "ETIMEDOUT":
      return `timed out reaching ${host} — no reply (LNK off/asleep, wrong IP, or WiFi client-isolation)`;
    case "ENOTFOUND":
      return `${host} did not resolve — check the host/IP`;
    case "ECONNRESET":
      return `${host} reset the connection — often the Rain Bird mobile app is open and holding the single allowed connection`;
  }
  return err?.cause?.message || err?.message || "unreachable";
}

/** GET /api/irrigation — zones + controller state. Inert (empty) when not connected. */
export async function getIrrigation(): Promise<unknown> {
  const dev = store.get().devices;
  const connected = rainbird.isConfigured();
  if (!connected) {
    return {
      ts: new Date().toISOString(),
      connected: false,
      armed: dev.armed,
      mode: dev.mode,
      zones: [],
      activeStationId: null,
      rainDelayDays: 0,
      running: false,
      lastError: null,
    };
  }
  let zones: IrrigationZoneView[] = [];
  let rainDelayDays = 0;
  let running = false;
  let error: string | null = null;
  try {
    zones = (await rainbird.getZones()).map(viewZone);
    rainDelayDays = await rainbird.getRainDelay();
    running = await rainbird.getIrrigationState();
  } catch (e) {
    error = describeReachError(e, rainbird.host());
  }
  return {
    ts: new Date().toISOString(),
    connected: true,
    armed: dev.armed,
    mode: dev.mode,
    zones,
    activeStationId: zones.find((z) => z.active)?.id ?? null,
    rainDelayDays,
    running,
    lastError: error,
  };
}

/** GET /api/irrigation/:id — single zone detail. */
export async function getIrrigationZone(id: string): Promise<unknown> {
  if (!rainbird.isConfigured())
    return { ts: new Date().toISOString(), connected: false, zone: null };
  try {
    const zones = (await rainbird.getZones()).map(viewZone);
    const zone = zones.find((z) => z.id === id) ?? null;
    const rainDelayDays = await rainbird.getRainDelay();
    return { ts: new Date().toISOString(), connected: true, zone, rainDelayDays };
  } catch (e) {
    // Don't 500 the detail poll when the box is unreachable — degrade with the reason.
    return {
      ts: new Date().toISOString(),
      connected: true,
      zone: null,
      rainDelayDays: 0,
      lastError: describeReachError(e, rainbird.host()),
    };
  }
}

// ---- Commands (admin + arm) -------------------------------------------------

const LEVERS: IrrigationLever[] = ["run", "stop", "rainDelay"];

/** POST /api/irrigation/:id/command — { lever, value }. Arm-gated in issueIrrigation. */
export async function commandIrrigation(
  id: string,
  lever: IrrigationLever,
  rawValue: unknown,
): Promise<unknown> {
  if (!LEVERS.includes(lever))
    throw badInput(`lever must be one of ${LEVERS.join("|")}`);
  if (!rainbird.isConfigured()) throw badInput("Rain Bird not connected");
  const value = lever === "stop" ? 0 : Number(rawValue);
  if (lever !== "stop" && !Number.isFinite(value))
    throw badInput("value must be a number");
  const result = await issueIrrigation(id, lever, value, "manual command");
  return { ts: new Date().toISOString(), result };
}

// ---- Per-zone settings (room + name) ----------------------------------------

/** PUT /api/irrigation/:id/settings — assign a room and/or rename a zone. */
export function setIrrigationSettings(
  id: string,
  patch: { roomId?: string | null; name?: string },
): unknown {
  const saved = store.update((s) => {
    const existing = s.deviceSettings[id] ?? {};
    const merged = {
      ...existing,
      roomId: patch.roomId !== undefined ? patch.roomId : existing.roomId,
      name: patch.name !== undefined ? patch.name : existing.name,
    };
    s.deviceSettings[id] = merged;
    return merged;
  });
  return { ts: new Date().toISOString(), id, settings: saved };
}

// ---- Integration probe + connect --------------------------------------------

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** GET /api/integrations/rainbird — effective config + live status (never leaks password). */
export async function getRainbirdIntegration(): Promise<unknown> {
  const i = store.get().integrations as {
    rainbird?: { host?: string; password?: string } | null;
  };
  const connected = rainbird.isConfigured();
  let status: ProbeResult | null = null;
  let info: { model: string; version: string; serialNumber: string } | null =
    null;
  if (connected) {
    try {
      const got = await rainbird.getInfo();
      info = {
        model: String(got.model.modelId),
        version: got.model.version,
        serialNumber: got.serialNumber,
      };
      status = { ok: true, detail: `model ${info.model} · v${info.version}` };
    } catch (e) {
      status = { ok: false, detail: describeReachError(e, rainbird.host()) };
    }
  }
  return {
    ts: new Date().toISOString(),
    connected,
    host: rainbird.host(),
    hasPassword:
      Boolean(i?.rainbird?.password) || Boolean(process.env.RAINBIRD_PASSWORD),
    overridden: Boolean(i?.rainbird?.host || i?.rainbird?.password),
    status,
    info,
  };
}

const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/i;

/** Probe a candidate host+password WITHOUT persisting — getInfo round-trips the box. */
async function probeRainbird(
  host: string,
  password: string,
): Promise<ProbeResult> {
  try {
    const { tunnelSip } = await import("../connectors/rainbird/transport");
    const { encode, decodeModelAndVersion } =
      await import("../connectors/rainbird/sip");
    const hex = await tunnelSip(host, password, encode("ModelAndVersion"));
    const model = decodeModelAndVersion(hex);
    return { ok: true, detail: `model ${model.modelId} · v${model.version}` };
  } catch (e) {
    return { ok: false, detail: describeReachError(e, host) };
  }
}

/** POST /api/integrations/rainbird/test — probe without persisting (uses stored
 *  password when the body omits it, so a re-test of a saved box needs no re-entry). */
export async function testRainbird(
  hostRaw?: unknown,
  passwordRaw?: unknown,
): Promise<ProbeResult> {
  const host = String(hostRaw ?? rainbird.host()).trim();
  const password = passwordRaw ? String(passwordRaw) : rainbird.password();
  if (!host) throw badInput("host required");
  if (!password) throw badInput("password required");
  return probeRainbird(host, password);
}

/** PUT /api/integrations/rainbird — persist the host+password, then probe.
 *  The probe is ADVISORY, not a gate: a transient miss or a protocol-decode quirk
 *  against the real box must never lock the owner out of saving the correct host
 *  (use Test for an explicit connectivity check). We still validate the host format
 *  and require a password. */
export async function setRainbird(
  hostRaw?: unknown,
  passwordRaw?: unknown,
): Promise<unknown> {
  const host = String(hostRaw ?? "").trim();
  if (!host || !HOST_RE.test(host))
    throw badInput("Enter a valid host/IP (e.g. 192.168.1.158)");
  // Allow keeping the stored password when the form leaves it blank (edit host only).
  const password = passwordRaw ? String(passwordRaw) : rainbird.password();
  if (!password) throw badInput("Enter the Rain Bird controller password");
  // Persist FIRST so a failing probe can't block changing the host.
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.rainbird = { host, password };
  });
  // Probe for feedback only — report reachability without throwing.
  const probe = await probeRainbird(host, password);
  return {
    ts: new Date().toISOString(),
    ok: probe.ok,
    detail: probe.ok
      ? probe.detail
      : `Saved ${host}, but couldn't reach it yet — ${probe.detail}`,
    config: await getRainbirdIntegration(),
  };
}

/** DELETE /api/integrations/rainbird — disconnect (clear stored host+password). */
export function disconnectRainbird(): unknown {
  store.update((s) => {
    if (s.integrations) s.integrations.rainbird = null;
  });
  return { ts: new Date().toISOString(), connected: false };
}
