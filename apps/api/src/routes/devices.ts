// Devices / Climate HTTP surface. Reads are any-authed; arm/command/bulk and the
// integration POST are admin-gated at the route in index.ts. Everything degrades
// gracefully when AC Cloud is not connected (empty fleet / "not connected").

import * as intesis from '../connectors/intesis';
import type { ClimateUnit } from '../connectors/intesis';
import * as store from '../store';
import type {
  Automation,
  ControlMode,
  DeviceSettings,
  Schedule,
  SolarSurplusPrecoolParams,
} from '../store';
import { issueClimate, type ClimateLever } from '../control/climate-execute';
import { takeClimateSnapshot } from '../control/climate-snapshot';
import { revertClimateToSafe } from '../control/climate-coordinator';
import { bandFor } from '../tariff';

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

// ---- Normalized device view (connector + deviceSettings merge) --------------

export interface DeviceView extends ClimateUnit {
  room: string;
  automationEnabled: boolean;
  comfortCeilingC: number | null;
  comfortFloorC: number | null;
  /** Warmth tone hint for the UI (relative to a comfortable 24°C). */
  warmth: 'cold' | 'cool' | 'comfortable' | 'warm' | 'hot' | 'unknown';
  /** Whether an enabled schedule/automation currently governs this device. */
  governedBy: { schedules: string[]; automations: string[] };
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
  return {
    ...u,
    room: ds?.room ?? u.zone ?? u.name,
    automationEnabled: ds?.automationEnabled ?? false,
    comfortCeilingC: ds?.comfortCeilingC ?? null,
    comfortFloorC: ds?.comfortFloorC ?? null,
    warmth: warmthOf(u.currentTempC),
    governedBy: {
      schedules: schedules.filter((s) => s.enabled && s.scope.deviceIds.includes(u.id)).map((s) => s.id),
      automations:
        ds?.automationEnabled && automations.some((a) => a.enabled)
          ? automations.filter((a) => a.enabled).map((a) => a.id)
          : [],
    },
  };
}

/** GET /api/devices — normalized fleet + a context strip. */
export async function getDevices(): Promise<unknown> {
  const dev = store.get().devices;
  const connected = intesis.isConfigured();
  let fleet: ClimateUnit[] = [];
  let fleetError: string | null = null;
  if (connected) {
    try {
      fleet = await intesis.getFleet();
    } catch (e) {
      fleetError = (e as Error).message;
    }
  }
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
  if (!intesis.isConfigured()) {
    return { ts: new Date().toISOString(), connected: false, device: null };
  }
  const fleet = await intesis.getFleet();
  const u = fleet.find((x) => x.id === id);
  if (!u) return { ts: new Date().toISOString(), connected: true, device: null };
  const settings = store.get().deviceSettings;
  const device = mergeView(u, settings);
  const schedules = store.get().schedules.filter((s) => s.scope.deviceIds.includes(id));
  const automations = device.automationEnabled ? store.get().automations : [];
  return { ts: new Date().toISOString(), connected: true, device, schedules, automations };
}

// ---- Commands (admin + arm) -------------------------------------------------

const LEVERS: ClimateLever[] = ['power', 'mode', 'setpoint', 'fan'];

function parseValue(lever: ClimateLever, raw: unknown): boolean | number | string {
  if (lever === 'power') return Boolean(raw);
  if (lever === 'mode') return String(raw);
  const n = Number(raw);
  if (Number.isNaN(n)) throw badInput('value must be a number');
  return n;
}

export async function commandDevice(id: string, lever: ClimateLever, rawValue: unknown): Promise<unknown> {
  if (!LEVERS.includes(lever)) throw badInput(`lever must be one of ${LEVERS.join('|')}`);
  if (!intesis.isConfigured()) throw badInput('AC Cloud not connected');
  const fleet = await intesis.getFleet();
  const u = fleet.find((x) => x.id === id);
  if (!u) throw badInput(`device ${id} not found`);

  const value = parseValue(lever, rawValue);
  const snap = await takeClimateSnapshot();
  const result = await issueClimate(u, lever, value, 'manual command', snap);
  return { ts: new Date().toISOString(), result };
}

export async function bulkCommand(ids: string[], lever: ClimateLever, rawValue: unknown): Promise<unknown> {
  if (!Array.isArray(ids) || ids.length === 0) throw badInput('ids[] required');
  if (!LEVERS.includes(lever)) throw badInput(`lever must be one of ${LEVERS.join('|')}`);
  if (!intesis.isConfigured()) throw badInput('AC Cloud not connected');
  const fleet = await intesis.getFleet();
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
    const r = await issueClimate(u, lever, value, 'bulk command', { ...snap, pendingImportKw });
    results.push({ id, ok: r.ok, reason: r.reason });
    if (lever === 'power' && value === true && r.ok && !u.power) pendingImportKw += 1.2;
  }
  return { ts: new Date().toISOString(), results };
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

export function setDevicesArm(armed: boolean, mode?: ControlMode): unknown {
  const valid: ControlMode[] = ['off', 'manual', 'auto'];
  const nextMode: ControlMode = mode && valid.includes(mode) ? mode : armed ? 'manual' : 'off';
  if (!armed || nextMode === 'off') {
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

export function createSchedule(body: Partial<Schedule>): unknown {
  const s: Schedule = {
    id: newId('sched'),
    name: body.name?.trim() || 'New schedule',
    enabled: body.enabled ?? true,
    scope: { deviceIds: Array.isArray(body.scope?.deviceIds) ? body.scope!.deviceIds : [] },
    days: Array.isArray(body.days) ? body.days.filter((d) => d >= 0 && d <= 6) : [1, 2, 3, 4, 5],
    start: body.start ?? '08:00',
    end: body.end ?? '22:00',
    mode: body.mode ?? 'cool',
    setpointC: typeof body.setpointC === 'number' ? body.setpointC : 24,
    fan: body.fan,
    roomTempAboveC: typeof body.roomTempAboveC === 'number' ? body.roomTempAboveC : null,
  };
  store.update((st) => {
    st.schedules.push(s);
  });
  return { ts: new Date().toISOString(), schedule: s };
}

export function updateSchedule(id: string, body: Partial<Schedule>): unknown {
  const saved = store.update((st) => {
    const idx = st.schedules.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const cur = st.schedules[idx];
    const merged: Schedule = {
      ...cur,
      name: body.name ?? cur.name,
      enabled: body.enabled ?? cur.enabled,
      scope: { deviceIds: body.scope?.deviceIds ?? cur.scope.deviceIds },
      days: Array.isArray(body.days) ? body.days : cur.days,
      start: body.start ?? cur.start,
      end: body.end ?? cur.end,
      mode: body.mode ?? cur.mode,
      setpointC: typeof body.setpointC === 'number' ? body.setpointC : cur.setpointC,
      fan: body.fan ?? cur.fan,
      roomTempAboveC: body.roomTempAboveC !== undefined ? body.roomTempAboveC : cur.roomTempAboveC,
    };
    st.schedules[idx] = merged;
    return merged;
  });
  if (!saved) throw badInput(`schedule ${id} not found`);
  return { ts: new Date().toISOString(), schedule: saved };
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
    authority: body.authority === 'auto' ? 'auto' : 'shadow',
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
      authority: body.authority === 'auto' || body.authority === 'shadow' ? body.authority : cur.authority,
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
