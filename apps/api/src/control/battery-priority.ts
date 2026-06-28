// Battery-priority decision logic — PURE functions, no I/O, never throw. The
// coordinator calls planBatteryPriority() each tick and applies the result via
// the guardrailed issue() path (or just logs it, in 'shadow' authority).
//
// Two policies, both aimed at keeping the Tesla (the only battery with a backup
// feature) full for outages:
//   • dischargeSonnenFirst — when the house is drawing, the coordinator force-
//     discharges the Sonnen to cover the WHOLE house draw (load-following) and puts
//     the Tesla in `backup` mode, so the Sonnen supplies everything and the Tesla
//     idles and HOLDS its charge. This plan only decides WHEN to hold (holdTesla):
//     release the Tesla once the Sonnen is depleted OR the grid import shows the
//     Sonnen can't keep up beyond the throughput cap. (The old mechanism — raising
//     the Tesla's backup reserve to its SoC — was unreliable and is gone.)
//   • chargeTeslaFirst — when there's solar surplus, IDLE the Sonnen (manual 0 W)
//     so all surplus charges the Tesla first and restores backup capacity. Release
//     the Sonnen once the Tesla is full OR the surplus exceeds the throughput cap.
//
// Only one regime is ever active at a tick: either there's net surplus (charge
// rule governs) or there isn't (discharge rule governs).

import type { RichSnapshot } from './snapshot';
import type { BatteryPriority, BatteryPriorityAuthority } from '../store';

/** Ignore grid-meter noise below this (kW) when deciding the regime. */
const NEUTRAL_KW = 0.2;

export interface DischargePlan {
  /** Rule is enabled. */
  active: boolean;
  authority: BatteryPriorityAuthority;
  /** Hold the Tesla so the Sonnen discharges first. When true, the coordinator force-
   *  discharges the Sonnen to cover the whole house draw and sets the Tesla to `backup`
   *  mode, so the Tesla idles and holds its charge. */
  holdTesla: boolean;
  /** @deprecated Unused since the load-following + Tesla-backup rework. The hold no longer
   *  raises the Tesla reserve (that write was unreliable and capped at 80%). Kept on the
   *  type to minimise churn; always null. */
  reserveHoldPct: number | null;
  reason: string;
}

export interface ChargePlan {
  active: boolean;
  authority: BatteryPriorityAuthority;
  /** Idle the Sonnen (manual 0 W) so the Tesla charges first. */
  holdSonnen: boolean;
  reason: string;
}

export interface PriorityPlan {
  discharge: DischargePlan;
  charge: ChargePlan;
}

/**
 * Decide the discharge-priority stance — i.e. WHEN to hold the Tesla so the Sonnen
 * discharges first. The actual hold is done by the coordinator (Sonnen load-following
 * force-discharge + Tesla `backup` mode); this function just gates it. `baseReservePct`
 * is retained for signature stability but no longer used to raise the Tesla reserve.
 */
export function decideDischarge(
  rule: BatteryPriority['dischargeSonnenFirst'],
  snap: RichSnapshot,
  _baseReservePct: number,
  socFloorPct: number,
): DischargePlan {
  const base: Omit<DischargePlan, 'reason'> = {
    active: rule.enabled,
    authority: rule.authority,
    holdTesla: false,
    reserveHoldPct: null,
  };
  if (!rule.enabled) return { ...base, reason: 'disabled' };

  // Surplus regime → the charge rule manages the Tesla; do not hold it (it should
  // be free to charge), so the discharge rule stands down.
  if (snap.gridExportKw > NEUTRAL_KW) {
    return { ...base, reason: 'solar surplus — discharge priority idle' };
  }
  if (snap.sonnenSoc === null) return { ...base, reason: 'Sonnen offline — cannot prioritise' };
  if (snap.teslaSoc === null) return { ...base, reason: 'Tesla offline — cannot hold' };
  if (snap.sonnenSoc <= socFloorPct) {
    return { ...base, reason: `Sonnen ${snap.sonnenSoc}% at floor — Tesla released to discharge` };
  }
  if (snap.gridImportKw > rule.throughputKw) {
    return {
      ...base,
      reason: `grid import ${snap.gridImportKw.toFixed(1)}kW > ${rule.throughputKw}kW cap — Tesla joins`,
    };
  }
  return {
    ...base,
    holdTesla: true,
    reason: `Sonnen covers the house (SoC ${snap.sonnenSoc}%) so the Tesla idles and holds (Tesla SoC ${snap.teslaSoc}%) — Sonnen discharges first`,
  };
}

/** Decide the charge-priority stance (only meaningful while there's surplus). */
export function decideCharge(
  rule: BatteryPriority['chargeTeslaFirst'],
  snap: RichSnapshot,
): ChargePlan {
  const base: Omit<ChargePlan, 'reason'> = {
    active: rule.enabled,
    authority: rule.authority,
    holdSonnen: false,
  };
  if (!rule.enabled) return { ...base, reason: 'disabled' };

  if (snap.gridExportKw <= NEUTRAL_KW) {
    return { ...base, reason: 'no solar surplus — charge priority idle' };
  }
  if (snap.teslaSoc === null) return { ...base, reason: 'Tesla offline — cannot prioritise' };
  if (snap.teslaSoc >= 100) {
    return { ...base, reason: 'Tesla full — Sonnen free to charge' };
  }
  if (snap.gridExportKw > rule.throughputKw) {
    return {
      ...base,
      reason: `surplus ${snap.gridExportKw.toFixed(1)}kW > ${rule.throughputKw}kW cap — Sonnen joins`,
    };
  }
  return {
    ...base,
    holdSonnen: true,
    reason: `idle Sonnen — Tesla charges first (SoC ${snap.teslaSoc}%, restore backup)`,
  };
}

export function planBatteryPriority(
  snap: RichSnapshot,
  bp: BatteryPriority,
  baseReservePct: number,
  socFloorPct: number,
): PriorityPlan {
  return {
    discharge: decideDischarge(bp.dischargeSonnenFirst, snap, baseReservePct, socFloorPct),
    charge: decideCharge(bp.chargeTeslaFirst, snap),
  };
}
