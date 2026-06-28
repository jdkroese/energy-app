// Devices / Climate HTTP surface. Reads are any-authed; arm/command/bulk and the
// integration POST are admin-gated at the route in index.ts. Everything degrades
// gracefully when AC Cloud is not connected (empty fleet / "not connected").

import * as intesis from '../connectors/intesis';
import type { ClimateUnit } from '../connectors/intesis';
import * as airzone from '../connectors/airzone';
import * as panasonic from '../connectors/panasonic';
import * as rainbird from '../connectors/rainbird';
import * as store from '../store';
import { defaultAutomations, defaultTariffArbitrageParams } from '../store';
import { resolveRoomId } from '../rooms';
import type {
  Action,
  Automation,
  AutomationParams,
  ControlMode,
  DeviceSettings,
  DeviceType,
  RunCondition,
  Schedule,
  ScheduleScope,
  ScheduleWindow,
  SolarSurplusPrecoolParams,
  TariffArbitrageParams,
} from '../store';
import type { Band } from '../tariff';
import { issueClimate, type ClimateLever } from '../control/climate-execute';
import { takeClimateSnapshot } from '../control/climate-snapshot';
import {
  revertClimateToSafe,
  stopSurplusStartedUnits,
  markManualOverride,
  clearManualOverride,
  manualOverrideUntil,
  dropSurplusStarted,
  surplusOwns,
} from '../control/climate-coordinator';
import { bandFor } from '../tariff';
import { checkRuleOverlap } from '../schedule-rules';

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

// ---- Normalized device view (connector + deviceSettings merge) --------------

export interface DeviceView extends ClimateUnit {
  /** Device category — drives which controls/rules apply (Airzone = heating). */
  type: DeviceType;
  room: string;
  /** First-class Rooms model: the assigned room id, or null when Unassigned. */
  roomId: string | null;
  /** Resolved assigned-room name (null when Unassigned) — same value across By-type/By-room. */
  roomName: string | null;
  /** LEGACY: true iff EITHER direction is enrolled (back-compat for old clients). */
  automationEnabled: boolean;
  /** Solar-surplus COOLING enrolment (independent per-direction flag). */
  solarCoolEnabled: boolean;
  /** Solar-surplus HEATING enrolment (independent per-direction flag). */
  solarHeatEnabled: boolean;
  /** Epoch ms a manual-control hold expires on this unit, or null if none active. */
  manualOverrideUntil: number | null;
  /** Sticky: user manually switched this unit ON → excluded from the surplus auto-stop. */
  manualOn: boolean;
  comfortCeilingC: number | null;
  comfortFloorC: number | null;
  /** Warmth tone hint for the UI (relative to a comfortable 24°C). */
  warmth: 'cold' | 'cool' | 'comfortable' | 'warm' | 'hot' | 'unknown';
  /** Whether an enabled schedule/automation currently governs this device. */
  governedBy: { schedules: string[]; automations: string[] };
}

/** Airzone underfloor zones are heating; everything else (Intesis AC) is cooling. */
function deviceTypeOf(id: string): DeviceType {
  return id.startsWith('air-') ? 'heating' : 'cooling';
}

/** Does an enabled rule target this unit? Group scope is not yet a member-resolved store. */
function ruleTargetsUnit(s: Schedule, unitId: string): boolean {
  return s.scope.kind === 'unit' && s.scope.deviceId === unitId;
}

function warmthOf(t: number | null): DeviceView['warmth'] {
  if (t === null) return 'unknown';
  if (t < 19) return 'cold';
  if (t < 22) return 'cool';
  if (t < 25) return 'comfortable';
  if (t < 28) return 'warm';
  return 'hot';
}

