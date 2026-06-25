// Climate guardrails: validate/clamp EVERY climate command BEFORE it is issued.
// Mirror of the battery guardrails philosophy — these functions NEVER throw; they
// return { ok, value, reason } so the executor can log a rejection and move on.
// Default-deny: if we cannot prove a command is safe, we reject it.

import * as store from '../store';
import type { Band } from '../tariff';
import type { ClimateMode, ClimateGuardrails, DeviceSettings } from '../store';

export type ClimateLever = 'power' | 'mode' | 'setpoint' | 'fan' | 'vaneUpDown' | 'vaneLeftRight';

export interface GuardResult<T = string | number | boolean> {
  ok: boolean;
  value: T;
  reason: string;
}

const ALLOWED_MODES: ClimateMode[] = ['auto', 'heat', 'dry', 'fan', 'cool'];

/** Live signals the climate guardrails reason about. */
export interface ClimateSnapshot {
  /** Age of the live data (ms). Commands abort if this is stale. */
  ageMs: number;
  band: Band;
  /** Current grid import in kW (+import). Used for the 14 kW cap. */
  gridImportKw: number;
  /** Projected extra import (kW) the in-flight batch has already committed. */
  pendingImportKw: number;
}

export const MAX_DATA_AGE_MS = 120_000;
/** Budgeted import draw of one AC compressor starting (kW). */
export const COMPRESSOR_START_KW = 1.2;

function g(): ClimateGuardrails {
  return store.get().devices.guardrails;
}

/** Snapshot must be fresh, or every command is rejected. */
export function freshnessOk(snap: ClimateSnapshot): GuardResult<boolean> {
  if (snap.ageMs > MAX_DATA_AGE_MS) {
    return {
      ok: false,
      value: false,
      reason: `live data stale (${Math.round(snap.ageMs / 1000)}s > ${MAX_DATA_AGE_MS / 1000}s) — aborting`,
    };
  }
  return { ok: true, value: true, reason: 'fresh' };
}

// ---- Setpoint ---------------------------------------------------------------
// Clamp to the device's reported min/max where available, then to the global
// guardrail band (16–30), then to the per-device comfort floor/ceiling.
export function checkSetpoint(
  target: number,
  device: { minSetpointC: number | null; maxSetpointC: number | null },
  settings: DeviceSettings | undefined,
): GuardResult<number> {
  const gr = g();
  let v = Math.round(target * 2) / 2; // half-degree precision
  const reasons: string[] = [];

  const lo = Math.max(gr.setpointMinC, device.minSetpointC ?? gr.setpointMinC, settings?.comfortFloorC ?? -Infinity);
  const hi = Math.min(gr.setpointMaxC, device.maxSetpointC ?? gr.setpointMaxC, settings?.comfortCeilingC ?? Infinity);

  if (v < lo) {
    reasons.push(`clamped up to floor ${lo}°C`);
    v = lo;
  }
  if (v > hi) {
    reasons.push(`clamped down to ceiling ${hi}°C`);
    v = hi;
  }
  return { ok: true, value: v, reason: reasons.length ? reasons.join('; ') : 'ok' };
}

// ---- Mode -------------------------------------------------------------------
export function checkMode(mode: string): GuardResult<ClimateMode> {
  if (!ALLOWED_MODES.includes(mode as ClimateMode)) {
    return { ok: false, value: 'cool', reason: `invalid climate mode '${mode}'` };
  }
  return { ok: true, value: mode as ClimateMode, reason: 'ok' };
}

// ---- Power ------------------------------------------------------------------
// Powering OFF is always safe; powering ON is permitted here (the import cap is
// enforced separately by checkImportHeadroom). Quiet-hours blocking was removed —
// time-of-day stand-down is now expressed per-rule via the tariff-band restriction.
export function checkPower(on: boolean): GuardResult<boolean> {
  if (!on) return { ok: true, value: false, reason: 'power off (always safe)' };
  return { ok: true, value: true, reason: 'ok' };
}

// ---- 14 kW import cap (compressor staggering) ------------------------------
// A new compressor START adds ~COMPRESSOR_START_KW. Reject a start that would push
// projected import (current + already-committed pending) over the cap.
export function checkImportHeadroom(snap: ClimateSnapshot): GuardResult<boolean> {
  const gr = g();
  const projected = snap.gridImportKw + snap.pendingImportKw + COMPRESSOR_START_KW;
  if (projected > gr.gridImportCapKw) {
    return {
      ok: false,
      value: false,
      reason: `would push import to ${projected.toFixed(1)}kW > ${gr.gridImportCapKw}kW cap — deferring start`,
    };
  }
  return { ok: true, value: true, reason: 'within import cap' };
}

// ---- Vanes ------------------------------------------------------------------
// A vane position is 0 (auto/A) or a fixed 1..5. Swing (10) is accepted as-is.
// Anything else is rejected so a bad value never reaches the unit.
export function checkVane(value: number): GuardResult<number> {
  const v = Math.round(value);
  if (v === 0 || v === 10 || (v >= 1 && v <= 5)) return { ok: true, value: v, reason: 'ok' };
  return { ok: false, value: 0, reason: `invalid vane position '${value}'` };
}

export type { Band };
