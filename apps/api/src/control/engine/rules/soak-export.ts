// soak-export as a RuleDef (docs/40 §3 — the Phase 1a "proof" rule).
//
// This is a faithful, PURE port of the legacy soak-export branch inside
// coordinator.ts::coordinateSonnen() (the "(A) FREE SOLAR — soak-export" block). It emits a
// CLAIM on `sonnen.stance` instead of calling issue(); the arbiter + engine turn that claim
// into a would-issue intent that the shadow-comparator diffs against what the legacy branch
// actually did. Parity is unit-tested across engage / hold / revert / hysteresis / ceiling.
//
// LEGACY DECISION being mirrored (coordinator.ts):
//   exporting        = exportW > stopW
//   engageThreshold  = inManual ? stopW : startW          // hysteresis: high to engage, low to hold
//   ENGAGE/HOLD  when exportW > engageThreshold && socPct < socCeilingPct
//                 → manual ('1') + charge min(exportW, sonnenMaxW)
//   REVERT       when inManual && (exportW <= stopW || socPct >= socCeilingPct)
//                 → self-consumption ('2')
//   else stand down (no claim)
//
// The "inManual" latch in the legacy code is the LIVE Sonnen mode read (s.mode === 'manual').
// The engine can't read live device mode as its own state (it issues nothing, so the device
// never reflects an engine intent), so the rule keeps its OWN hysteresis latch in RuleMemory
// (`soaking`): true once it claims a charge, false once it claims a revert / stands down. This
// makes the rule self-contained (docs/40 §3 — hysteresis stays inside rules) and matches the
// legacy device-mode latch tick-for-tick when the legacy path is executing.

import type { Claim, RuleDef, RuleMemory } from '../types';
import { PRIORITY } from '../types';
import type { ReconciledSnapshot } from '../reconciled-snapshot';

export interface SoakExportParams {
  enabled: boolean;
  /** Engage once net grid export exceeds this (W). */
  startW: number;
  /** Revert once export drops below this (W). Must be < startW (hysteresis). */
  stopW: number;
  /** Don't force-charge at/above this SoC (%). */
  socCeilingPct: number;
  /** Hard cap on the charge setpoint (W) — the sonnenMaxW guardrail (4600). */
  sonnenMaxW: number;
}

/** The rule's persisted memory: the hysteresis latch (are we currently soaking?). */
interface SoakMemory extends RuleMemory {
  soaking?: boolean;
}

/**
 * PURE decision. Reads the reconciled snapshot's Sonnen-domain export (`gridExportW`, same
 * domain as the legacy branch's `snap.gridExportKw`) + the live Sonnen SoC, and the rule's
 * own `soaking` latch. Emits 0 or 1 claims on `sonnen.stance`. Never throws.
 *
 * Note the actuator VALUE mirrors what the legacy branch issued:
 *   • ENGAGE/HOLD → { mode:'1', chargeW } with clamp:'absorb' (so the arbiter caps it at the
 *     reconciled surplus — the engine-wide generalization of "never import while soaking").
 *   • REVERT      → { mode:'2' } (self-consumption).
 * A stand-down emits NO claim, so the actuator falls to its safe default (self-consumption)
 * unless another rule claims it.
 */
export function decideSoakExport(
  snap: ReconciledSnapshot,
  params: SoakExportParams,
  mem: SoakMemory,
): Claim[] {
  if (!params.enabled) {
    // Disabled: if we were soaking, claim a revert once so a stale latch can't strand. Then
    // clear the latch. (The legacy "disabled un-strand" is a priority revert; here it's an
    // ordinary claim — the arbiter/execute path is unchanged, this is shadow-only.)
    if (mem.soaking) {
      mem.soaking = false;
      return [revertClaim('soak disabled — end force-charge, back to self-consumption')];
    }
    return [];
  }

  // Export is only trustworthy in the Sonnen domain (where the residual lives). If the grid
  // figure came from the Tesla fallback, the legacy soak branch (which reads the Sonnen) would
  // not have run at all, so stand down for parity.
  const exportW = snap.gridSource === 'sonnen' ? snap.gridExportW : 0;
  const socPct = snap.sonnenSoc;
  if (socPct === null) {
    // Sonnen offline → the legacy branch returns early (no Sonnen); stand down + drop the latch.
    mem.soaking = false;
    return [];
  }

  const soaking = mem.soaking === true;

  // REVERT (safety-critical, mirrors legacy): we were soaking and export collapsed to ≤ stopW
  // OR the battery reached the ceiling → hand back to self-consumption.
  if (soaking && (exportW <= params.stopW || socPct >= params.socCeilingPct)) {
    const why =
      socPct >= params.socCeilingPct
        ? `SoC ${socPct}% ≥ ceiling`
        : `export ${Math.round(exportW)}W ≤ ${params.stopW}W`;
    mem.soaking = false;
    return [revertClaim(`end soak-export (${why}) — back to self-consumption`)];
  }

  // ENGAGE / HOLD (hysteresis): high startW to engage, low stopW to hold once soaking.
  const engageThreshold = soaking ? params.stopW : params.startW;
  if (exportW > engageThreshold && socPct < params.socCeilingPct) {
    const wantW = Math.min(exportW, params.sonnenMaxW);
    mem.soaking = true;
    return [
      {
        actuator: 'sonnen.stance',
        value: { mode: '1', chargeW: Math.round(wantW), dischargeW: 0 },
        ruleId: 'soak-export',
        priority: PRIORITY.ECONOMIC,
        reason: `soak-export — absorb surplus before it spills (export ${Math.round(exportW)}W, SoC ${socPct}%)`,
        clamp: 'absorb',
      },
    ];
  }

  // Below the engage threshold and not soaking (or at/over the ceiling): stand down, latch off.
  // No claim → the actuator falls to self-consumption unless another rule claims it (parity:
  // the legacy branch fell through to self-consumption here too).
  mem.soaking = false;
  return [];
}

function revertClaim(reason: string): Claim {
  return {
    actuator: 'sonnen.stance',
    value: { mode: '2', chargeW: 0, dischargeW: 0 },
    ruleId: 'soak-export',
    priority: PRIORITY.ECONOMIC,
    reason,
  };
}

/** The registered rule. Params are injected from config in P1c; the engine seeds them from
 *  store.control.soakExport (+ the sonnenMaxW guardrail) each tick in P1a. */
export const soakExportRule: RuleDef<SoakExportParams> = {
  id: 'soak-export',
  domain: 'battery',
  priority: PRIORITY.ECONOMIC,
  params: {
    // Placeholder defaults (mirror store.defaultSoakExport() + the guardrail); the engine
    // overwrites these from live config each tick so the shadow decision uses the SAME params
    // the legacy branch used.
    enabled: true,
    startW: 400,
    stopW: 150,
    socCeilingPct: 98,
    sonnenMaxW: 4600,
  },
  decide: (snap, params, mem) => decideSoakExport(snap, params, mem as SoakMemory),
};
