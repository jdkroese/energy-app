// Devices / Climate HTTP surface. Reads are any-authed; arm/command/bulk and the
// integration POST are admin-gated at the route in index.ts. Everything degrades
// gracefully when AC Cloud is not connected (empty fleet / "not connected").

import * as intesis from '../connectors/intesis';
import type { ClimateUnit } from '../connectors/intesis';
import * as airzone from '../connectors/airzone';
import * as store from '../store';
import type {
  Action,
  Automation,
  ControlMode,
  DeviceSettings,
  DeviceType,
  RunCondition,
  Schedule,
  ScheduleScope,
  ScheduleWindow,
  SolarSurplusPrecoolParams,
} from '../store';
import { issueClimate, type ClimateLever } from '../control/climate-execute';
import { takeClimateSnapshot } from '../control/climate-snapshot';
import {
  revertClimateToSafe,
  stopSurplusStartedUnits,
  markManualOverride,
  clearManualOverride,
  manualOverrideUntil,
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
  automationEnabled: boolean;
  /** Epoch ms a manual-control hold expires on this unit, or null if none active. */
  manualOverrideUntil: number | null;
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
  return {
    ...u,
    type,
    name: withPrefix(u.name),
    // Heating (Airzone) read fields; normalize to null for cooling (Intesis) units.
    floorDemand: u.floorDemand ?? null,
    humidity: u.humidity ?? null,
    wireless: u.wireless ?? null,
    lowBattery: u.lowBattery ?? null,
    room: withPrefix(ds?.room ?? u.zone ?? u.name),
    automationEnabled: ds?.automationEnabled ?? false,
    manualOverrideUntil: manualOverrideUntil(u.id),
    comfortCeilingC: ds?.comfortCeilingC ?? null,
    comfortFloorC: ds?.comfortFloorC ?? null,
    warmth: warmthOf(u.currentTempC),
    governedBy: {
      schedules: schedules.filter((s) => s.enabled && ruleTargetsUnit(s, u.id)).map((s) => s.id),
      automations:
        ds?.automationEnabled && automations.some((a) => a.enabled)
          ? automations.filter((a) => a.enabled).map((a) => a.id)
          : [],
    },
  };
}

/** Whether ANY climate connector is connected (AC Cloud or Airzone underfloor). */
function anyConnected(): boolean {
  return intesis.isConfigured() || airzone.isConfigured();
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
  return { fleet, error };
}

/** GET /api/devices — normalized fleet + a context strip. */
export async function getDevices(): Promise<unknown> {
  const dev = store.get().devices;
  const connected = anyConnected();
  const { fleet, error: fleetError } = await getAllUnits();
  const settings = store.get().deviceSettings;
  const devices = fleet.map((u) => mergeView(u, settings));

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
  const { fleet } = await getAllUnits();
  const u = fleet.find((x) => x.id === id);
  if (!u) return { ts: new Date().toISOString(), connected: true, device: null };
  const settings = store.get().deviceSettings;
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
  if (result.ok) markManualOverride(id);
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
    if (r.ok) markManualOverride(id); // manual control wins — hold automation off
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
    log: dev.log.slice(-100),
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
    const existing = s.deviceSettings[id] ?? { automationEnabled: false };
    const merged: DeviceSettings = {
      automationEnabled: patch.automationEnabled ?? existing.automationEnabled,
      room: patch.room ?? existing.room,
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
  };
}

function buildWindows(raw: unknown): ScheduleWindow[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ScheduleWindow[] = [];
  for (const w of list) {
    if (w && typeof w.start === 'string' && typeof w.end === 'string') {
      out.push({ start: w.start, end: w.end, ...(w.action ? { action: buildAction(w.action) } : {}) });
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

function sanitizeParams(p: Partial<SolarSurplusPrecoolParams> | undefined, base: SolarSurplusPrecoolParams): SolarSurplusPrecoolParams {
  return {
    roomTempLimitC: typeof p?.roomTempLimitC === 'number' ? p.roomTempLimitC : base.roomTempLimitC,
    targetSetpointC: typeof p?.targetSetpointC === 'number' ? p.targetSetpointC : base.targetSetpointC,
    surplusClearSec: typeof p?.surplusClearSec === 'number' ? p.surplusClearSec : base.surplusClearSec,
    bandRestrictionEnabled:
      typeof p?.bandRestrictionEnabled === 'boolean' ? p.bandRestrictionEnabled : base.bandRestrictionEnabled,
    exitBand: p?.exitBand ?? base.exitBand,
    startThresholdW: typeof p?.startThresholdW === 'number' ? p.startThresholdW : base.startThresholdW,
  };
}

export function createAutomation(body: Partial<Automation>): unknown {
  const base: SolarSurplusPrecoolParams = {
    roomTempLimitC: 25,
    targetSetpointC: 23,
    surplusClearSec: 120,
    bandRestrictionEnabled: true,
    exitBand: 'P1',
    startThresholdW: 800,
  };
  const a: Automation = {
    id: newId('auto'),
    name: body.name?.trim() || 'New automation',
    enabled: body.enabled ?? false,
    type: 'solar_surplus_precool',
    params: sanitizeParams(body.params, base),
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
    const merged: Automation = {
      ...cur,
      name: body.name ?? cur.name,
      enabled: body.enabled ?? cur.enabled,
      params: sanitizeParams(body.params, cur.params),
    };
    st.automations[idx] = merged;
    return merged;
  });
  if (!saved) throw badInput(`automation ${id} not found`);
  return { ts: new Date().toISOString(), automation: saved };
}

export function deleteAutomation(id: string): unknown {
  store.update((st) => {
    st.automations = st.automations.filter((x) => x.id !== id);
  });
  return { ts: new Date().toISOString(), ok: true };
}
