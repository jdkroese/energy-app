# 26 — Tariff arbitrage → production (effectiveness logging + deviation adaptation)

**Owner ask (2026-06-28):** move the already-built tariff-arbitrage automation (PR #37, seeded
DISABLED) into production, combined with the weather forecast & expected use. Two new
requirements: (1) **log every arbitrage event durably** so its effectiveness can be reproduced
and measured; (2) **dynamically adapt when actuals deviate from plan** (unexpected sun / usage /
clouds). Rollout decision: **build first behind an advisory (shadow) mode, owner reviews captured
data, then we flip to active execution** — so this round must NOT command the battery by default.

This is a single responsive React app + a Node/TS API. Follow CLAUDE.md: web AND mobile, Power
design system, typecheck + build before merge.

## Background — what already exists (do not rebuild)

- **Planner** `apps/api/src/control/arbitrage.ts` — pure `planArbitrage(solarKw, loadKw, bandCodes,
  startSoc, capKwh, maxKw, params)` → `ArbitragePlan { active, targetSocPct, valleyBuyKwh,
  peakDeficitKwh, moves[], socPct[24], reason }`. Solar-first; only buys the forecast shortfall.
- **Coordinator** `apps/api/src/control/coordinator.ts`:
  - `computeArbitragePlan(params, startSoc)` — fetches weather, builds solar/load forecast
    (`solarForecast`/`loadForecast` from `routes/brain.ts`), `bandCodesForDay`, calls
    `planArbitrage`. Cached 15 min (`ARB_CACHE_TTL_MS`, `arbCache`). `_resetArbitrageCache()` exists.
  - `coordinateArbitrageValleyCharge(snap, reason)` — valley-only grid-charge; reverts any
    lingering manual charge on band/spread/target/surplus/near-full. Returns true when it took
    Sonnen authority. Called from `coordinateSonnen` branch (B) only when NOT exporting.
  - Priority order: free-solar soak-export (#34) > valley grid-charge (arbitrage) > self-consumption.
    Peak discharge is IMPLICIT (self-consumption discharges through P1; SoC-floor + Tesla-reserve
    guardrails enforce the floor). Keep it implicit — do not add an explicit peak-discharge command.
- **Params** `apps/api/src/store.ts`: `TariffArbitrageParams` (peakTargetSocPct 90, maxGridChargeKw
  4.6, minSpreadEur 0.10, dischargeFloorPct, solarShortfallOnly true, surplusOverridesGridCharge
  true, valleyBand P3, peakBand P1). `defaultTariffArbitrageParams()`, seeded automation id
  `TARIFF_ARBITRAGE_AUTOMATION_ID='tariff-arbitrage'`, `isTariffArbitrage()` guard.
- **Brain overlay** `apps/api/src/routes/brain.ts` — when the rule is ENABLED, overlays the bent
  SoC trajectory + move-bars on the Autopilot chart. Leave as-is (works off `planArbitrage`).
- **Params update** `apps/api/src/routes/devices.ts` `sanitizeArbitrageParams()` clamps saved params.
- **Control HTTP** `apps/api/src/routes/control.ts` — `getStatus()` returns
  `log: ctrl.log.slice(-100)`, `soakExport`, etc. `setSoakExport()` is the pattern to mirror for a
  new admin PUT. The control `log` is a 100-entry **in-memory ring** in state.json — NOT durable.
- **State persistence** `apps/api/src/store.ts` — atomic JSON store. `statePath()`: `STATE_FILE`
  env override, else prod `/opt/energy/state.json`, dev `<repoRoot>/.data/state.json`.

## Scope of THIS change

### 1. Advisory (shadow) execution mode — the safety gate

Add `executionMode: 'advisory' | 'active'` to `TariffArbitrageParams`.
- `defaultTariffArbitrageParams()` → `executionMode: 'advisory'`.
- `sanitizeArbitrageParams()` (devices.ts) accepts/validates it (default 'advisory' if absent/invalid).
- Hydration: any persisted arbitrage automation missing `executionMode` defaults to `'advisory'`.

In `coordinateArbitrageValleyCharge` (coordinator.ts): compute the plan, run deviation detection,
and **emit log events EVERY tick the rule is enabled+armed+auto, regardless of mode**. But only
**issue() battery writes when `executionMode === 'active'`**. In `'advisory'`: log the intended
action (what it WOULD charge, target, would-save) and **return false** (no authority) so
self-consumption proceeds untouched — the battery is never commanded. The existing revert-on-stop
logic must ALSO be advisory-gated (advisory never issued a charge, so there's nothing to revert —
just log the stand-down). Net: enabling the rule in advisory mode produces a full effectiveness
log against live conditions with zero battery writes.

### 2. Durable effectiveness logging

New module `apps/api/src/control/arbitrage-log.ts`:
- `ArbitrageEvent` record (define in store.ts and export):
  ```ts
  type ArbitrageEventType =
    | 'plan'        // a (re)plan was computed
    | 'engage'      // started/continued a valley grid-charge (active) or WOULD (advisory)
    | 'revert'      // ended a charge / handed back to self-consumption
    | 'standdown'   // gated off (out of valley / spread / surplus / target met / near-full)
    | 'deviation';  // live actuals diverged from plan beyond threshold → re-plan
  interface ArbitrageEvent {
    ts: number;
    type: ArbitrageEventType;
    executionMode: 'advisory' | 'active';
    band: Band;
    spreadEur: number;
    plan: { active: boolean; targetSocPct: number; valleyBuyKwh: number;
            peakDeficitKwh: number; reason: string } | null;
    live: { combinedSoc: number | null; sonnenSoc: number | null; teslaSoc: number | null;
            solarKw: number; loadKw: number; gridExportKw: number;
            expectedSocFromPlan: number | null; socDeviationPct: number | null };
    action: { mode: string; chargeW: number } | null;   // null in advisory / no-op
    chargedKwhTick: number;        // energy bought this tick (active) or would-buy (advisory), kWh
    estSavedEurTick: number;       // chargedKwhTick * spreadEur (the arbitrage value of this tick)
  }
  ```
- **Durable JSONL**: append each event as one line to an append-only file. Path resolver mirrors
  `statePath()`: `ARBITRAGE_LOG_FILE` env override, else prod `/opt/energy/arbitrage-events.jsonl`,
  dev `<repoRoot>/.data/arbitrage-events.jsonl`. Best-effort, never throw (wrap fs in try/catch —
  a logging failure must never crash a coordinator tick). Append-only (do not rewrite the file).
- **In-state ring + headline stats** (for the UI, survives restart via state.json):
  - `store.control.arbitrageLog: ArbitrageEvent[]` — ring buffer, keep last ~200.
  - `store.control.arbitrageStats: { sinceTs: number; engagements: number; valleyKwh: number;
    estSavedEur: number; lastEventTs: number | null }` with `defaultArbitrageStats()` + hydration.
    Update stats on each `engage` event: `valleyKwh += chargedKwhTick`, `estSavedEur +=
    estSavedEurTick`, `engagements++`. Stats accrue in BOTH advisory and active (advisory =
    "what we would have saved"), but tag the mode so the UI can distinguish — keep a parallel
    pair if cleaner (e.g. `estSavedEurActive` vs `estSavedEurAdvisory`); your call, just make the
    UI able to show "modelled savings (advisory)" distinctly from realized.
- Export `appendArbitrageEvent(ev)` that does BOTH (JSONL append + ring push + stats update) via
  `store.update`. Cap the ring at 200, drop oldest.

`estSavedEurTick` rationale: a kWh bought in the valley at P3 instead of being imported during the
peak at P1 saves `spreadEur` (€/kWh). Use the configured `spreadEur = RATES[peakBand]-RATES[valleyBand]`.
This is a MODELLED estimate (the kWh is assumed to displace a peak import) — label it as such in UI.

### 3. Deviation detection + immediate re-plan

In the coordinator, each tick (rule enabled+armed+auto), compare live vs plan:
- `expectedSocFromPlan` = the plan's `socPct[currentHour]` (the bent trajectory's value for the
  current local hour). `socDeviationPct = combinedSoc - expectedSocFromPlan`.