function mergeView(u: ClimateUnit, settings: Record<string, DeviceSettings>): DeviceView {
  const ds = settings[u.id];
  const automations = store.get().automations;
  const schedules = store.get().schedules;
  const type = deviceTypeOf(u.id);
  // Display-name prefix per device type, applied at the source so it shows across the
  // whole system (list, detail, schedules, mobile). Idempotent — never double-prefixes.
  const prefix = type === 'heating' ? 'Heating - ' : 'AC Unit - ';
  const withPrefix = (s: string) => (s.startsWith(prefix) ? s : `${prefix}${s}`);
  // First-class Rooms model: resolve the assigned room (null when Unassigned / deleted).
  const roomId = resolveRoomId(u.id);
  const roomName = roomId ? store.get().rooms[roomId]?.name ?? null : null;
  return {
    ...u,
    type,
    name: withPrefix(u.name),
    // Heating (Airzone) read fields; normalize to null for cooling (Intesis) units.
    floorDemand: u.floorDemand ?? null,
    humidity: u.humidity ?? null,
    wireless: u.wireless ?? null,
    lowBattery: u.lowBattery ?? null,
    roomId,
    roomName,
    // `room` (display) prefers the assigned room name; falls back to the legacy zone/name
    // string with the type prefix so existing readers keep working.
    room: roomName ?? withPrefix(ds?.room ?? u.zone ?? u.name),
    // Per-direction flags. Migration safety: fall back to the legacy single flag when a
    // record predates the split (hydrateDeviceSettings already migrates persisted state,
    // but be defensive for any in-flight record).
    solarCoolEnabled: ds?.solarCoolEnabled ?? ds?.automationEnabled ?? false,
    solarHeatEnabled: ds?.solarHeatEnabled ?? ds?.automationEnabled ?? false,
    automationEnabled:
      (ds?.solarCoolEnabled ?? ds?.automationEnabled ?? false) ||
      (ds?.solarHeatEnabled ?? ds?.automationEnabled ?? false),
    manualOverrideUntil: manualOverrideUntil(u.id),
    // Provenance-derived: a powered-on unit the surplus rule did NOT start (dashboard,
    // physical remote, or schedule) is manual and shows the hand marker; a rule-started
    // unit does not. Single source of truth = devices.surplusStartedIds.
    manualOn: u.power === true && !surplusOwns(u.id),
    comfortCeilingC: ds?.comfortCeilingC ?? null,
    comfortFloorC: ds?.comfortFloorC ?? null,
    warmth: warmthOf(u.currentTempC),
    governedBy: {
      schedules: schedules.filter((s) => s.enabled && ruleTargetsUnit(s, u.id)).map((s) => s.id),
      automations:
        (ds?.solarCoolEnabled || ds?.solarHeatEnabled || ds?.automationEnabled) &&
        automations.some((a) => a.enabled)
          ? automations.filter((a) => a.enabled).map((a) => a.id)
          : [],
    },
  };
}

/**
 * Map a Rain Bird irrigation zone into a DeviceView so it appears in the unified
 * fleet under the 'irrigation' type. Irrigation has NO setpoint/mode/temp — those
 * climate fields are null. `power` reflects "currently watering". The zone's
 * run/stop/rain-delay levers live on the dedicated /api/irrigation surface, not the
 * climate command path (which only knows power/mode/setpoint/fan/vanes).
 */
function irrigationView(z: rainbird.IrrigationZone, settings: Record<string, DeviceSettings>): DeviceView {
  const ds = settings[z.id];
  const roomId = resolveRoomId(z.id);
  const roomName = roomId ? store.get().rooms[roomId]?.name ?? null : null;
  const name = ds?.name ?? z.name;
  return {
    id: z.id,
    name,
    zone: name,
    installation: 'Rain Bird',
    power: z.active,
    mode: z.active ? 'watering' : 'idle',
    setpointC: null,
    currentTempC: null,
    minSetpointC: null,
    maxSetpointC: null,
    online: z.available,
    floorDemand: null,
    humidity: null,
    wireless: null,
    lowBattery: null,
    type: 'irrigation',
    room: roomName ?? name,
    roomId,
    roomName,
    automationEnabled: false,
    solarCoolEnabled: false,
    solarHeatEnabled: false,
    manualOverrideUntil: null,
    manualOn: false,
    comfortCeilingC: null,
    comfortFloorC: null,
    warmth: 'unknown',
    governedBy: { schedules: [], automations: [] },
  };
}

/** Irrigation zones as DeviceViews; soft-fails to [] when not connected/unreachable. */
async function getIrrigationViews(settings: Record<string, DeviceSettings>): Promise<DeviceView[]> {
  if (!rainbird.isConfigured()) return [];
  try {
    return (await rainbird.getZones()).map((z) => irrigationView(z, settings));
  } catch {
    return [];
  }
}

