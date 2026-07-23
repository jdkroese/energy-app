// The engine registry + tick (docs/40 §3, Phase 1a chassis).
//
// SHADOW ONLY. The engine registers rules, evaluates them all (pure, fail-soft PER rule),
// collects their claims, and runs the arbiter → a "would-issue" intent set. It writes NOTHING
// to any device and never touches guardrails.ts / execute.ts. Its ONLY output is the intent
// set, which the shadow-comparator diffs against what the legacy coordinator actually issued.
//
// FAIL-SOFT is the safety anchor (see the task's SHADOW-ONLY constraint): a throw in ANY rule
// is caught here and turned into a recorded "rule error" (that rule simply contributes no
// claims this tick); a throw anywhere else in the tick is caught by the caller's wrapper. The
// legacy coordinator remains the sole writer and can never be broken by the engine.

import type { Claim, RuleDef, RuleMemory, ArbiterResult, Actuator } from './types';
import { arbitrate, assertNoPriorityCollisions } from './arbiter';
import type { ReconciledSnapshot } from './reconciled-snapshot';

/** One rule's outcome this tick — its claims, or the error that made it contribute none. */
export interface RuleOutcome {
  ruleId: string;
  claims: Claim[];
  /** Set when decide() threw (fail-soft): the message; claims is [] in that case. */
  error?: string;
}

/** The full result of an engine tick (shadow — nothing was issued). */
export interface EngineTickResult {
  ts: number;
  /** Per-rule claims / errors (for the trace). */
  outcomes: RuleOutcome[];
  /** The arbiter's resolution + the would-issue intent set. */
  arbiter: ArbiterResult;
}

/** The registry. Rules are registered once at startup; the set is fixed per process. */
const rules: RuleDef[] = [];

/** Per-rule persisted memory (hysteresis latches etc.), keyed by rule id. Owned by the engine,
 *  handed back to each rule every tick (docs/40 §3). In P1a this is in-process module state
 *  (the shadow decision is diagnostic; losing the latch on a restart at worst costs one tick
 *  of hysteresis re-settle, which is harmless and self-heals). Persisting it into state.json
 *  is a later slice once the engine is a real writer. */
const memories = new Map<string, RuleMemory>();

/**
 * Register a rule. Asserts the priority invariant across the whole registry EACH time (cheap;
 * throws early on a collision — a mis-registered priority is a boot-time programming error, not
 * a runtime condition to swallow, per docs/40 D2). Idempotent by id: re-registering the same id
 * replaces the definition (keeps its memory).
 */
export function registerRule(rule: RuleDef): void {
  const existing = rules.findIndex((r) => r.id === rule.id);
  if (existing >= 0) rules[existing] = rule;
  else rules.push(rule);
  assertNoPriorityCollisions(rules);
  if (!memories.has(rule.id)) memories.set(rule.id, {});
}

/**
 * Evaluate every rule over the reconciled snapshot, arbitrate, and return the would-issue
 * intent set. PURE w.r.t. devices (issues nothing). Per-rule fail-soft: a throwing rule
 * contributes no claims and is recorded with its error. The whole call is also safe to wrap in
 * a try/catch by the caller — it never throws for a rule error, only re-throws truly
 * unexpected engine faults (which the coordinator wrapper swallows).
 */
export function tick(snap: ReconciledSnapshot): EngineTickResult {
  const outcomes: RuleOutcome[] = [];
  const allClaims: Claim[] = [];

  for (const rule of rules) {
    const mem = memories.get(rule.id) ?? {};
    memories.set(rule.id, mem);
    try {
      const claims = rule.decide(snap, rule.params, mem) ?? [];
      outcomes.push({ ruleId: rule.id, claims });
      for (const c of claims) allClaims.push(c);
    } catch (e) {
      // FAIL-SOFT: one rule throwing must never affect the others or the tick. Record it and
      // move on; the rule simply contributes no claims this tick.
      outcomes.push({ ruleId: rule.id, claims: [], error: (e as Error).message });
    }
  }

  const arbiter = arbitrate(allClaims, snap);
  return { ts: Date.now(), outcomes, arbiter };
}

/** Overwrite a registered rule's params (the engine seeds these from live config each tick so
 *  the shadow decision uses the SAME params the legacy path used). Best-effort — a missing rule
 *  is a no-op. */
export function setRuleParams(id: string, params: unknown): void {
  const r = rules.find((x) => x.id === id);
  if (r) (r as RuleDef).params = params;
}
