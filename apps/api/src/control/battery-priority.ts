// Battery-priority decision logic — PURE functions, no I/O, never throw. The
// coordinator calls planBatteryPriority() each tick and applies the result via
// the guardrailed issue() path (or just logs it, in 'shadow' authority).
//
// Two policies, both aimed at keeping the Tesla (the only battery with a backup
// feature) full for outages:
//   • dischargeSonnenFirst — when the house is drawing, HOLD the Tesla (raise its
//     backup reserve to its current SoC so it won't discharge) so the Sonnen
//     covers the load first. Release the Tesla once the Sonnen is depleted OR the
//     grid import shows the Sonnen can't keep up beyond the throughput cap.
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
  /** Hold the Tesla (raise reserve to its SoC) so the Sonnen discharges first. */
  holdTesla: boolean;
  /** Reserve % to set when holding (else null — leave at the scenario floor). */
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
 * Decide the discharge-priority stance. `baseReservePct` is the reserve the active
 * scenario would otherwise set; we only ever RAISE it (to hold the Tesla), never
 * below the floor.
 */
export function decideDischarge(
  rule: BatteryPriority['dischargeSonnenFirst'],
  snap: RichSnapshot,
  baseReservePct: number,
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
  const reserveHoldPct = Math.min(100, Math.max(baseReservePct, Math.ceil(snap.teslaSoc)));
  return {
    ...base,
    holdTesla: true,
    reserveHoldPct,
    reason: `hold Tesla at ${reserveHoldPct}% (SoC ${snap.teslaSoc}%) — Sonnen discharges first`,
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