/** Whether ANY device connector (climate or irrigation) is connected. */
function anyConnected(): boolean {
  return intesis.isConfigured() || airzone.isConfigured() || panasonic.isConfigured() || rainbird.isConfigured();
}

/** Combined, normalized climate fleet across all connectors. Soft-fails per
 *  connector so one being unreachable doesn't blank the whole list. */
async function getAllUnits(): Promise<{ fleet: ClimateUnit[]; error: string | null }> {
  const fleet: ClimateUnit[] = [];
  let error: string | null = null;
  if (intesis.isConfigured()) {
    try {
      fleet.push(...(await intesis.getFleet()));
    } catch (e) {
      error = (e as Error).message;
    }
  }
  if (airzone.isConfigured()) {
    try {
      fleet.push(...(await airzone.getFleet()));
    } catch (e) {
      error = error ?? `Airzone: ${(e as Error).message}`;
    }
  }
  if (panasonic.isConfigured()) {
    try {
      fleet.push(...(await panasonic.getFleet()));
    } catch (e) {
      error = error ?? `Panasonic CC: ${(e as Error).message}`;
    }
  }
  return { fleet, error };
}

/** GET /api/devices — normalized fleet + a context strip. */
export async function getDevices(): Promise<unknown> {
  const dev = store.get().devices;
  const connected = anyConnected();
  const { fleet, error: fleetError } = await getAllUnits();
  const settings = store.get().deviceSettings;
  const climate = fleet.map((u) => mergeView(u, settings));
  // Irrigation zones merge into the same fleet under type 'irrigation' (soft-fails to []).
  const irrigation = await getIrrigationViews(settings);
  const devices = [...climate, ...irrigation];

  const temps = devices.map((d) => d.currentTempC).filter((t): t is number => t !== null);
  const indoorAvgC = temps.length ? Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 10) / 10 : null;

  return {
    ts: new Date().toISOString(),
    connected,
    fleetError,
    armed: dev.armed,
    mode: dev.mode,
    lastError: dev.lastError,
    guardrails: dev.guardrails,
    context: {
      indoorAvgC,
      band: bandFor(new Date()),
      deviceCount: devices.length,
      onCount: devices.filter((d) => d.power).length,
    },
    devices,
  };
}

/** GET /api/devices/:id — detail + governing schedules/automations. */
export async function getDevice(id: string): Promise<unknown> {
  if (!anyConnected()) {
    return { ts: new Date().toISOString(), connected: false, device: null };
  }
  const settings = store.get().deviceSettings;
  // Irrigation zones (`rb-*`) live on a separate connector; resolve them here so the
  // unified /:id detail endpoint covers the whole fleet.
  if (id.startsWith('rb-')) {
    const zone = (await getIrrigationViews(settings)).find((z) => z.id === id) ?? null;
    return { ts: new Date().toISOString(), connected: true, device: zone, schedules: [], automations: [] };
  }
  const { fleet } = await getAllUnits();
  const u = fleet.find((x) => x.id === id);
  if (!u) return { ts: new Date().toISOString(), connected: true, device: null };
  const device = mergeView(u, settings);
  const schedules = store.get().schedules.filter((s) => ruleTargetsUnit(s, id));
  const automations = device.automationEnabled ? store.get().automations : [];
  return { ts: new Date().toISOString(), connected: true, device, schedules, automations };
}

// ---- Commands (admin + arm) -------------------------------------------------

const LEVERS: ClimateLever[] = ['power', 'mode', 'setpoint', 'fan', 'vaneUpDown', 'vaneLeftRight'];

function parseValue(lever: ClimateLever, raw: unknown): boolean | number | string {
  if (lever === 'power') return Boolean(raw);
  if (lever === 'mode') return String(raw);
  const n = Number(raw);
  if (Number.isNaN(n)) throw badInput('value must be a number');
  return n;
}

