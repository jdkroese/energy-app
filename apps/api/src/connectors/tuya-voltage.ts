// Grid-voltage monitor reader (Tuya breakers, category `tdq`). A breaker exposes
// `cur_voltage` (×0.1 V → reported as V*10 raw on most firmwares), `cur_current`
// (mA) and `cur_power` (×0.1 W). This module picks the monitored breaker and reads
// its live electrical values for BOTH the Live KPI box and the `rule-voltage` alert,
// so the two never disagree. READ-ONLY — it never writes a device.
//
// Breaker selection (every breaker reports voltage, so we never gate on the DP
// being present in a given snapshot — a poll that momentarily lacks cur_voltage
// must not blank the KPI):
//   1. If voltageMonitor.breakerId is set AND that device is still a configured
//      breaker → use it.
//   2. Otherwise the FIRST configured breaker (preferring one already reporting a
//      voltage in this snapshot) → and persist its id so the choice is stable.
//   3. If no configured breaker at all → null (KPI empty-states, alert no-ops).

import * as tuya from './tuya';
import type { TuyaDevice } from './tuya';
import * as store from '../store';

/** Live electrical reading from the monitored breaker. */
export interface BreakerReading {
  id: string;
  name: string;
  voltageV: number;
  currentA: number;
  powerW: number;
}

const VOLTAGE_DP = 'cur_voltage';
const CURRENT_DP = 'cur_current';
const POWER_DP = 'cur_power';

/** A Tuya circuit-breaker / energy-meter category that reports `cur_voltage`. */
function isBreaker(d: TuyaDevice): boolean {
  return d.category === 'tdq' || d.category === 'zndb';
}

function statusNum(d: TuyaDevice, code: string): number | null {
  const item = d.status.find((s) => s.code === code);
  if (!item) return null;
  const n = typeof item.value === 'number' ? item.value : Number(item.value);
  return Number.isFinite(n) ? n : null;
}

/** Whether the breaker is currently reporting a numeric `cur_voltage` (selection
 * preference only — a breaker that momentarily isn't is still eligible). */
function reportsVoltage(d: TuyaDevice): boolean {
  return statusNum(d, VOLTAGE_DP) !== null;
}

/**
 * Tuya breakers report `cur_voltage` in deci-volts (e.g. 2305 = 230.5 V) on the
 * common firmwares. Heuristic: a value ≳ 1000 is deci-volts → ÷10; a plain value in
 * a household mains range is already volts. Keeps display sane across firmwares.
 */
function toVolts(raw: number): number {
  return raw > 1000 ? raw / 10 : raw;
}

/** `cur_power` is deci-watts on most breakers (e.g. 12345 = 1234.5 W). */
function toWatts(raw: number): number {
  return raw > 100000 ? raw / 10 : raw;
}

/**
 * Pick the monitored breaker from the fleet, honouring a persisted/manual breakerId
 * when that device is still a configured breaker, else the first configured breaker
 * (preferring one already reporting voltage in this snapshot). Persists the chosen id
 * (when it changed) so the selection is stable.
 */
function pickBreaker(all: TuyaDevice[]): TuyaDevice | null {
  const configuredIds = new Set(Object.keys(store.get().deviceOnboarding.configured));
  const candidates = all.filter((d) => configuredIds.has(d.id) && isBreaker(d));
  if (candidates.length === 0) return null;

  const wantId = store.get().voltageMonitor.breakerId;
  const preferred = wantId ? candidates.find((d) => d.id === wantId) : undefined;
  const chosen = preferred ?? candidates.find(reportsVoltage) ?? candidates[0];

  // Persist the auto-pick (or a corrected pick when the saved id vanished) so it sticks.
  if (store.get().voltageMonitor.breakerId !== chosen.id) {
    store.update((s) => {
      s.voltageMonitor.breakerId = chosen.id;
    });
  }
  return chosen;
}

function read(d: TuyaDevice): BreakerReading {
  const vRaw = statusNum(d, VOLTAGE_DP) ?? 0;
  const cRaw = statusNum(d, CURRENT_DP) ?? 0; // milliamps
  const pRaw = statusNum(d, POWER_DP) ?? 0;
  const cfgName = store.get().deviceOnboarding.configured[d.id]?.name;
  return {
    id: d.id,
    name: cfgName ?? d.name,
    voltageV: Math.round(toVolts(vRaw)),
    currentA: Math.round((cRaw / 1000) * 10) / 10, // mA → A, 1dp
    powerW: Math.round(toWatts(pRaw)),
  };
}

/**
 * The live reading from the monitored breaker, or null when Tuya isn't connected, the
 * fleet read fails, or no configured breaker exposes `cur_voltage`. Best-effort: never
 * throws (callers treat a failure as "no breaker").
 */
export async function getMonitoredBreaker(): Promise<BreakerReading | null> {
  if (!tuya.isConfigured()) return null;
  let all: TuyaDevice[];
  try {
    all = await tuya.getDevices();
  } catch {
    return null;
  }
  const d = pickBreaker(all);
  return d ? read(d) : null;
}
