# 40 — Rule Engine: centrally-managed, configurable control rules (ground-up redesign)

Owner decision 2026-07-02: **build the complete redesign, delivered incrementally** — Phase 0
ships visibility + the worst hole immediately; subsequent phases migrate every rule into a new
central engine until the legacy coordinator paths are gone. The end state is a ground-up
architecture; the migration path never runs untested logic against live hardware.

## 1. Why (the incident pattern)

Four incidents in one week, all the same *class* of failure — not a broken rule, but rules
interacting invisibly:

| Incident | What happened | Root cause class |
|---|---|---|
| **P2 import, batteries full** (2026-07-02 evening) | 3.7 kW grid import at P2 while Tesla idled at 100% (27 kWh), Sonnen 0% | Scenario `gridCharge:true` silently pins Tesla to vendor-`autonomous`; **no invariant** notices "importing expensive while battery holds energy" |
| **Sonnen discharge runaway** (PR #178) | Live P1 with a 7.7 kW PV surplus: Sonnen thrashed force-discharge↔soak-charge every 90s and dumped battery to grid | Discharge target `drawW = sonnenDis + teslaDis + gridImport` counted the Sonnen's **own discharge** as house load → self-latched to 4.6 kW (log showed impossible "draw 9030W"). The actuator moved the very meter deciding its next action |
| **Overnight AC reclaim** (PR #154) | Surplus rule re-adopted manual-on AC units at 3am | Provenance/hold semantics differed between two rules touching the same units |
| **Solar 15.6 kW spike** (PR #175) | Impossible reading charted verbatim | No plausibility layer between source and consumer |
| **Sticky transient faults** (PR #182) | One Tesla `/site_info` HTTP 504 became a standing red fault until re-arm | No transient-vs-permanent distinction in error handling; `control.lastError` never self-healed (same class as the climate tile, PR #171) |

Each fix was correct and local. The pattern is global: **decisions are silent, ordering is
implicit, config is scattered, and there are no invariants watching the outcome.** The trust
cost ("we have errors all the time") now exceeds the cost of the redesign.

## 2. Current state (from the 2026-07-02 full inventory)

Nine rules across two independent loops (90s battery coordinator, 45s climate coordinator):
soak-export, tariff-arbitrage valley charge, discharge-priority (Sonnen-first), charge-priority
(Tesla-first), Tesla grid-charge gate, HVAC pre-cool, HVAC pre-heat, EV solar/P3 circuit, plus
safety reverts. Individually sound (pure decision fns, hysteresis, provenance, a genuinely good
default-deny guardrail layer). Structurally:

- **Priority = code position.** Ordering lives in early-returns inside ~700-line
  `coordinateSonnen()`. Rule #10 requires re-reading everything to slot in.
- **Three authority vocabularies**: `shadow/auto` (battery priority), `advisory/active`
  (arbitrage), always-on (soak-export, climate, EV) — plus one-shot migration flags
  (`dischargeV2Shadowed`). No single view of "which rules are live".
- **Config in 4+ places**: `store.control.guardrails` / `.batteryPriority` / `.soakExport`,
  the automations store (arbitrage, climate, schedules), scenarios, env. ~17 hardcoded
  constants on top (NEUTRAL_KW 0.2, throughput caps, hysteresis bands, EMA alphas…).
- **Scenarios secretly change control semantics** — `gridCharge:true` flips Tesla to
  `autonomous` (the P2 incident). A "preset" should never silently transfer authority.
- **No decision trace.** Arbitrage logs richly; battery-priority logs only in shadow;
  Tesla-mode decisions log nothing. "Why is the battery doing X?" requires reading source.
- **No invariant watchdogs.** Nothing detects state-contradicts-intent.
- **Two unreconciled meter domains — the deepest structural enabler.** The coordinator
  arbitrates grid direction off the **Tesla gateway meter** (`snapshot.ts` prefers `t.gridKw`;
  Sonnen only as fallback), which is blind to the Sonnen+Sungrow metering domain. `/api/live`'s
  grid+home come from the Tesla meter and do not reconcile with the Sonnen/Sungrow flows — a
  **~7 kW energy-balance gap** has been observed. Consequence: an actuator (the Sonnen) moves
  the very meter that decides its own next action → feedback loops like #178. PR #178's fix
  (`decideDischargeTarget()`: decide from the Sonnen's own meter residual `max(0, consumption −
  production)`, stand down on PV surplus, clamp to residual, 300 W deadband) is the *local*
  instance of the general principle the engine must own globally.

## 3. Target architecture

```
                    ┌────────────────────────────────────────────┐
                    │                ENGINE TICK                  │
 snapshot ──────►   │  1. evaluate ALL rules (pure, in parallel)  │
 (one reconciled    │  2. rules emit CLAIMS on actuators          │
  view, both meter  │  3. ARBITER resolves per actuator by        │
  domains)          │     numeric priority; records losers        │
                    │  4. diff vs current state                   │
                    │  5. guardrails + execute (UNCHANGED path)   │
                    │  6. decision trace persisted + surfaced     │
                    └────────────────────────────────────────────┘
```

### Rule as a declarative unit

```ts
interface RuleDef<P> {
  id: string;                          // 'soak-export', 'discharge-priority', …
  domain: 'battery' | 'climate' | 'ev' | 'watchdog';
  priority: number;                    // explicit, banded — see D2
  authority: 'off' | 'shadow' | 'auto';// ONE ladder for every rule — see D3
  paramsSchema: ZodSchema<P>;          // drives validation AND the auto-generated UI
  params: P;
  decide(snap: RichSnapshot, params: P, mem: RuleMemory): Claim[];  // PURE, never throws
}
```

`RuleMemory` is the rule's own persisted scratch (hysteresis latches, provenance sets, EMA
state) — owned by the rule, serialized by the engine. Hysteresis stays INSIDE rules; the
arbiter stays stateless.

### Claims and the arbiter

A claim targets one actuator with one intent + rationale:
`{ actuator: 'sonnen.stance', value: {mode:'manual', chargeW: 800}, reason: 'soak-export: absorbing 830W export' }`.
Actuators (initial set): `sonnen.stance`, `tesla.mode`, `tesla.reserve`, `tesla.gridCharge`,
`hvac.<id>`, `breaker.<id>`, later `blinds.<id>`. **Exactly one writer per actuator per tick:**
the arbiter picks the highest-priority claim, records every losing claim with its reason, and
emits intents to the unchanged guardrail/execute path. No claim → actuator falls to its
declared safe default (`sonnen: self-consumption`, `tesla: self_consumption`) — the fallback
becomes explicit instead of being the bottom of a function.

### Decision trace (first-class output, not logging)

Every tick persists a compact record: inputs (band, flows, SoCs, armed/mode), every rule's
claims or stand-down reason, winner per actuator, losers with reasons. Ring buffer in the
store + durable JSONL; stance *changes* also become Event Viewer events. The Rules screen
answers "why is the battery doing X right now?" in one click, and "why did it do X at 21:40?"
via the ring.

### Watchdogs as first-class rules

Same registry, `domain:'watchdog'`, highest priority band, but their claims are *alerts* (and,
in `auto`, corrective safe-reverts) rather than economic optimizations:

- **expensive-band-import**: P1/P2 import > 0.5 kW sustained while a battery holds usable
  energy above floor+margin and neither discharges (the P2 incident, Phase 0).
- **push-to-grid**: battery force-discharge exceeding house residual (the #178 runaway class).
- **mode-drift**: vendor state ≠ engine intent for N ticks (Tesla ignored a write).
- **stale-manual**: manual setpoint alive with no owning rule (strand detection).
- **meter-disagreement**: Tesla CT vs Sonnen+Sungrow domains diverging beyond tolerance
  (the observed ~7 kW balance gap).

Error handling follows the PR #171/#182 self-heal pattern engine-wide: transient upstream
failures (5xx/timeouts) retry next tick and never become standing faults; `lastError`-style
state clears on the next success; policy rejects are decisions (traced), not errors.

### Unified config + scenarios demoted to presets

One subtree: `control.rules[id] = { authority, params }`, zod-validated, one Rules screen
(web + mobile) auto-generated from the schemas with per-rule authority toggles. **Scenarios
become named presets over rule params** — applying one is visible diff + one event, and can
never silently transfer authority to a vendor optimizer again.

### Replay harness

Rules are pure over snapshots; we already persist 5-min history + events. `replay(day,
proposedConfig)` re-runs the engine over recorded snapshots and diffs decisions/cost vs what
actually happened. Every rule change can be back-tested before it's armed. (Also becomes the
regression suite: replay the #178 runaway day and assert the push-to-grid watchdog fires.)

## 4. Design decisions (proposed — confirm/veto at review)

- **D1 — Keep guardrails + execute untouched.** They are battle-tested and default-deny; the
  engine replaces *decision-making*, not actuation. Non-negotiable safety anchor.
- **D2 — Priority bands**: watchdog/safety 900+, owner-manual holds 700, economic (arbitrage,
  soak, battery priority) 500, comfort (climate) 300, defaults 100. Explicit numbers, no ties
  within a band allowed at registration (engine asserts).
- **D3 — One authority ladder** `off | shadow | auto` for every rule. Arbitrage's
  advisory→shadow, active→auto. Shadow rules run fully (claims + trace) but their claims are
  marked non-executing — shadow-compare comes free.
- **D4 — Single scheduler, per-domain cadence.** One engine loop; battery rules evaluate every
  90s, climate/EV every 45s (per-rule `cadence` field). Removes cross-loop implicit
  coordination (EV draw reservation becomes an ordinary priority interaction).
- **D5 — Reconciled snapshot (load-bearing).** One snapshot builder reconciles both meter
  domains into a single agreed physics view every rule must read: `gridDirection` and
  `houseResidualW` computed so they are **not corrupted by any actuator's own flow** (subtract
  known battery flows from the deciding signal), plus `surplusW-after-reservations`. Every
  actuator claim carries a clamp that can never exceed real demand (`≤ houseResidualW` for
  discharge, `≤ exportW` for absorb) — enforced by the arbiter, not left to each rule. A
  `meter-disagreement` watchdog alerts when the two domains diverge beyond tolerance (the
  observed ~7 kW balance gap becomes a first-class alert, not a silent corruption source).
  This generalizes #178's `decideDischargeTarget()` fix from one rule to the whole engine.
- **D6 — Migration by shadow-compare, cutover per domain.** New engine runs in shadow beside
  the legacy coordinator; a comparator logs divergences; a domain cuts over when divergence ≈ 0
  for N days, then its legacy path is DELETED (end state is the redesign, not two systems).
- **D7 — Rule changes are events.** Any authority/param change → Event Viewer entry with
  before/after (audit trail).
- **D8 — Trace retention**: ring ~48h in store, JSONL forever (tiered like energy history).

## 5. Phases

- **P0 (in flight)** — decision trace on the existing coordinator, expensive-band-import
  watchdog (log-only), kill the scenario→`autonomous` pin. Immediate visibility + the hole.
- **P1 — engine core**: registry, claims, arbiter, trace, unified config subtree + Rules
  screen (read-only params first). Migrate the five battery rules as `RuleDef`s in **shadow**;
  shadow-compare vs legacy ≥ 5 days; divergences triaged to zero.
- **P2 — battery cutover**: battery domain flips to engine-auto; legacy battery branches
  removed. Watchdog set expanded (push-to-grid, mode-drift, stale-manual, meter-disagreement).
- **P3 — climate + EV migration** (same shadow-compare gate); scenarios→presets conversion;
  param editing in the Rules screen.
- **P4 — replay harness** + regression suite over recorded incident days; retire remaining
  legacy paths; docs.

Each phase = review-first PR(s), deployable alone, armed-state preserved.

## 6. Open questions (owner)

- **Q1 — Watchdog `auto` powers**: may watchdogs take corrective action (e.g. force
  self_consumption on mode-drift), or alert-only forever? Proposal: alert-only through P2,
  revisit with evidence.
- **Q2 — Tesla `autonomous`**: keep any path to vendor-autonomous at all? Proposal: only via
  active-mode arbitrage explicitly claiming it; never via preset.
- **Q3 — Manual-override semantics**: an owner action on an actuator creates a priority-700
  hold — for how long (fixed TTL vs until-released)? Today's per-rule holds vary (2h→8h saga).
- **Q4 — Rules screen placement**: new top-level nav item vs tab under /automations.
