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
  appRunRemainingMs,
  appRunActiveZoneIds,
  type IrrigationLever,
} from "../control/irrigation-execute";
import * as weather from "../connectors/weather";
import {
  computeTrims,
  scheduledMinForDay,
  liveAllowed,
  getDailyOutlookCached,
  nextRunSkipDecision,
  isSuppressingOnboard,
} from "../control/irrigation-coordinator";
import {
  rollupDayWeather,
  flowLpmFor,
  kcFor,
  daySavedPct,
  type DayWeather,
} from "../control/irrigation-engine";
import { savePhoto, readPhoto, deletePhoto } from "../irrigation/photos";
import { randomBytes } from "node:crypto";
import type {
  IrrigationMode,
  IrrigationZoneConfig,
  IrrigationWateringTime,
  IrrigationPlantType,
  IrrigationEmitterType,
  IrrigationManagedBy,
  IrrigationSkipDecision,
} from "../store";

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

/** GET /api/irrigation/active — a LIGHT poll for the global nav indicator: just the zones
 *  currently watering (physical active OR an in-flight app-initiated run) with time remaining.
 *  Cheap (getZones is ~10s-cached) and degrades to the app-run windows if the box is unreachable. */
export async function getIrrigationActive(): Promise<unknown> {
  const ts = new Date().toISOString();
  if (!rainbird.isConfigured()) return { ts, connected: false, active: [] };
  let stations: rainbird.IrrigationZone[] = [];
  try {
    stations = await rainbird.getZones();
  } catch {
    /* unreachable — still surface app-initiated runs below */
  }
  const byId = new Map(stations.map((z) => [z.id, z]));
  const ids = new Set<string>();
  for (const z of stations) if (z.active) ids.add(z.id);
  for (const id of appRunActiveZoneIds()) ids.add(id);
  const settings = store.get().deviceSettings;
  const active = [...ids]
    .map((id) => {
      const st = byId.get(id);
      const station = st?.station ?? (Number(id.replace("rb-", "")) || 0);
      const remMs = appRunRemainingMs(id);
      return {
        zoneId: id,
        name: settings[id]?.name ?? st?.name ?? `Zone ${station}`,
        station,
        remainingMin: remMs > 0 ? Math.ceil(remMs / 60_000) : null,
      };
    })
    .sort((a, b) => a.station - b.station);
  return { ts, connected: true, active };
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
  /** When a direct probe fails but a LAN scan locates the controller elsewhere,
   *  the IP it was actually found at — the UI offers to switch the host to this. */
  suggestedHost?: string;
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
  const probe = await probeRainbird(host, password);
  if (probe.ok) return probe;

  // Retry a couple times — the LNK serves ONE connection at a time and can be
  // briefly busy/intermittent (refused now ≠ gone). ECONNREFUSED returns fast, so
  // these retries cost little.
  for (let i = 0; i < 2; i++) {
    const retry = await probeRainbird(host, password);
    if (retry.ok) return retry;
  }

  try {
    // Is the host up on some OTHER port? Distinguishes "local API not on 80" from
    // "the LNK web server is down".
    const openPorts = await rainbird.probeHostPorts(host);
    if (openPorts.length && !openPorts.includes(80)) {
      return {
        ok: false,
        detail: `${probe.detail}. ${host} is up with open port(s) ${openPorts.join(", ")} but not 80 — the LNK's local API may be on a non-standard port.`,
      };
    }

    // IP may be wrong — sweep the /24 for the real controller.
    const found = await rainbird.discoverOnLan(password, host);
    if (found && found.host !== host) {
      return {
        ok: false,
        detail: `${probe.detail}. But I found a Rain Bird at ${found.host} (model ${found.model.modelId} · v${found.model.version}) — switch the host to ${found.host} and Save.`,
        suggestedHost: found.host,
      };
    }

    // Online but no usable port / handshake → the LNK's local API isn't answering.
    return {
      ok: false,
      detail: `${probe.detail}. ${host} is online but its Rain Bird local API isn't answering on port 80${openPorts.length ? ` (open ports: ${openPorts.join(", ")})` : " (no common web port open)"} — power-cycle the controller/LNK and fully close the Rain Bird app, then Test again.`,
    };
  } catch {
    // Best-effort diagnostics — fall back to the direct probe result.
  }
  return probe;
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

// ===========================================================================
// Phase 2 — smart watering plan (zones config, schedules, ET trim, mode, photos).
// The APP owns the optimized plan; the coordinator actuates it ONLY in mode 'live'
// + armed (dead-man's-switch suppression of the controller's onboard program). All
// of this is additive and inert when Rain Bird is unconfigured.
// ===========================================================================

const PLANT_TYPES: IrrigationPlantType[] = [
  "lawn",
  "shrubs",
  "flowers",
  "vegetables",
  "trees",
  "groundcover",
  "succulents",
  "hedge",
];
const EMITTER_TYPES: IrrigationEmitterType[] = [
  "spray",
  "rotor",
  "drip",
  "bubbler",
  "soaker",
];
const MODES: IrrigationMode[] = ["off", "live"];

/** A zone config enriched with the LIVE station view + derived plan figures for the UI. */
export interface IrrigationPlanZone {
  zoneId: string;
  name: string;
  station: number;
  available: boolean;
  active: boolean;
  /** Minutes left in the app-initiated run (Water-now / scheduled fire), or null. */
  runningRemainingMin: number | null;
  plantType: IrrigationPlantType;
  emitterType: IrrigationEmitterType;
  flowLpm: number; // effective (override or emitter default)
  kc: number; // effective
  areaM2: number | null;
  sunExposure: number | null;
  managedBy: IrrigationManagedBy;
  heatTopupEnabled: boolean;
  rainSkipMm: number | null;
  photoId: string | null;
  photoUrl: string | null;
  wateringTimes: IrrigationWateringTime[];
  deficitMm: number;
  /** Today's scheduled (ceiling) minutes for this zone. */
  scheduledMinToday: number;
  /** Weather-trimmed minutes the coordinator would run today. */
  trimmedMinToday: number;
  savedPctToday: number;
  /** ≈ litres for the trimmed run today. */
  litersToday: number;
  trimReasons: string[];
  nextRun: { startTime: string; weekday: number } | null;
  /** The 2h-ahead rain-bypass decision for this zone's soonest upcoming run, if one exists. */
  nextRunSkip: {
    decision: "skip" | "run";
    reason: string;
    rainMm: number;
    probabilityPct: number;
  } | null;
}

function photoUrl(photoId: string | undefined): string | null {
  return photoId
    ? `/api/irrigation/photos/${encodeURIComponent(photoId)}`
    : null;
}

/** Project a stored skip decision to the plan-response shape (drops the internal key/ts). */
function skipView(
  d: IrrigationSkipDecision | null,
): IrrigationPlanZone["nextRunSkip"] {
  return d
    ? {
        decision: d.decision,
        reason: d.reason,
        rainMm: d.rainMm,
        probabilityPct: d.probabilityPct,
      }
    : null;
}

/** Find the next watering time (start) for a zone, scanning the next 7 days. */
function nextRunFor(
  zone: IrrigationZoneConfig,
): { startTime: string; weekday: number } | null {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (let d = 0; d < 7; d++) {
    const weekday = (now.getDay() + d) % 7;
    const times = zone.wateringTimes
      .filter((w) => w.days[weekday])
      .map((w) => ({ w, min: hhmm(w.startTime) }))
      .filter(({ min }) => d > 0 || min > nowMin)
      .sort((a, b) => a.min - b.min);
    if (times.length) return { startTime: times[0].w.startTime, weekday };
  }
  return null;
}

function hhmm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Roll the (cached-ish) forecast into the day-weather the engine reasons about. */
async function dayWeather(): Promise<{ day: DayWeather; ok: boolean }> {
  const wf = await weather.getForecast();
  if (!wf)
    return {
      day: { et0Mm: 0, precipMm: 0, precipProbabilityPct: 0, peakHourEt0Mm: 0 },
      ok: false,
    };
  return { day: rollupDayWeather(wf), ok: true };
}

/** GET /api/irrigation/plan — the full Phase-2 plan: mode, global rules, per-zone config +
 *  live state + today's ET trim, weather rollup, drift flag, header stats, and the log. */
export async function getIrrigationPlan(): Promise<unknown> {
  const s = store.get();
  const irr = s.irrigation;
  const connected = rainbird.isConfigured();

  // Live station view (best-effort; empty when not connected/unreachable).
  let stations: rainbird.IrrigationZone[] = [];
  let liveError: string | null = null;
  if (connected) {
    try {
      stations = await rainbird.getZones();
    } catch (e) {
      liveError = (e as Error).message;
    }
  }
  const stationById = new Map(stations.map((z) => [z.id, z]));

  const { day, ok: weatherOk } = await dayWeather();
  const outlook = await getDailyOutlookCached();
  const weekday = new Date().getDay();
  const trims = computeTrims(irr, weekday, day);
  const trimById = new Map(trims.map((t) => [t.zoneId, t]));

  // Seed a zone for EVERY station the controller reports (so all stations show up
  // immediately on first connect, ready to name/photo/schedule), merging any saved
  // per-zone config on top. Union with configured zones so a saved zone still renders
  // even if its station momentarily drops from the live read. Falls back to configured
  // zones alone when not connected/unreachable.
  const zoneIds = Array.from(
    new Set([...stations.map((st) => st.id), ...Object.keys(irr.zones)]),
  );
  const zones: IrrigationPlanZone[] = zoneIds
    .map((zoneId): IrrigationPlanZone => {
      const z = irr.zones[zoneId] ?? defaultZoneConfig(zoneId);
      const st = stationById.get(z.zoneId);
      const trim = trimById.get(z.zoneId);
      const scheduled = scheduledMinForDay(z, weekday);
      // "Watering now" = the controller reports the station active OR the app itself started a
      // run that should still be going (covers manual Water-now + scheduled fires even when the
      // LNK's active-station register doesn't reflect a manual ManuallyRunStation run).
      const appRemMs = appRunRemainingMs(z.zoneId);
      const active = (st?.active ?? false) || appRemMs > 0;
      return {
        zoneId: z.zoneId,
        name: z.name,
        station: st?.station ?? (Number(z.zoneId.replace("rb-", "")) || 0),
        available: st?.available ?? false,
        active,
        runningRemainingMin: appRemMs > 0 ? Math.ceil(appRemMs / 60_000) : null,
        plantType: z.plantType,
        emitterType: z.emitterType,
        flowLpm: flowLpmFor(z),
        kc: kcFor(z),
        areaM2: z.areaM2 ?? null,
        sunExposure: z.sunExposure ?? null,
        managedBy: z.managedBy,
        heatTopupEnabled: z.heatTopupEnabled,
        rainSkipMm: z.rainSkipMm ?? null,
        photoId: z.photoId ?? null,
        photoUrl: photoUrl(z.photoId),
        wateringTimes: z.wateringTimes,
        deficitMm: irr.deficits[z.zoneId]?.mm ?? 0,
        scheduledMinToday: scheduled,
        trimmedMinToday: trim?.trimmedMin ?? scheduled,
        savedPctToday: trim?.savedPct ?? 0,
        litersToday: trim?.volumeL ?? 0,
        trimReasons: trim?.reasons ?? [],
        nextRun: nextRunFor(z),
        nextRunSkip: skipView(nextRunSkipDecision(z)),
      };
    })
    .sort((a, b) => a.station - b.station);

  // Header stats.
  const plannedTodayMin = zones.reduce((s2, z) => s2 + z.trimmedMinToday, 0);
  const next =
    zones
      .map((z) => z.nextRun)
      .filter((n): n is { startTime: string; weekday: number } => n !== null)
      .sort((a, b) => hhmm(a.startTime) - hhmm(b.startTime))[0] ?? null;

  return {
    ts: new Date().toISOString(),
    connected,
    mode: irr.mode,
    liveAllowed: liveAllowed(s),
    /** False while onboard-program suppression is paused (verifying Home-App watering). */
    suppressingOnboard: isSuppressingOnboard(),
    armed: s.devices.armed,
    devicesMode: s.devices.mode,
    globalRainSkipMm: irr.globalRainSkipMm,
    rainSkipProbabilityPct: irr.rainSkipProbabilityPct,
    zones,
    baselineMirror: irr.baselineMirror,
    baselineDrift: irr.baselineDrift,
    weather: weatherOk
      ? {
          et0Mm: Math.round(day.et0Mm * 100) / 100,
          precipMm: Math.round(day.precipMm * 10) / 10,
          precipProbabilityPct: Math.round(day.precipProbabilityPct),
        }
      : null,
    outlook: (outlook ?? []).map((o) => ({
      date: o.date,
      precipMm: Math.round(o.precipMm * 10) / 10,
      precipProbabilityPct: Math.round(o.precipProbabilityPct),
      et0Mm: Math.round(o.et0Mm * 100) / 100,
      tMaxC: Math.round(o.tMaxC),
      sunshineHours: Math.round(o.sunshineHours * 10) / 10,
      humidityPct: Math.round(o.humidityPct),
      cloudCoverPct: Math.round(o.cloudCoverPct),
    })),
    stats: {
      zoneCount: zones.length,
      plannedTodayMin,
      savedPctToday: daySavedPct(trims),
      nextRun: next,
    },
    log: irr.log.slice(-50).reverse(),
    lastError: irr.lastError ?? liveError,
    lastTickAt: irr.lastTickAt,
  };
}

/** PUT /api/irrigation/mode — { mode }. Live requires Devices armed (re-checked in coordinator). */
export function setIrrigationMode(rawMode: unknown): unknown {
  const mode = String(rawMode) as IrrigationMode;
  if (!MODES.includes(mode))
    throw badInput(`mode must be one of ${MODES.join("|")}`);
  store.update((s) => {
    s.irrigation.mode = mode;
    s.irrigation.updatedAt = Date.now();
  });
  return { ts: new Date().toISOString(), mode };
}

/** PUT /api/irrigation/settings — bypass rules { globalRainSkipMm?, rainSkipProbabilityPct? }. */
export function setIrrigationGlobal(patch: {
  globalRainSkipMm?: unknown;
  rainSkipProbabilityPct?: unknown;
}): unknown {
  store.update((s) => {
    if (patch.globalRainSkipMm !== undefined) {
      const v = Number(patch.globalRainSkipMm);
      if (Number.isFinite(v))
        s.irrigation.globalRainSkipMm = Math.max(0, Math.min(100, v));
    }
    if (patch.rainSkipProbabilityPct !== undefined) {
      const v = Number(patch.rainSkipProbabilityPct);
      if (Number.isFinite(v))
        s.irrigation.rainSkipProbabilityPct = Math.max(0, Math.min(100, v));
    }
    s.irrigation.updatedAt = Date.now();
  });
  return { ts: new Date().toISOString(), settings: store.get().irrigation };
}

function defaultZoneConfig(
  zoneId: string,
  name?: string,
): IrrigationZoneConfig {
  return {
    zoneId,
    name: name || `Zone ${zoneId.replace("rb-", "")}`,
    plantType: "shrubs",
    emitterType: "spray",
    managedBy: "app",
    heatTopupEnabled: false,
    wateringTimes: [],
  };
}

/** PUT /api/irrigation/zones/:id — upsert per-zone agronomic + scheduling config. Validated. */
export function setIrrigationZone(
  zoneId: string,
  patch: Partial<IrrigationZoneConfig>,
): unknown {
  if (!/^rb-\d+$/.test(zoneId)) throw badInput("zoneId must be rb-<n>");
  store.update((s) => {
    const cur = s.irrigation.zones[zoneId] ?? defaultZoneConfig(zoneId);
    const next: IrrigationZoneConfig = { ...cur };
    if (
      patch.name !== undefined &&
      typeof patch.name === "string" &&
      patch.name.trim()
    )
      next.name = patch.name.trim();
    if (
      patch.plantType !== undefined &&
      PLANT_TYPES.includes(patch.plantType as IrrigationPlantType)
    )
      next.plantType = patch.plantType as IrrigationPlantType;
    if (
      patch.emitterType !== undefined &&
      EMITTER_TYPES.includes(patch.emitterType as IrrigationEmitterType)
    )
      next.emitterType = patch.emitterType as IrrigationEmitterType;
    if (patch.flowLpm !== undefined)
      next.flowLpm =
        typeof patch.flowLpm === "number" && patch.flowLpm > 0
          ? patch.flowLpm
          : undefined;
    if (patch.areaM2 !== undefined)
      next.areaM2 =
        typeof patch.areaM2 === "number" && patch.areaM2 > 0
          ? patch.areaM2
          : undefined;
    if (patch.sunExposure !== undefined)
      next.sunExposure =
        typeof patch.sunExposure === "number"
          ? Math.max(0, Math.min(1, patch.sunExposure))
          : undefined;
    if (patch.kc !== undefined)
      next.kc =
        typeof patch.kc === "number" && patch.kc > 0 ? patch.kc : undefined;
    if (patch.managedBy !== undefined)
      next.managedBy = patch.managedBy === "controller" ? "controller" : "app";
    if (patch.heatTopupEnabled !== undefined)
      next.heatTopupEnabled = patch.heatTopupEnabled === true;
    if (patch.rainSkipMm !== undefined)
      next.rainSkipMm =
        typeof patch.rainSkipMm === "number" && patch.rainSkipMm >= 0
          ? patch.rainSkipMm
          : undefined;
    if (Array.isArray(patch.wateringTimes))
      next.wateringTimes = patch.wateringTimes
        .map((w) => coerceWateringTime(w))
        .filter((w): w is IrrigationWateringTime => w !== null);
    s.irrigation.zones[zoneId] = next;
    s.irrigation.updatedAt = Date.now();
  });
  return {
    ts: new Date().toISOString(),
    zone: store.get().irrigation.zones[zoneId],
  };
}

function coerceWateringTime(raw: unknown): IrrigationWateringTime | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Partial<IrrigationWateringTime>;
  if (typeof w.startTime !== "string" || !/^\d{1,2}:\d{2}$/.test(w.startTime))
    return null;
  const days =
    Array.isArray(w.days) && w.days.length === 7
      ? w.days.map((d) => d === true)
      : [false, true, true, true, true, true, false];
  return {
    id:
      typeof w.id === "string" && w.id
        ? w.id
        : `wt-${randomBytes(4).toString("hex")}`,
    startTime: w.startTime,
    durationMin:
      typeof w.durationMin === "number" && w.durationMin > 0
        ? Math.min(600, Math.round(w.durationMin))
        : 10,
    days,
  };
}

