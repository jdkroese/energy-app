# 45 — Rule Engine Phase 1: engine core (shadow) build breakdown

Feeds off [docs/40-rule-engine.md](40-rule-engine.md) (architecture + resolved decisions
Q1–Q4). Phase 0 shipped the visibility layer (decision trace, expensive-band watchdog,
Tesla-autonomous fix; PR #185). Phase 1 builds the **engine chassis and runs it in shadow
beside the legacy coordinator** — it decides but never writes, so it is safe to merge and
deploy while we build confidence. Legacy control stays authoritative until a domain's
shadow-compare divergence reaches ~0 (D6, Phase 2).

## Delivery slices (each a review-first PR, deployable alone)

### P1a — chassis + reconciled snapshot + shadow-compare (FIRST)
The load-bearing skeleton, provably correct in isolation, migrating exactly ONE rule as an
end-to-end proof. No UI, no config migration, no live writes.

1. **Types** (`control/engine/types.ts`): `RuleDef<P>`, `Claim`, `RuleMemory`, `Actuator`
   (union: `sonnen.stance | tesla.mode | tesla.reserve | tesla.gridCharge`), `ArbiterResult`.
   Mirror docs/40 §3. Priority is a number; helper bands (`WATCHDOG=900, MANUAL=700,
   ECONOMIC=500, COMFORT=300, DEFAULT=100`).
2. **Reconciled snapshot** (`control/engine/reconciled-snapshot.ts`, D5): from the existing
   `RichSnapshot`, derive a single agreed physics view — `gridDirection`, `houseResidualW`
   (computed so it is NOT corrupted by any actuator's own flow: subtract known battery flows),
   `surplusW`, plus `gridSource` provenance and a `meterDisagreementW` (Tesla-domain vs
   Sonnen+Sungrow-domain gap). Pure + unit-tested against fixture snapshots, including the #178
   case (residual must exclude the Sonnen's own discharge).
3. **Arbiter** (`control/engine/arbiter.ts`, pure): given all claims, pick the highest-priority
   claim per actuator, record every loser with its reason, assert no same-priority tie within a
   band (throw at registration-time, not tick-time), apply the demand clamps (discharge ≤
   houseResidualW, absorb ≤ surplusW). Heavily unit-tested.
4. **Registry + engine tick** (`control/engine/engine.ts`): register rules, evaluate all (pure,
   fail-soft per rule), collect claims, run the arbiter, produce a **would-issue** intent set.
   In shadow it writes NOTHING — it hands the intent set to the comparator.
5. **Shadow-compare** (`control/engine/shadow-compare.ts`): each battery tick, compare the
   engine's would-issue intents against what the legacy coordinator actually issued this tick;
   record divergences into a ring (like `arbitrageLog`) + a new decision-trace field; emit an
   Event-Viewer `observation/low` only when a divergence class first appears (no per-tick spam).
   Expose `GET /api/control/engine/shadow` (requireAuth) returning recent divergences + a
   per-actuator agreement rate.
6. **One rule migrated as proof**: port **soak-export** (self-contained, well-tested) to a
   `RuleDef`. Unit test asserts the RuleDef's claims match the legacy soak-export decision on a
   battery of fixture snapshots (engage/hold/revert/hysteresis). This exercises types → rule →
   arbiter → shadow-compare end to end.
7. Wire the engine tick into the existing 90s coordinator loop **after** the legacy logic (same
   snapshot), fully fail-soft: any engine throw is swallowed and never touches legacy control.

**P1a acceptance:** engine runs every tick in shadow on the mini, `GET …/engine/shadow` shows
soak-export agreeing with legacy ~100%, zero effect on live control, all pure units tested
(`node --import tsx --test`), typecheck + build green.

### P1b — migrate the remaining battery rules (shadow)
Port arbitrage-valley-charge, discharge-priority, charge-priority, and the Tesla-mode decision
(reuse Phase 0's `decideTeslaMode`) as `RuleDef`s. Each lands with a fixture-parity unit test
vs its legacy decision. Watch shadow-compare converge; triage every divergence to a known cause
(legacy bug we're deliberately fixing, vs engine bug to fix). Add the safety watchdogs as
RuleDefs in **shadow/alert-only** first: push-to-grid, mode-drift, stale-manual,
meter-disagreement (expensive-band-import already exists — fold it in).

### P1c — unified config subtree + Rules screen (read-only)
Introduce `control.rules[id] = { authority, params }` (zod schemas per rule; migrate existing
scattered config with a one-time migration, keeping back-compat reads). Rules screen as a **tab
under `/automations`** (Q4): list every rule with domain, priority, authority (off/shadow/auto),
current claim + reason from the trace, and its params (read-only this phase). Both viewports,
Power design system.

## Guardrails on this work (all slices)
- **Shadow only** — Phase 1 issues NO live writes and does NOT touch `guardrails.ts` or the
  `execute.ts` path. Legacy coordinator remains the sole writer until Phase 2 cutover.
- Fail-soft: an engine/rule/comparator throw can never break a legacy tick.
- Tests via the Node built-in runner (`node --import tsx --test`), NOT vitest (repo has no test
  script). Keep pure functions pure for testability.
- Follow the multi-agent git rules (branch off latest origin/main, rebase before push,
  review-first PR, armed-state preserved). Do NOT run Prettier (CLAUDE.md).

## Q1 note (watchdogs may act) — deferred to Phase 2
Corrective (`auto`) watchdog claims land in Phase 2 with the battery cutover, after the
watchdogs have run shadow/alert-only through P1b and earned trust. P1 keeps them alert-only.
