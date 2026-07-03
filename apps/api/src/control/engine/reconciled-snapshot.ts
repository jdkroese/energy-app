// Reconciled snapshot (docs/40 D5 — "load-bearing").
//
// The deepest structural enabler of the 2026-07 incident cluster was TWO unreconciled
// meter domains: the legacy coordinator arbitrates grid direction off the Tesla gateway
// meter, which is blind to the Sonnen+Sungrow metering domain, and — worse — an actuator
// (the Sonnen) moves the very meter that decides its own next action (the #178 runaway:
// `drawW` counted the Sonnen's own discharge as house load and self-latched to 4.6 kW).
//
// This pure builder derives ONE agreed physics view every engine rule reads, computed so
// the deciding signals are NOT corrupted by any actuator's own flow. The core is the
// generalization of PR #178's `decideDischargeTarget()` from one rule to the whole engine:
//
//   houseResidualW = load − PV, taken from the Sonnen's OWN meter (production/consumption),
//                    which is self-consistent and excludes the battery's own charge/discharge.
//
// The Sonnen's `consumptionW` is the house load the Sonnen meter sees; `productionW` is PV
// at the Sonnen's CT. Neither includes the Sonnen's battery flow, so `load − PV` is the real
// non-PV house demand regardless of what the Sonnen battery is doing — exactly the signal an
// actuator may safely chase without moving it. (Contrast the Tesla gridKw, which nets the
// batteries' flows and so IS corrupted by them.)
//
// PURE + total: no I/O, no throws, no store access. Everything it needs is on the RichSnapshot
// plus an optional Sungrow production reading (the second production source in the Sonnen
// domain), passed in by the caller so this module stays pure and unit-testable.

import type { RichSnapshot } from '../snapshot';

export type GridDirection = 'import' | 'export' | 'neutral';

/** Which metering domain a derived figure was reasoned in (audit trail for D5). */
export type GridSource = 'sonnen' | 'tesla' | 'none';

export interface ReconciledSnapshot {
  /** Copied straight through — rules commonly gate on the tariff band. */
  band: RichSnapshot['band'];
  /** Live-read age (ms). Rules SHOULD stand down when this is stale; the arbiter/engine
   *  does not itself re-implement the freshness guard (that stays in guardrails/execute). */
  ageMs: number;

  /** Net grid direction after the neutral deadband. Derived from the Sonnen domain when the
   *  Sonnen is live (its meter is where houseResidualW is trustworthy); Tesla-gateway fallback
   *  otherwise. `neutral` when |flow| ≤ neutralW. */
  gridDirection: GridDirection;
  /** Which domain gridDirection / import / export were read from. */
  gridSource: GridSource;
  /** Net grid import (W, ≥0). 0 unless direction === 'import'. */
  gridImportW: number;
  /** Net grid export (W, ≥0). 0 unless direction === 'export'. */
  gridExportW: number;

  /**
   * House demand the PV isn't covering (W, ≥0) — `max(0, load − PV)` from the Sonnen's own
   * meter, so it is NOT corrupted by any battery's own flow (the #178 fix, generalized). A
   * discharge claim is clamped to this: the Sonnen can never be told to supply more than the
   * house actually needs, so it can never push its own discharge to the grid. null when the
   * Sonnen (the load+PV meter) is offline — no trustworthy residual, so discharge rules stand
   * down rather than reason off the batteries-netted Tesla meter.
   */
  houseResidualW: number | null;
  /**
   * Surplus available to absorb (W, ≥0) — the would-be grid export. An absorb (force-charge)
   * claim is clamped to this so a soak/charge rule can never import from the grid. Uses the
   * Sonnen export when live (same domain as the residual), Tesla fallback.
   */
  surplusW: number;

  /** Live SoCs (%), null when offline — passed through for rule gating (floors, ceilings). */
  sonnenSoc: number | null;
  teslaSoc: number | null;

  /**
   * Energy-balance gap between the two meter domains (W, ≥0): |Tesla-domain grid net −
   * Sonnen-domain grid net|, reconstructing each domain's grid figure from its own flows.
   * This is the ~7 kW gap docs/40 D5 calls out; a `meter-disagreement` watchdog (P2) alerts
   * when it exceeds tolerance. null when a domain is offline (can't compare). Informational
   * in P1a — no rule acts on it yet.
   */
  meterDisagreementW: number | null;

  /** The raw snapshot, for rules that need a field not surfaced here (kept read-only). */
  raw: RichSnapshot;
}