/** DELETE /api/irrigation/zones/:id — remove a zone config (and its photo blob). */
export function deleteIrrigationZone(zoneId: string): unknown {
  store.update((s) => {
    const z = s.irrigation.zones[zoneId];
    if (z?.photoId) deletePhoto(z.photoId);
    delete s.irrigation.zones[zoneId];
    delete s.irrigation.deficits[zoneId];
    s.irrigation.updatedAt = Date.now();
  });
  return { ts: new Date().toISOString(), zoneId, removed: true };
}

// ---- Photo upload / serve ----------------------------------------------------

/** Persist an uploaded photo buffer for a zone and bind it (replacing any previous). */
export function attachZonePhoto(
  zoneId: string,
  buf: Buffer,
  mime: string,
): unknown {
  if (!/^rb-\d+$/.test(zoneId)) throw badInput("zoneId must be rb-<n>");
  const saved = savePhoto(buf, mime); // throws BAD_INPUT on bad type/size
  store.update((s) => {
    const cur = s.irrigation.zones[zoneId] ?? defaultZoneConfig(zoneId);
    if (cur.photoId) deletePhoto(cur.photoId); // drop the replaced blob
    s.irrigation.zones[zoneId] = { ...cur, photoId: saved.photoId };
    s.irrigation.updatedAt = Date.now();
  });
  return {
    ts: new Date().toISOString(),
    zoneId,
    photoId: saved.photoId,
    photoUrl: photoUrl(saved.photoId),
  };
}

/** Read a stored photo (route serves the bytes). Returns null when absent. */
export function getZonePhoto(
  photoId: string,
): { buf: Buffer; contentType: string } | null {
  return readPhoto(photoId);
}