- If `|socDeviationPct| >= deviationThresholdPct` (new param, default **5**), the world has diverged
  from the forecast (unexpected sun → SoC ahead of plan; clouds/extra load → behind plan):
  **invalidate the plan cache (`_resetArbitrageCache()` / force a refetch) → re-plan immediately**,
  and emit a `'deviation'` event capturing forecast-vs-actual (live solar/load vs the forecast hour,
  the SoC gap). The re-planned target then drives the same-tick charge decision.
- Add `deviationThresholdPct` to `TariffArbitrageParams` (default 5; clamp 1–25 in sanitize).
- Also emit a `'plan'` event whenever a fresh plan is computed (cache miss or forced), and a
  `'standdown'` event (with the gating reason) when the rule is enabled but not charging.
- Keep per-tick event volume sane: don't emit identical `standdown` spam every 90s — only log a
  `standdown`/`engage`/`revert` when the STATE CHANGES (transition), but always log `deviation` and
  `plan` when they occur. (Track last-emitted state in module scope, like the coordinator already
  tracks cache.) The goal is a readable, reproducible event stream, not a 90s heartbeat.

Note: the existing reactive corrections already cover the live cases (export appears → soak-export
takes over; SoC < target in valley → keep charging; band leaves valley → revert). This change ADDS
the explicit forecast-vs-actual deviation signal + immediate re-plan + the durable record of it.