export async function commandDevice(id: string, lever: ClimateLever, rawValue: unknown): Promise<unknown> {
  if (!LEVERS.includes(lever)) throw badInput(`lever must be one of ${LEVERS.join('|')}`);
  if (!anyConnected()) throw badInput('no climate integration connected');
  const { fleet } = await getAllUnits();
  const u = fleet.find((x) => x.id === id);
  if (!u) throw badInput(`device ${id} not found`);

  const value = parseValue(lever, rawValue);
  const snap = await takeClimateSnapshot();
  const result = await issueClimate(u, lever, value, 'manual command', snap, { manual: true });
  // Manual control wins: hold automation off this unit for a while.
  if (result.ok) {
    markManualOverride(id); // also drops the unit from rule provenance
    // Provenance is now the single source of truth for manual-vs-rule. Powering a unit
    // ON by hand makes it manual automatically (on + not rule-started). On a manual
    // power OFF, drop it from provenance so a later remote-on is correctly seen as
    // manual rather than mistaken for a stale rule-started unit.
    if (lever === 'power' && value === false) dropSurplusStarted(id);
  }
  return { ts: new Date().toISOString(), result };
}

export async function bulkCommand(ids: string[], lever: ClimateLever, rawValue: unknown): Promise<unknown> {
  if (!Array.isArray(ids) || ids.length === 0) throw badInput('ids[] required');
  if (!LEVERS.includes(lever)) throw badInput(`lever must be one of ${LEVERS.join('|')}`);
  if (!anyConnected()) throw badInput('no climate integration connected');
  const { fleet } = await getAllUnits();
  const value = parseValue(lever, rawValue);
  const snap = await takeClimateSnapshot();

  // Stagger compressor power-ons under the cap by tracking pending import.
  let pendingImportKw = 0;
  const results: Array<{ id: string; ok: boolean; reason: string }> = [];
  for (const id of ids) {
    const u = fleet.find((x) => x.id === id);
    if (!u) {
      results.push({ id, ok: false, reason: 'not found' });
      continue;
    }
    const r = await issueClimate(u, lever, value, 'bulk command', { ...snap, pendingImportKw }, { manual: true });
    results.push({ id, ok: r.ok, reason: r.reason });
    if (r.ok) {
      markManualOverride(id); // manual control wins — also drops rule provenance
      // Provenance mirrors commandDevice: ON-by-hand is manual automatically; on OFF,
      // drop from provenance so a later remote-on reads as manual.
      if (lever === 'power' && value === false) dropSurplusStarted(id);
    }
    if (lever === 'power' && value === true && r.ok && !u.power) pendingImportKw += 1.2;
  }
  return { ts: new Date().toISOString(), results };
}

/** Clear a manual-control hold — hand this unit back to automation immediately. */
export function releaseDevice(id: string): unknown {
  clearManualOverride(id);
  return { ts: new Date().toISOString(), id, released: true };
}

// ---- Arm (admin) ------------------------------------------------------------

export function getDevicesStatus(): unknown {
  const dev = store.get().devices;
  return {
    ts: new Date().toISOString(),
    armed: dev.armed,
    mode: dev.mode,
    lastError: dev.lastError,
    guardrails: dev.guardrails,
    log: dev.log,
  };
}

export async function setDevicesArm(armed: boolean, mode?: ControlMode): Promise<unknown> {
  const valid: ControlMode[] = ['off', 'manual', 'auto'];
  const nextMode: ControlMode = mode && valid.includes(mode) ? mode : armed ? 'manual' : 'off';
  if (!armed || nextMode === 'off') {
    // Switch off ONLY units the surplus rule started — while still armed, before
    // we disarm — so a disarm never strands rule-started cooling on the grid.
    await stopSurplusStartedUnits('disarm — stop rule-started cooling');
    revertClimateToSafe();
  } else {
    store.update((st) => {
      st.devices.armed = true;
      st.devices.mode = nextMode;
      st.devices.updatedAt = Date.now();
      st.devices.lastError = null;
    });
  }
  return getDevicesStatus();
}

// ---- Per-device settings ----------------------------------------------------