/** Grid-noise deadband (W). Below this, the grid is `neutral` (mirrors the coordinator's
 *  NEUTRAL_KW = 0.2 kW regime gate, in watts). */
export const NEUTRAL_W = 200;

/** Residual deadband (W). Mirrors coordinator DISCHARGE_DEADBAND_W — a residual at/under
 *  this is treated as zero so meter noise near the zero-crossing doesn't provoke a claim. */
export const RESIDUAL_DEADBAND_W = 300;

function round(w: number): number {
  return Math.round(w);
}

/**
 * Build the reconciled snapshot from a RichSnapshot (+ optional Sungrow production, the
 * second PV source in the Sonnen domain). Pure and total.
 *
 * @param snap                the legacy RichSnapshot (both device views + tariff band)
 * @param sungrowProductionW  Sungrow inverters' AC power (W) if known, for domain reconciliation
 * @param neutralW            grid neutral deadband (W)
 */
export function buildReconciledSnapshot(
  snap: RichSnapshot,
  sungrowProductionW: number | null = null,
  neutralW = NEUTRAL_W,
): ReconciledSnapshot {
  const s = snap.sonnen;
  const t = snap.tesla;

  // ---- Grid direction/import/export ----------------------------------------
  // Prefer the Sonnen domain when it's live: that's the domain houseResidualW is trustworthy
  // in, so keeping grid direction in the SAME domain avoids a rule reading export from one
  // meter and residual from another. Sonnen `gridFeedInW`: + export / − import.
  let gridSource: GridSource = 'none';
  let netExportW = 0; // + export, − import
  if (s) {
    gridSource = 'sonnen';
    netExportW = s.gridFeedInW;
  } else if (t) {
    gridSource = 'tesla';
    // Tesla gridKw: + import. Flip sign to the + export convention.
    netExportW = -t.gridKw * 1000;
  }

  let gridDirection: GridDirection = 'neutral';
  let gridImportW = 0;
  let gridExportW = 0;
  if (netExportW > neutralW) {
    gridDirection = 'export';
    gridExportW = round(netExportW);
  } else if (netExportW < -neutralW) {
    gridDirection = 'import';
    gridImportW = round(-netExportW);
  }

  // ---- House residual (D5 core — NOT corrupted by battery flow) -------------
  // load − PV from the Sonnen's OWN meter. Both are measured at the Sonnen CT and exclude the
  // Sonnen battery's own charge/discharge, so this is the real non-PV house demand no matter
  // what the battery is doing. When the Sonnen is offline we have no trustworthy residual
  // (the Tesla gridKw nets the batteries' flows and would reintroduce the #178 corruption), so
  // we report null and discharge rules must stand down rather than guess.
  let houseResidualW: number | null = null;
  if (s) {
    const pvW = s.productionW ?? 0;
    const loadW = s.consumptionW ?? 0;
    const residual = Math.max(0, loadW - pvW);
    houseResidualW = residual <= RESIDUAL_DEADBAND_W ? 0 : round(residual);
  }

  // ---- Surplus to absorb ----------------------------------------------------
  // The would-be export (same domain as the residual). An absorb claim is clamped to this.
  const surplusW = gridDirection === 'export' ? gridExportW : 0;

  // ---- Meter-domain disagreement (informational in P1a) --------------------
  // Reconstruct each domain's grid net from its OWN flows and compare. The Sonnen domain's
  // grid net is its metered gridFeedInW (already domain-native). The Tesla domain's grid net
  // is its gateway gridKw. The two SHOULD agree; docs/40 observed a ~7 kW gap. We surface the
  // magnitude so a P2 watchdog can alert; no rule reacts to it here.
  let meterDisagreementW: number | null = null;
  if (s && t) {
    const sonnenGridExportW = s.gridFeedInW; // + export
    const teslaGridExportW = -t.gridKw * 1000; // + export
    meterDisagreementW = round(Math.abs(sonnenGridExportW - teslaGridExportW));
  }

  // sungrowProductionW is retained on the reconciled view via `raw` consumers today; it is
  // accepted here so the balance check can later fold in the second PV source without a
  // signature change. (In P1a the Sonnen CT already meters whole-house PV+load for the
  // residual, so the Sungrow figure is not needed for houseResidualW.)
  void sungrowProductionW;

  return {
    band: snap.band,
    ageMs: snap.ageMs,
    gridDirection,
    gridSource,
    gridImportW,
    gridExportW,
    houseResidualW,
    surplusW,
    sonnenSoc: snap.sonnenSoc,
    teslaSoc: snap.teslaSoc,
    meterDisagreementW,
    raw: snap,
  };
}