### 4. API surface

`apps/api/src/routes/control.ts`:
- Extend `getStatus()` to include `arbitrageStats` and `arbitrageLog: ctrl.arbitrageLog.slice(-50)`.
- Add `setArbitrageMode(patch: { executionMode?, ...other arbitrage params })` admin handler that
  updates the seeded arbitrage automation's params via the existing automation-update path (reuse
  `sanitizeArbitrageParams`) — OR simply rely on the existing automation PUT in devices.ts if it
  already round-trips params (verify; if so, just expose `executionMode` there and skip a new
  endpoint). Pick the smaller change. Wire any new route where control routes are mounted.
- Optional `GET /api/control/arbitrage-log?limit=N` returning recent events + stats for a history
  view (reads the in-state ring; the JSONL is the offline audit trail).

### 5. Web UI (web AND mobile — Power design system)

`apps/web/src/screens/Automations.tsx` (+ `apps/web/src/lib/types.ts` for the new types/fields):
- On the **Tariff arbitrage** card: an **Advisory ↔ Active** mode control (segmented/toggle), clearly
  labelled — Advisory = "observe & log only, no battery commands"; Active = "executes valley
  grid-charge". Make the safety distinction obvious (Active is the one that spends money).
- A compact **effectiveness / history** card: cumulative modelled € saved + valley kWh shifted +
  engagement count (from `arbitrageStats`), a "since" date, and a short recent-events list
  (timestamp, band, type, SoC, kWh, € — from `arbitrageLog`). Distinguish advisory (modelled) from
  active (realized) savings. Follow existing card styling (mirror `BatteryRuleCard` / the Surplus
  soak card). Must render correctly on both desktop (≥768px) and mobile (<768px).

## Out of scope (explicit)

- Do NOT auto-enable or arm the rule. It stays seeded `enabled:false`; default mode `advisory`.
  Owner flips enable + Active manually after reviewing data.
- Do NOT build a learned load model this round (static `loadForecast` stays; the new logging
  captures actuals so a learned model is a clean follow-up).
- Do NOT add an explicit peak-discharge battery command (self-consumption + guardrails already
  carry the peak; keep implicit).
- Do NOT touch the soak-export (#34) or battery-priority logic beyond what's needed to thread the
  advisory gate. Do NOT change guardrails.

## Acceptance

- `pnpm --filter @energy/api typecheck` and `pnpm --filter @energy/web typecheck && build` clean.
- Enabling the rule in **advisory** mode commands the battery ZERO times (no `issue()` writes from
  the arbitrage path) while still emitting `plan`/`engage`(would)/`standdown`/`deviation` events and
  accruing modelled stats. Verify by reading the event stream / log reasons.
- A forced SoC deviation ≥ threshold triggers an immediate re-plan + a `deviation` event.
- JSONL file is appended one event per line at the resolved path; a logging failure cannot crash a
  tick (wrapped). In-state ring capped at 200; `getStatus()` exposes stats + recent events.
- UI shows the Advisory/Active control + the effectiveness card on desktop and mobile.
- Existing arbitrage behavior (when later set Active) is unchanged from PR #37 except for the added
  logging + deviation re-plan.