export function setDeviceSettings(id: string, patch: Partial<DeviceSettings>): unknown {
  const saved = store.update((s) => {
    const existing = s.deviceSettings[id] ?? {};
    // Per-direction solar flags are the source of truth. A legacy `automationEnabled`
    // patch (old clients) is honored by setting BOTH directions to it; the split flags,
    // when present, take precedence over that legacy value within the same patch.
    const legacyExisting = existing.solarCoolEnabled ?? existing.solarHeatEnabled ?? existing.automationEnabled ?? false;
    const solarCoolEnabled =
      patch.solarCoolEnabled ?? patch.automationEnabled ?? existing.solarCoolEnabled ?? legacyExisting;
    const solarHeatEnabled =
      patch.solarHeatEnabled ?? patch.automationEnabled ?? existing.solarHeatEnabled ?? legacyExisting;
    const merged: DeviceSettings = {
      ...existing,
      solarCoolEnabled,
      solarHeatEnabled,
      // Keep the legacy field in sync (true iff either direction is on) for old readers.
      automationEnabled: solarCoolEnabled || solarHeatEnabled,
      room: patch.room ?? existing.room,
      // Rooms model: a roomId patch (null clears to Unassigned) wins; else preserve existing.
      roomId: patch.roomId !== undefined ? patch.roomId : existing.roomId,
      comfortCeilingC: patch.comfortCeilingC ?? existing.comfortCeilingC,
      comfortFloorC: patch.comfortFloorC ?? existing.comfortFloorC,
      invertPosition: patch.invertPosition ?? existing.invertPosition,
    };
    s.deviceSettings[id] = merged;
    return merged;
  });
  return { ts: new Date().toISOString(), id, settings: saved };
}

// ---- Integration: AC Cloud --------------------------------------------------

