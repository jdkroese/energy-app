// Guardrails: validate/clamp EVERY command BEFORE it is issued. These functions
// never throw — they return { ok, value, reason } so the executor can log a
// rejection and move on. The default-deny posture: if we cannot prove a command
// is safe (e.g. live data is missing/stale), we reject it.

import * as store from '../store';
import type { Band } from '../tariff';
import type { ControlDevice } from '../store';

export type Lever =
  | 'mode' // sonnen EM_OperatingMode | tesla default_real_mode
  | 'reserve' // sonnen EM_USOC | tesla backup_reserve_percent
  | 'charge' // sonnen force-charge watts
  | 'discharge' // sonnen force-discharge watts
  | 'gridExport'; // tesla grid_import_export (grid-charge enable + export rule)

export interface GuardResult<T = string | number> {
  ok: boolean;
  value: T;
  reason: string;
}

/** Live signals the guardrails need to reason about a command safely. */
export interface ControlSnapshot {
  /** Age of the live data (ms). Commands abort if this is stale. */
  ageMs: number;
  band: Band;
  /** Per-device live SoC (%), or null when that device is offline. */
  sonnenSoc: number | null;
  teslaSoc: number | null;
  /** Tesla's current backup_reserve_percent (we never set below it). */
  teslaReservePct: number;
  /** Current grid import in kW (+import). Used for the 14 kW cap. */
  gridImportKw: number;
  /** Active scenario (drives whether grid-charge is even permissible). */
  scenario: store.ScenarioDef;
}

export const MAX_DATA_AGE_MS = 120_000;

function g(): store.ControlGuardrails {
  return store.get().control.guardrails;
}

/** Snapshot must be fresh, or every command is rejected. */
export function freshnessOk(snap: ControlSnapshot): GuardResult<boolean> {
  if (snap.ageMs > MAX_DATA_AGE_MS) {
    return {
      ok: false,
      value: false,
      reason: `live data stale (${Math.round(snap.ageMs / 1000)}s > ${MAX_DATA_AGE_MS / 1000}s) — aborting`,
    };
  }
  return { ok: true, value: true, reason: 'fresh' };
}

// ---- Tesla reserve ----------------------------------------------------------
// reserve ∈ [teslaReserveMinPct, 100]. TWO-WAY: the owner (and Auto) may RAISE or
// LOWER reserve to the requested value; the hard floor is the only safety net —
// values below it are clamped UP to the floor (never rejected), so the floor can
// never be breached. (The former one-way "never lower than current" rule blocked
// a normal request like 23%→20% from ever saving.)
export function checkTeslaReserve(pct: number, _snap: ControlSnapshot): GuardResult<number> {
  const gr = g();
  let v = Math.round(pct);
  if (v > 100) v = 100;
  if (v < gr.teslaReserveMinPct) {
    return {
      ok: true,
      value: gr.teslaReserveMinPct,
      reason: `reserve ${v}% clamped up to floor ${gr.teslaReserveMinPct}%`,
    };
  }
  return { ok: true, value: v, reason: 'ok' };
}

// ---- Sonnen reserve (EM_USOC) ----------------------------------------------
export function checkSonnenReserve(pct: number): GuardResult<number> {
  const gr = g();
  let v = Math.round(pct);
  if (v < gr.socFloorPct) v = gr.socFloorPct; // clamp up to the floor
  if (v > 100) v = 100;
  return { ok: true, value: v, reason: 'ok' };
}

// ---- Sonnen setpoint watts --------------------------------------------------
// watts ∈ [0, sonnenMaxW]. For DISCHARGE, also refuse to pull the battery below
// the SoC floor (read live SoC first).
export function checkSonnenWatts(
  watts: number,
  kind: 'charge' | 'discharge',
  snap: ControlSnapshot,
): GuardResult<number> {
  const gr = g();
  let v = Math.round(watts);
  if (v < 0) v = 0;
  if (v > gr.sonnenMaxW) v = gr.sonnenMaxW;

  if (kind === 'discharge' && v > 0) {
    if (snap.sonnenSoc === null) {
      return { ok: false, value: 0, reason: 'Sonnen SoC unknown — refusing to discharge' };
    }
    if (snap.sonnenSoc <= gr.socFloorPct) {
      return {
        ok: false,
        value: 0,
        reason: `Sonnen SoC ${snap.sonnenSoc}% at/below floor ${gr.socFloorPct}% — no discharge`,
      };
    }
  }
  return { ok: true, value: v, reason: 'ok' };
}

// ---- Tesla grid-charge enable ----------------------------------------------
// Enabling grid-charge is ALLOWED ONLY when the active scenario opts in AND the
// current band is P3 (the cheap valley). Disabling is always allowed.
export function checkTeslaGridCharge(enable: boolean, snap: ControlSnapshot): GuardResult<boolean> {
  if (!enable) return { ok: true, value: false, reason: 'grid-charge disabled (always safe)' };
  if (!snap.scenario.gridCharge) {
    return { ok: false, value: false, reason: 'grid-charge not permitted by active scenario' };
  }
  if (snap.band !== 'P3') {
    return {
      ok: false,
      value: false,
      reason: `grid-charge only in P3 (band is ${snap.band}) — rejected`,
    };
  }
  return { ok: true, value: true, reason: 'P3 + scenario.gridCharge — permitted' };
}

// ---- 14 kW import cap -------------------------------------------------------
// Reject any command that would (or already does) push grid import over the cap.
// addedKw = extra import the command itself would introduce (e.g. grid-charging).
export function checkGridImportCap(addedKw: number, snap: ControlSnapshot): GuardResult<boolean> {
  const gr = g();
  const projected = snap.gridImportKw + Math.max(0, addedKw);
  if (projected > gr.gridImportCapKw) {
    return {
      ok: false,
      value: false,
      reason: `would push grid import to ${projected.toFixed(1)}kW > ${gr.gridImportCapKw}kW cap — rejected`,
    };
  }
  return { ok: true, value: true, reason: 'within import cap' };
}

/** Mode strings are validated by type, but keep an explicit allow-list guard. */
export function checkMode(device: ControlDevice, mode: string): GuardResult<string> {
  const allowed =
    device === 'tesla'
      ? ['self_consumption', 'autonomous', 'backup']
      : ['1', '2', '10'];
  if (!allowed.includes(mode)) {
    return { ok: false, value: mode, reason: `invalid ${device} mode '${mode}'` };
  }
  return { ok: true, value: mode, reason: 'ok' };
}
