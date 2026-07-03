// The arbiter (docs/40 §3 — "Claims and the arbiter").
//
// PURE + STATELESS. Given the claims every rule emitted this tick and the reconciled
// snapshot, it resolves EXACTLY ONE winner per actuator:
//   1. group claims by actuator;
//   2. apply the reconciled demand clamp (docs/40 D5) — a `discharge` claim can't exceed
//      houseResidualW, an `absorb` claim can't exceed surplusW — so a rule's raw want can
//      never overshoot real demand (this is where the #178 class is structurally killed for
//      EVERY rule, not just soak/discharge);
//   3. the highest-priority surviving claim wins; every other claim is recorded as a loser
//      with the reason it lost (lower priority / clamped to zero).
//
// Same-priority collisions on one actuator are NOT resolved here — they are a REGISTRATION
// error (two rules with equal priority claiming the same actuator make the winner
// order-dependent, the exact bug the engine exists to kill). `assertNoPriorityCollisions()`
// is called once at registration (engine.ts) and throws early; per tick the arbiter trusts
// that invariant and, defensively, treats an unexpected tie as a stable pick + a recorded
// loser rather than throwing into a tick.

import type {
  Claim,
  Actuator,
  ArbiterResult,
  ActuatorResolution,
  RuleDef,
} from './types';
import type { ReconciledSnapshot } from './reconciled-snapshot';

/**
 * Registration-time invariant (docs/40 D2): no two rules may claim the SAME actuator at the
 * SAME priority. We can't know at registration which actuators a rule will claim at runtime
 * (decide() is dynamic), so we assert the weaker, sufficient guarantee that catches the real
 * hazard: within a domain, no two rules share a priority at all. Combined with the banded
 * scheme (D2), that guarantees a total order on every actuator's claims. Throws early with a
 * message naming the colliding rules — a fail-FAST at boot, deliberately NOT fail-soft (a
 * mis-registered priority is a programming error, not a runtime condition to swallow).
 */
export function assertNoPriorityCollisions(rules: RuleDef[]): void {
  const byPriority = new Map<number, string[]>();
  for (const r of rules) {
    const list = byPriority.get(r.priority) ?? [];
    list.push(r.id);
    byPriority.set(r.priority, list);
  }
  for (const [priority, ids] of byPriority) {
    if (ids.length > 1) {
      throw new Error(
        `[engine] priority collision at ${priority}: ${ids.join(', ')} — every rule must have a distinct banded priority (docs/40 D2)`,
      );
    }
  }
}

/** Clamp a claim's setpoint against the reconciled demand ceiling (D5). Returns the possibly-
 *  reduced claim + a note when it was clamped, or null when the clamp zeroed it out (no real
 *  demand → the claim is dropped, becoming a loser). */
function applyClamp(
  claim: Claim,
  snap: ReconciledSnapshot,
): { clamped: Claim; note: string | null } | null {
  if (!claim.clamp) return { clamped: claim, note: null };

  if (claim.clamp === 'discharge') {
    // A discharge claim targets sonnen.stance with dischargeW. Cap it at the house residual;
    // if the residual is unknown (Sonnen offline) or zero, there is no demand to cover → drop.
    const ceiling = snap.houseResidualW;
    if (ceiling === null) return null; // no trustworthy residual → stand down
    if (claim.actuator !== 'sonnen.stance') return { clamped: claim, note: null };
    const want = claim.value.dischargeW ?? 0;
    if (ceiling <= 0) return null; // no unmet demand → nothing to discharge for
    if (want <= ceiling) return { clamped: claim, note: null };
    return {
      clamped: { ...claim, value: { ...claim.value, dischargeW: ceiling } },
      note: `discharge clamped ${want}→${ceiling}W (house residual)`,
    };
  }

  // absorb: a force-charge claim on sonnen.stance. Cap at the available surplus; drop when
  // there's no surplus to soak.
  const ceiling = snap.surplusW;
  if (claim.actuator !== 'sonnen.stance') return { clamped: claim, note: null };
  const want = claim.value.chargeW ?? 0;
  if (ceiling <= 0) return null; // no export → nothing to absorb
  if (want <= ceiling) return { clamped: claim, note: null };
  return {
    clamped: { ...claim, value: { ...claim.value, chargeW: ceiling } },
    note: `absorb clamped ${want}→${ceiling}W (surplus)`,
  };
}

/**
 * Resolve all claims into one winner per actuator. Pure. The result records every loser with
 * its reason so the trace/shadow-compare can answer "why did rule X not win actuator Y?".
 */
export function arbitrate(claims: Claim[], snap: ReconciledSnapshot): ArbiterResult {
  // Group by actuator.
  const byActuator = new Map<Actuator, Claim[]>();
  for (const c of claims) {
    const list = byActuator.get(c.actuator) ?? [];
    list.push(c);
    byActuator.set(c.actuator, list);
  }

  const resolutions: ActuatorResolution[] = [];
  const intents: Partial<Record<Actuator, Claim>> = {};

  for (const [actuator, group] of byActuator) {
    const losers: ActuatorResolution['losers'] = [];

    // Apply the demand clamp first; a claim clamped to zero demand becomes a loser here and
    // never competes for the actuator (D5 — a rule can't win by over-claiming).
    const survivors: Claim[] = [];
    for (const c of group) {
      const res = applyClamp(c, snap);
      if (res === null) {
        losers.push({
          claim: c,
          reason: c.clamp === 'discharge' ? 'no house residual to cover — clamped out' : 'no surplus to absorb — clamped out',
        });
        continue;
      }
      survivors.push(res.clamped);
      // A clamp note is not a loss, but is worth carrying on the winning claim's reason so the
      // trace shows the setpoint was reduced. We fold it into the reason below at win time.
      if (res.note) res.clamped.reason = `${res.clamped.reason} [${res.note}]`;
    }

    if (survivors.length === 0) {
      // Everything clamped out → no winner; actuator falls to its safe default.
      resolutions.push({ actuator, winner: null, losers });
      continue;
    }

    // Highest priority wins. Sort descending; a stable sort keeps registration order on the
    // (registration-forbidden) tie so the pick is at least deterministic if the invariant is
    // ever violated.
    const sorted = [...survivors].sort((a, b) => b.priority - a.priority);
    const winner = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const l = sorted[i];
      losers.push({
        claim: l,
        reason:
          l.priority === winner.priority
            ? `tie at priority ${l.priority} with ${winner.ruleId} — registration invariant violated, kept ${winner.ruleId}`
            : `priority ${l.priority} < ${winner.priority} (${winner.ruleId})`,
      });
    }

    resolutions.push({ actuator, winner, losers });
    intents[actuator] = winner;
  }

  return { resolutions, intents };
}
