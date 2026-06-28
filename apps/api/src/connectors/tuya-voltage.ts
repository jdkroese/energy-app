// Grid-voltage monitor reader. Picks ONE metering breaker from the Tuya fleet and
// reads its live electrical values for BOTH the Live KPI box and the `rule-voltage`
// alert, so the two never disagree. READ-ONLY — it never writes a device.
//
// A metering breaker exposes `cur_voltage` / `cur_current` / `cur_power` as raw
// device units; the real value is `raw / 10^scale` from the Tuya spec (e.g.
// cur_voltage scale 1 = deci-volts: 2251 → 225.1 V; cur_power scale 1 = deci-watts:
// 372 → 37.2 W; cur_current scale 0 = mA). Same scaling the breaker-card gauges use.
//
// Breaker selection (read-only, so we do NOT require the device to be "set up" in the
// onboarding flow — any paired metering breaker is fair game; mains voltage is common
// to the whole house so which one barely matters for the KPI):
//   1. Candidates = fleet devices of a breaker category OR exposing `cur_voltage`.
//   2. Honour voltageMonitor.breakerId when that device is reporting voltage; else the
//      first candidate currently reporting voltage; else the first candidate. Persist
//      the pick so it's stable.
//   3. If no candidate at all → null (KPI empty-states, alert no-ops).

import * as tuya from './tuya';
import type { TuyaDevice, TuyaSpec } from './tuya';
import { specScale } from './tuya-generic';
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

/** Tuya categories that are metering circuit breakers / energy meters. */
const BREAKER_CATEGORIES = new Set(['tdq', 'zndb', 'dlq']);
function isBreaker(d: TuyaDevice): boolean {
  return BREAKER_CATEGORIES.has(d.category);
}

function statusNum(d: TuyaDevice, code: string): number | null {
  const item = d.status.find((s) => s.code === code);
  if (!item) return null;
  const n = typeof item.value === 'number' ? item.value : Number(item.value);
  return Number.isFinite(n) ? n : null;
}

/** Whether the device is currently reporting a numeric `cur_voltage`. */
function reportsVoltage(d: TuyaDevice): boolean {
  return statusNum(d, VOLTAGE_DP) !== null;
}

/** A device that could be the voltage source: a breaker category, or anything that
 *  reports `cur_voltage` (so an oddly-categorised metering device still qualifies). */
function isCandidate(d: TuyaDevice): boolean {
  return isBreaker(d) || reportsVoltage(d);
}

/**
 * Convert a raw measure DP to real units using the Tuya spec `scale` (raw / 10^scale),
 * falling back to a deci-unit heuristic when the spec omits scale — mirrors the generic
 * `readLiveValue` measure branch so the KPI and the breaker-card gauges agree.
 */
function scaled(raw: number, scale: number | undefined, kind: 'V' | 'mA' | 'W'): number {
  if (scale !== undefined) return raw / 10 ** scale;
  if (kind === 'V' && Math.abs(raw) > 1000) return raw / 10; // deci-volts
  if (kind === 'W' && Math.abs(raw) > 100000) return raw / 10; // deci-watts
  return raw;
}

/**
 * Pick the monitored breaker from the fleet, honouring a persisted/manual breakerId
 * (only when it's still reporting voltage), else the first candidate reporting voltage,
 * else the first candidate. Persists the chosen id (when it changed) so it's stable.
 */
function pickBreaker(all: TuyaDevice[]): TuyaDevice | null {
  const candidates = all.filter(isCandidate);
  if (candidates.length === 0) return null;

  const wantId = store.get().voltageMonitor.breakerId;
  const pinned = wantId ? candidates.find((d) => d.id === wantId) : undefined;
  const chosen =
    (pinned && reportsVoltage(pinned) ? pinned : undefined) ??
    candidates.find(reportsVoltage) ??
    pinned ??
    candidates[0];

  if (store.get().voltageMonitor.breakerId !== chosen.id) {
    store.update((s) => {
      s.voltageMonitor.breakerId = chosen.id;
    });
  }
  return chosen;
}

function read(d: TuyaDevice, spec: TuyaSpec | null): BreakerReading {
  const vRaw = statusNum(d, VOLTAGE_DP) ?? 0;
  const cRaw = statusNum(d, CURRENT_DP) ?? 0; // milliamps (after scale)
  const pRaw = statusNum(d, POWER_DP) ?? 0;
  const cfgName = store.get().deviceOnboarding.configured[d.id]?.name;
  const currentMa = scaled(cRaw, specScale(spec, CURRENT_DP), 'mA');
  return {
    id: d.id,
    name: cfgName ?? d.name,
    voltageV: Math.round(scaled(vRaw, specScale(spec, VOLTAGE_DP), 'V')),
    currentA: Math.round((currentMa / 1000) * 10) / 10, // mA → A, 1dp
    powerW: Math.round(scaled(pRaw, specScale(spec, POWER_DP), 'W')),
  };
}

/**
 * The live reading from the monitored breaker, or null when Tuya isn't connected, the
 * fleet read fails, or no metering breaker is paired. Best-effort: never throws
 * (callers treat a failure as "no breaker").
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
  if (!d) return null;
  // Spec carries the per-DP scale (cached 1h). Tolerate a miss — the heuristic covers it.
  const spec = await tuya.getSpecifications(d.id).catch(() => null);
  return read(d, spec);
}