export async function getIntegration(): Promise<unknown> {
  const connected = intesis.isConfigured();
  let deviceCount = 0;
  let error: string | null = null;
  if (connected) {
    try {
      deviceCount = (await intesis.getFleet()).length;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const username = store.get().integrations.intesis?.username ?? null;
  return { ts: new Date().toISOString(), connected, deviceCount, username, error };
}

/** POST /api/integrations/intesis — validate creds via login(), then persist. */
export async function setIntegration(usernameRaw: unknown, passwordRaw: unknown): Promise<unknown> {
  const username = String(usernameRaw ?? '').trim();
  const password = String(passwordRaw ?? '');
  if (!username || !password) throw badInput('username and password are required');

  // Validate by logging in BEFORE persisting; never log the password.
  let deviceCount = 0;
  try {
    const result = await intesis.login({ username, password });
    deviceCount = result.devices.length;
  } catch (e) {
    throw badInput(`AC Cloud login failed: ${(e as Error).message}`);
  }

  store.update((s) => {
    s.integrations.intesis = { username, password };
  });
  return { ts: new Date().toISOString(), connected: true, deviceCount, username };
}

export function disconnectIntegration(): unknown {
  store.update((s) => {
    s.integrations.intesis = null;
  });
  return { ts: new Date().toISOString(), connected: false };
}

// ---- Schedules CRUD ---------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function listSchedules(): unknown {
  return { ts: new Date().toISOString(), schedules: store.get().schedules };
}

// ---- Rule (schedule) sanitization -------------------------------------------

const FAN_VANE = (v: unknown): 'auto' | 1 | 2 | 3 | 4 | 5 =>
  v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : 'auto';

function buildAction(raw: Partial<Action> | undefined, base?: Action): Action {
  const b: Action = base ?? { power: true, mode: 'cool', setpointC: 24, fan: 'auto', vaneUpDown: 'auto', vaneLeftRight: 'auto' };
  const a = raw ?? {};
  return {
    power: typeof a.power === 'boolean' ? a.power : b.power,
    mode: a.mode && ['auto', 'heat', 'dry', 'fan', 'cool'].includes(a.mode) ? a.mode : b.mode,
    setpointC: typeof a.setpointC === 'number' ? a.setpointC : b.setpointC,
    fan: a.fan !== undefined ? FAN_VANE(a.fan) : b.fan,
    vaneUpDown: a.vaneUpDown !== undefined ? FAN_VANE(a.vaneUpDown) : b.vaneUpDown,
    vaneLeftRight: a.vaneLeftRight !== undefined ? FAN_VANE(a.vaneLeftRight) : b.vaneLeftRight,
    // Blinds carry positionPct; circuit (generic switchable) rules carry speed/direction.
    // Pass them through verbatim so a circuit rule round-trips; climate rules omit them.
    ...(typeof a.positionPct === 'number'
      ? { positionPct: Math.min(100, Math.max(0, Math.round(a.positionPct))) }
      : b.positionPct !== undefined ? { positionPct: b.positionPct } : {}),
    ...(typeof a.speed === 'number' ? { speed: Math.round(a.speed) } : b.speed !== undefined ? { speed: b.speed } : {}),
    ...(typeof a.direction === 'string' && a.direction ? { direction: a.direction } : b.direction !== undefined ? { direction: b.direction } : {}),
  };
}

function buildWindows(raw: unknown): ScheduleWindow[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ScheduleWindow[] = [];
  for (const w of list) {
    if (w && typeof w.start === 'string' && typeof w.end === 'string') {
      const win: ScheduleWindow = {
        start: w.start,
        end: w.end,
        ...(w.action ? { action: buildAction(w.action) } : {}),
      };
      if (w.startAnchor === 'sunrise' || w.startAnchor === 'sunset') {
        win.startAnchor = w.startAnchor;
        win.startOffsetMin = typeof w.startOffsetMin === 'number' ? Math.round(w.startOffsetMin) : 0;
      }
      if (w.endAnchor === 'sunrise' || w.endAnchor === 'sunset') {
        win.endAnchor = w.endAnchor;
        win.endOffsetMin = typeof w.endOffsetMin === 'number' ? Math.round(w.endOffsetMin) : 0;
      }
      out.push(win);
    }
  }
  return out.length ? out : [{ start: '08:00', end: '22:00' }];
}

function buildScope(raw: unknown): ScheduleScope {
  const s = raw as { kind?: string; deviceId?: string; groupId?: string } | undefined;
  if (s?.kind === 'group' && typeof s.groupId === 'string') return { kind: 'group', groupId: s.groupId };
  return { kind: 'unit', deviceId: typeof s?.deviceId === 'string' ? s.deviceId : '' };
}

function buildCondition(raw: unknown): RunCondition {
  const c = raw as { kind?: string; thresholdC?: number } | undefined;
  if (c?.kind === 'warmerThan' && typeof c.thresholdC === 'number') return { kind: 'warmerThan', thresholdC: c.thresholdC };
  if (c?.kind === 'coolerThan' && typeof c.thresholdC === 'number') return { kind: 'coolerThan', thresholdC: c.thresholdC };
  return { kind: 'always' };
}

const RULE_TYPE = (v: unknown): DeviceType =>
  v === 'heating' || v === 'lighting' || v === 'circuit' ? v : 'cooling';

/** Reject a write that would overlap another enabled rule on the same unit. */
function assertNoOverlap(candidate: Schedule): void {
  const others = store.get().schedules.filter((x) => x.id !== candidate.id);
  const res = checkRuleOverlap(candidate, others);
  if (!res.ok) throw badInput(res.reason);
}

export function createSchedule(body: Partial<Schedule>): unknown {
  const s: Schedule = {
    id: newId('sched'),
    name: body.name?.trim() || 'New rule',
    enabled: body.enabled ?? true,
    type: RULE_TYPE(body.type),
    scope: buildScope(body.scope),
    days: Array.isArray(body.days) ? body.days.filter((d) => d >= 0 && d <= 6) : [1, 2, 3, 4, 5],
    windows: buildWindows(body.windows),
    action: buildAction(body.action),
    condition: buildCondition(body.condition),
  };
  assertNoOverlap(s);
  store.update((st) => {
    st.schedules.push(s);
  });
  return { ts: new Date().toISOString(), schedule: s };
}

export function updateSchedule(id: string, body: Partial<Schedule>): unknown {
  const cur = store.get().schedules.find((x) => x.id === id);
  if (!cur) throw badInput(`schedule ${id} not found`);
  const merged: Schedule = {
    ...cur,
    name: body.name?.trim() || cur.name,
    enabled: body.enabled ?? cur.enabled,
    type: body.type !== undefined ? RULE_TYPE(body.type) : cur.type,
    scope: body.scope !== undefined ? buildScope(body.scope) : cur.scope,
    days: Array.isArray(body.days) ? body.days.filter((d) => d >= 0 && d <= 6) : cur.days,
    windows: body.windows !== undefined ? buildWindows(body.windows) : cur.windows,
    action: body.action !== undefined ? buildAction(body.action, cur.action) : cur.action,
    condition: body.condition !== undefined ? buildCondition(body.condition) : cur.condition,
  };
  assertNoOverlap(merged);
  store.update((st) => {
    const idx = st.schedules.findIndex((x) => x.id === id);
    if (idx >= 0) st.schedules[idx] = merged;
  });
  return { ts: new Date().toISOString(), schedule: merged };
}

export function deleteSchedule(id: string): unknown {
  store.update((st) => {
    st.schedules = st.schedules.filter((x) => x.id !== id);
  });
  return { ts: new Date().toISOString(), ok: true };
}

// ---- Automations CRUD -------------------------------------------------------

export function listAutomations(): unknown {
  return { ts: new Date().toISOString(), automations: store.get().automations };
}

function sanitizeSurplusParams(
  p: Partial<SolarSurplusPrecoolParams> | undefined,
  base: SolarSurplusPrecoolParams,
): SolarSurplusPrecoolParams {
  return {
    roomTempLimitC: typeof p?.roomTempLimitC === 'number' ? p.roomTempLimitC : base.roomTempLimitC,
    targetSetpointC: typeof p?.targetSetpointC === 'number' ? p.targetSetpointC : base.targetSetpointC,
    // Heating bounds — must be preserved on edit, else the unified rule loses its heat side
    // and the coordinator falls back to its 19/21°C defaults (the #14 bug).
    heatRoomFloorC: typeof p?.heatRoomFloorC === 'number' ? p.heatRoomFloorC : base.heatRoomFloorC,
    heatTargetSetpointC:
      typeof p?.heatTargetSetpointC === 'number' ? p.heatTargetSetpointC : base.heatTargetSetpointC,
    surplusClearSec: typeof p?.surplusClearSec === 'number' ? p.surplusClearSec : base.surplusClearSec,
    bandRestrictionEnabled:
      typeof p?.bandRestrictionEnabled === 'boolean' ? p.bandRestrictionEnabled : base.bandRestrictionEnabled,
    exitBand: p?.exitBand ?? base.exitBand,
    startThresholdW: typeof p?.startThresholdW === 'number' ? p.startThresholdW : base.startThresholdW,
  };
}

const isBand = (b: unknown): b is Band => b === 'P1' || b === 'P2' || b === 'P3';

/** Sanitize tariff-arbitrage params, clamping to conservative safe ranges. The
 *  per-tick guardrails (sonnenMaxW, SoC floor, import cap) are the final authority;
 *  this just keeps a saved rule's params sane. */
function sanitizeArbitrageParams(
  p: Partial<TariffArbitrageParams> | undefined,
  base: TariffArbitrageParams,
): TariffArbitrageParams {
  const num = (v: unknown, fb: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
  return {
    peakTargetSocPct: num(p?.peakTargetSocPct, base.peakTargetSocPct, 0, 100),
    maxGridChargeKw: num(p?.maxGridChargeKw, base.maxGridChargeKw, 0, 10),
    minSpreadEur: num(p?.minSpreadEur, base.minSpreadEur, 0, 1),
    dischargeFloorPct: num(p?.dischargeFloorPct, base.dischargeFloorPct, 0, 100),
    solarShortfallOnly:
      typeof p?.solarShortfallOnly === 'boolean' ? p.solarShortfallOnly : base.solarShortfallOnly,
    surplusOverridesGridCharge:
      typeof p?.surplusOverridesGridCharge === 'boolean'
        ? p.surplusOverridesGridCharge
        : base.surplusOverridesGridCharge,
    valleyBand: isBand(p?.valleyBand) ? p.valleyBand : base.valleyBand,
    peakBand: isBand(p?.peakBand) ? p.peakBand : base.peakBand,
    // SAFETY GATE: default to 'advisory' if absent/invalid — the rule must never silently
    // promote itself to commanding the battery on a malformed save.
    executionMode:
      p?.executionMode === 'active' || p?.executionMode === 'advisory'
        ? p.executionMode
        : base.executionMode ?? 'advisory',
    solarConfidencePct: num(p?.solarConfidencePct, base.solarConfidencePct ?? 70, 50, 95),
    prePeakSurplusGuardHours: num(p?.prePeakSurplusGuardHours, base.prePeakSurplusGuardHours ?? 2, 0, 6),
    prePeakSurplusMarginPct: num(p?.prePeakSurplusMarginPct, base.prePeakSurplusMarginPct ?? 30, 0, 200),
    deviationThresholdPct: num(p?.deviationThresholdPct, base.deviationThresholdPct ?? 30, 1, 100),
    deviationMinKw: num(p?.deviationMinKw, base.deviationMinKw ?? 0.8, 0, 5),
  };
}

/** Sanitize a body's params against the rule's TYPE (the discriminator), so a
 *  battery rule never gets climate params and vice-versa. */
function sanitizeParams(
  type: Automation['type'],
  p: AutomationParams | undefined,
  base: AutomationParams,
): AutomationParams {
  if (type === 'tariff_arbitrage') {
    return sanitizeArbitrageParams(
      p as Partial<TariffArbitrageParams> | undefined,
      base as TariffArbitrageParams,
    );
  }
  return sanitizeSurplusParams(
    p as Partial<SolarSurplusPrecoolParams> | undefined,
    base as SolarSurplusPrecoolParams,
  );
}

export function createAutomation(body: Partial<Automation>): unknown {
  const type: Automation['type'] =
    body.type === 'tariff_arbitrage'
      ? 'tariff_arbitrage'
      : body.type === 'solar_surplus_preheat'
        ? 'solar_surplus_preheat'
        : 'solar_surplus_precool';
  // Per-type base param shape. Surplus rules carry the full climate shape (so a save never
  // drops the other direction's target); the tariff-arbitrage rule carries the battery shape.
  const surplusBase: SolarSurplusPrecoolParams = {
    roomTempLimitC: 25,
    targetSetpointC: 23,
    heatRoomFloorC: 19,
    heatTargetSetpointC: 21,
    surplusClearSec: 120,
    bandRestrictionEnabled: true,
    exitBand: 'P1',
    startThresholdW: 800,
  };
  const base: AutomationParams =
    type === 'tariff_arbitrage' ? defaultTariffArbitrageParams() : surplusBase;
  const defaultName =
    type === 'tariff_arbitrage'
      ? 'Tariff arbitrage'
      : type === 'solar_surplus_preheat'
        ? 'Solar-surplus heating'
        : 'Solar-surplus cooling';
  const a: Automation = {
    id: newId('auto'),
    name: body.name?.trim() || defaultName,
    enabled: body.enabled ?? false,
    type,
    params: sanitizeParams(type, body.params, base),
    lastEval: null,
  };
  store.update((st) => {
    st.automations.push(a);
  });
  return { ts: new Date().toISOString(), automation: a };
}

export function updateAutomation(id: string, body: Partial<Automation>): unknown {
  const saved = store.update((st) => {
    const idx = st.automations.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const cur = st.automations[idx];
    // Sanitize against the EXISTING type (type is immutable post-create), so a climate
    // rule's params can never be coerced into the battery shape or vice-versa.
    const merged: Automation = {
      ...cur,
      name: body.name ?? cur.name,
      enabled: body.enabled ?? cur.enabled,
      params: sanitizeParams(cur.type, body.params, cur.params),
    };
    st.automations[idx] = merged;
    return merged;
  });
  if (!saved) throw badInput(`automation ${id} not found`);
  return { ts: new Date().toISOString(), automation: saved };
}

export function deleteAutomation(id: string): unknown {
  store.update((st) => {
    const removed = st.automations.find((x) => x.id === id);
    st.automations = st.automations.filter((x) => x.id !== id);
    // If the deleted rule is a SEEDED DEFAULT (matched by canonical id, or by sharing a
    // default's type so a relabeled/retargeted instance still counts), remember the
    // dismissal so mergeAutomations never re-seeds it — deleting a default keeps it gone
    // across restarts/deploys. Non-default user automations just delete as before.
    if (removed) {
      const defaults = defaultAutomations();
      const matchedDefault = defaults.find((d) => d.id === id || d.type === removed.type);
      if (matchedDefault && !st.dismissedDefaultAutomationIds.includes(matchedDefault.id)) {
        st.dismissedDefaultAutomationIds.push(matchedDefault.id);
      }
    }
  });
  return { ts: new Date().toISOString(), ok: true };
}
