// Rule-engine core types (docs/40 §3, Phase 1a chassis).
//
// The engine is a SECOND, SHADOW-ONLY decision path that runs beside the legacy 90s
// coordinator. Rules are declarative + PURE: each `decide()` reads a reconciled snapshot
// and its own persisted memory and emits CLAIMS on actuators; it never touches a device,
// never mutates global state, and MUST NOT throw (the engine wraps it fail-soft anyway).
// The arbiter then resolves, per actuator, the single highest-priority claim into a
// "would-issue" intent. In Phase 1a NOTHING is issued — the intents are only compared
// against what the legacy coordinator actually did (shadow-compare).
//
// This mirrors docs/40's `RuleDef<P>` shape, with two deliberate P1a simplifications:
//   • no zod `paramsSchema` (the API has no zod dep yet; params validation + the
//     auto-generated Rules UI are P1c). Params are plain typed objects here.
//   • `authority` defaults to 'shadow' and is not yet wired to config — every rule runs
//     in shadow in P1a by construction (the engine issues nothing regardless).

import type { ReconciledSnapshot } from './reconciled-snapshot';

// ---- Priority bands (docs/40 D2) -------------------------------------------
// Explicit numeric priority, banded. The arbiter picks the highest number per actuator.
// No two claims on the SAME actuator may share a priority — that would make the winner
// order-dependent (the exact "priority = code position" bug the engine exists to kill),
// so the engine asserts uniqueness at REGISTRATION time (see engine.ts), not per tick.
export const PRIORITY = {
  /** Safety / watchdog reverts + alerts. Always outranks economics. */
  WATCHDOG: 900,
  /** Owner manual holds (a hand on an actuator beats an optimizer). */
  MANUAL: 700,
  /** Economic optimizers: arbitrage, soak-export, battery priority. */
  ECONOMIC: 500,
  /** Comfort: climate pre-cool / pre-heat. */
  COMFORT: 300,
  /** The declared safe default when no rule claims an actuator. */
  DEFAULT: 100,
} as const;

export type PriorityBand = (typeof PRIORITY)[keyof typeof PRIORITY];

// ---- Actuators --------------------------------------------------------------
// The set of things a claim can target in Phase 1a (battery domain only). Each is a
// single-writer resource: exactly one claim wins per actuator per tick. The union is
// deliberately narrow now and grows per domain (hvac.<id>, breaker.<id>, …) in later
// phases (docs/40 §3).
export type Actuator =
  | 'sonnen.stance'
  | 'tesla.mode'
  | 'tesla.reserve'
  | 'tesla.gridCharge';

/** All actuators, for iteration (agreement-rate tables, registration checks). */
export const ACTUATORS: readonly Actuator[] = [
  'sonnen.stance',
  'tesla.mode',
  'tesla.gridCharge',
  'tesla.reserve',
] as const;

// ---- Actuator intent value shapes ------------------------------------------
// The concrete value a claim carries per actuator. These mirror the legacy coordinator's
// issue() vocabulary so the comparator can diff engine-intent vs legacy-issued directly.

/** Sonnen operating stance. `mode:'2'` = self-consumption; `mode:'1'` = manual with a
 *  signed setpoint (`chargeW` > 0 absorbs, `dischargeW` > 0 supplies the house). Exactly
 *  one of chargeW/dischargeW is > 0 (or both 0 for a manual idle). */
export interface SonnenStance {
  mode: '1' | '2';
  /** Force-charge watts (manual only). 0 in self-consumption or a manual idle/discharge. */
  chargeW?: number;
  /** Force-discharge watts (manual only). 0 in self-consumption or a manual idle/charge. */
  dischargeW?: number;
}

export type TeslaMode = 'autonomous' | 'backup' | 'self_consumption';

/** Discriminated by actuator so a Claim's value is correctly typed per target. */
export type ActuatorValue =
  | { actuator: 'sonnen.stance'; value: SonnenStance }
  | { actuator: 'tesla.mode'; value: TeslaMode }
  | { actuator: 'tesla.reserve'; value: number }
  | { actuator: 'tesla.gridCharge'; value: boolean };

// ---- Claims -----------------------------------------------------------------
// A rule's bid on ONE actuator: the intent it wants + why. Priority is copied from the
// owning rule at emit time so the arbiter is a pure function of the claims alone.
export type Claim = ActuatorValue & {
  /** The emitting rule's id (for loser attribution + the trace). */
  ruleId: string;
  /** Copied from the rule's priority band — the arbiter sorts on this. */
  priority: number;
  /** One-line human rationale ("soak-export: absorbing 830W export"). */
  reason: string;
  /** Demand-clamp flag (docs/40 D5): a discharge/absorb claim opts into the arbiter's
   *  reconciled-demand clamp so it can never exceed real house residual / export. The
   *  arbiter applies the clamp; the rule declares the raw want. */
  clamp?: 'discharge' | 'absorb';
};

// ---- Rule memory ------------------------------------------------------------
// A rule's own persisted scratch (hysteresis latches, provenance sets, EMA state). The
// rule owns the SHAPE; the engine owns serialization + hands the same object back each
// tick. Hysteresis stays INSIDE rules so the arbiter can remain stateless (docs/40 §3).
export type RuleMemory = Record<string, unknown>;

// ---- Rule definition --------------------------------------------------------
export type RuleDomain = 'battery' | 'climate' | 'ev' | 'watchdog';

export interface RuleDef<P = unknown> {
  id: string;
  domain: RuleDomain;
  /** Explicit banded priority (docs/40 D2). Two rules claiming the same actuator may not
   *  share a priority — asserted at registration. */
  priority: number;
  /** Params for this rule (from config in P1c; a plain object here). */
  params: P;
  /**
   * PURE decision. Reads the reconciled snapshot + this rule's memory and returns the
   * claims it wants this tick (often 0 or 1). MUST NOT mutate global state, do I/O, or
   * throw — the engine wraps it fail-soft, but a well-behaved rule never relies on that.
   * Hysteresis latches live in `mem` (mutated in place is fine; the engine persists it).
   */
  decide(snap: ReconciledSnapshot, params: P, mem: RuleMemory): Claim[];
}

// ---- Arbiter result ---------------------------------------------------------
/** One resolved actuator: the winning claim + every loser with its reason. */
export interface ActuatorResolution {
  actuator: Actuator;
  /** The winning claim AFTER any demand clamp was applied (null → falls to safe default). */
  winner: Claim | null;
  /** Every claim that lost (lower priority, or clamped out), newest-band-first, with why. */
  losers: { claim: Claim; reason: string }[];
}

export interface ArbiterResult {
  /** Per-actuator resolution, one entry per actuator that had ≥1 claim. */
  resolutions: ActuatorResolution[];
  /** Convenience: the winning intent per actuator (the "would-issue" set). Only actuators
   *  with a winner appear; a missing actuator means "no claim → safe default". */
  intents: Partial<Record<Actuator, Claim>>;
}
