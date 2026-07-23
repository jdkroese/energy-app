# 27 — Tariff arbitrage tuning: next-peak targeting, certainty gate, pre-peak surplus guard, deviation fix

**Owner ask (2026-06-28, rule now live in advisory):** four refinements to the tariff-arbitrage
automation shipped in PR #59 (docs/26). All four are battery-control logic; keep the advisory gate
intact (advisory still issues ZERO battery writes). Web AND mobile, Power design system, typecheck
+ build before merge.

## Context — current code
- Planner `apps/api/src/control/arbitrage.ts` `planArbitrage(solarKw, loadKw, bandCodes, startSoc,
  capKwh, maxKw, params)`. Today it targets `firstPeakH = bandCodes.findIndex(b===peakCode)` — the
  FIRST peak of the calendar day — and builds `socPct[24]` by simulating forward from hour 0 seeded
  at `startSoc`.
- Coordinator `apps/api/src/control/coordinator.ts`:
  - `computeArbitragePlan(params, startSoc)` → `{plan, freshPlan}`, caches weather (`arbWeatherCache`)
    + plan (`arbCache`, 15 min). `solarForecast`/`loadForecast` from `routes/brain.ts`,
    `bandCodesForDay(new Date())`.
  - `coordinateArbitrageValleyCharge(snap, reason)` — the live decision. `advisory =
    params.executionMode !== 'active'`; advisory logs intended action + returns false (no writes).
  - **Deviation (BROKEN):** compares live combined SoC to `plan.socPct[currentLocalHour]` and
    re-plans when `|gap| >= deviationThresholdPct`. Because `socPct` is a forward sim seeded at the
    live SoC at hour 0, `socPct[currentHour]` is NOT "expected SoC now" — it drifts past 5% every
    tick, so `deviation` fires ~every tick (confirmed in the live UI). Must be replaced (item 4).
- Live signals on the snapshot: `snap.sonnen.productionW` (live solar W), `snap.sonnen.consumptionW`
  (live house load W), `snap.gridExportKw`, `snap.band`, `snap.sonnen.soc`. `combinedSoc(snap)` helper.
- Solar model `apps/api/src/solar-model.ts` `effectivePR(monthKey?)` → `{ prEff, confidence, days,
  month }`. `confidence = min(1, days/20)`. No probabilistic ensemble.
- Params `apps/api/src/store.ts` `TariffArbitrageParams` + `defaultTariffArbitrageParams()` +
  `sanitizeArbitrageParams()` (devices.ts). UI card `apps/web/src/screens/Automations.tsx`
  (`TariffArbitrageCard`) renders WHEN/DO/UNTIL/LIMITS text + edit sliders + the live preview.
- Tariff `apps/api/src/tariff.ts`: `bandCodesForDay(d)` → 24 hourly codes (0=P3,1=P2,2=P1) for the
  Madrid weekday of `d`; `RATES`, `TZ='Europe/Madrid'`. `currentLocalHour()` helper exists in
  coordinator.ts.

## Item 1 — target the NEXT P1 cycle (not the first of the calendar day)

There are two P1 windows on weekdays (10–14, 18–22). The live decision must target the **next
upcoming** peak relative to now, and overnight it must target **tomorrow's** morning peak (the
primary overnight-valley → morning-peak arbitrage), since today's bands have no remaining peak.

- Add an optional `fromHour` (default 0) to `planArbitrage`, and build the peak search as the first
  peak hour `>= fromHour` within a **48h horizon**. The coordinator passes `currentLocalHour()` and
  a 48-length `bandCodes`/`solarKw`/`loadKw` (today + tomorrow) so "next peak" is always findable,
  including the overnight case. The brain overlay (`routes/brain.ts`, the calendar-day chart) keeps
  its current whole-day behavior — pass `fromHour=0` and the existing 24h arrays there (no chart
  regression).
- `computeArbitragePlan` builds the 48h horizon: `bandCodesForDay(today)` ++ `bandCodesForDay(
  tomorrow)`, and a 48h solar/load forecast. The weather forecast may only cover ~24–48h; if
  tomorrow's hours are unavailable, fall back to repeating today's forecast shape for the tomorrow
  slice (document it). SoC sim + targets then run over the horizon up to the next peak.
- The "peak deficit", "valley hours before the peak", and the SoC trajectory all key off this next
  peak. Valley hours are the valley-band hours between `fromHour` and the next peak (so overnight
  P3 hours before tomorrow's 10:00 are correctly selected).

## Item 2 — ≥70% certainty gate (conservative-solar margin)

Only pre-buy when we are ≥ `solarConfidencePct` sure the next peak's solar falls short. Mechanism:
**inflate** the forecast solar over the peak window to its optimistic percentile and require a
deficit to remain even then (if even optimistic solar can't carry the peak, a shortfall is ≥conf%
likely).

- `optimisticSolarKw[h] = forecastSolarKw[h] * (1 + z(solarConfidencePct) * SOLAR_REL_SIGMA)` over
  the peak hours, where:
  - `z(p)` = the standard-normal quantile for probability `p` (one-sided). Implement a standard
    rational approximation (e.g. Acklam/Moro) clamped to `z ∈ [0, 2.5]`. `z(0.70) ≈ 0.524`.
  - `SOLAR_REL_SIGMA` = assumed day-to-day relative solar uncertainty, a documented constant
    (default **0.30**). Optionally widen it when the model is immature: `sigma = SOLAR_REL_SIGMA *
    (1 + (1 - effectivePR().confidence) * 0.5)` (more spread when few days learned). Keep simple if
    cleaner — a flat 0.30 is acceptable; document the choice.
- Compute `peakDeficitConfident = Σ over peak hours of max(0, loadKw[h] − optimisticSolarKw[h])`.
  The plan is **active** only when `peakDeficitConfident` clears the existing worthwhile threshold
  (the same >0.05 kWh / spread gates). When the confident deficit is ~0 (optimistic solar carries
  the peak), stand down — `active=false`, reason "≥{conf}% chance solar carries the next {peak}".
- Keep the **sizing** of the valley buy solar-first as today (target/shortfall from the mean
  forecast), but never buy more than the confident deficit needs. Net: the *trigger* uses optimistic
  solar (high bar to act); the *amount* stays solar-first.
- New param `solarConfidencePct` (default **70**, clamp 50–95) in `TariffArbitrageParams` +
  default + sanitize. Surface in the edit UI + reflect in the WHEN card text ("forecast solar won't
  carry the next P1 cycle — ≥70% certain").

## Item 3 — pre-peak surplus stand-down (live guard)

When the next P1 is imminent and the house is already in strong solar surplus, don't grid-buy — free
solar will fill the battery. In `coordinateArbitrageValleyCharge`, before engaging a valley charge:
- Compute hours-until-next-peak from `currentLocalHour()` + the next-peak hour (item 1).
- Read live `solarKw = snap.sonnen.productionW/1000`, `loadKw = snap.sonnen.consumptionW/1000`.
- If `hoursToPeak <= prePeakSurplusGuardHours` AND `solarKw >= (1 + prePeakSurplusMarginPct/100) *
  loadKw` (and `loadKw > 0`): **stand down** — do not engage the grid-charge this tick; emit a
  `standdown` event with reason "pre-peak surplus: solar {x}% over load, P1 in {h}h". This composes
  with (and fires earlier than) the existing `surplusOverridesGridCharge` export-defer.
- New params: `prePeakSurplusGuardHours` (default **2**, clamp 0–6), `prePeakSurplusMarginPct`
  (default **30**, clamp 0–200) + defaults + sanitize. Surface minimally in the edit UI; add a chip
  to the UNTIL/LIMITS card ("stand down if P1 <2h away & solar >130% of load").

## Item 4 — fix the deviation signal (forecast-vs-actual, not SoC trajectory)

Replace the broken SoC-trajectory comparison with a forecast-vs-actual divergence on the live
inputs, so `deviation` only fires on a real surprise (clouds/sun/usage), not every tick.
- For the current hour `h`: `fSolar = forecastSolarKw[h]`, `fLoad = loadForecastKw[h]` (the same
  arrays the plan used); `liveSolar = snap.sonnen.productionW/1000`, `liveLoad =
  snap.sonnen.consumptionW/1000`.
- Trigger a re-plan + `deviation` event when EITHER diverges beyond a threshold:
  `|liveSolar − fSolar| >= max(deviationMinKw, deviationThresholdPct/100 * fSolar)` OR the analogous
  load test. On trigger: `_resetArbitrageCache()` → recompute → emit `deviation` with the
  forecast-vs-actual solar/load values + which input diverged.
- Repurpose `deviationThresholdPct` as a **% of the forecast value** (default **30**), and add
  `deviationMinKw` (a floor so tiny forecast values don't trigger on noise, default **0.8**) +
  default + sanitize. Drop the SoC-gap comparison entirely.
- This must NOT fire every tick under steady conditions. Sanity check the de-dup: the existing
  state-transition gating is for engage/revert/standdown; `deviation`/`plan` always log when they
  occur, so only emit `deviation` when the threshold is actually crossed (not continuously while
  diverged — re-plan once, then the new forecast becomes the baseline; if it keeps diverging that's
  a genuine new surprise and re-logging is acceptable, but verify it isn't a per-tick storm under
  normal weather).

## Out of scope
- Do NOT auto-enable/arm or change the advisory default. Advisory still issues zero writes.
- Do NOT add an explicit peak-discharge command (still implicit via self-consumption).
- Do NOT change soak-export (#34), battery-priority, guardrails, or the effectiveness-log schema
  beyond adding any new fields the items above require.
- No learned load model this round.

## Acceptance
- `pnpm --filter @energy/api typecheck` + `pnpm --filter @energy/web typecheck && build` clean.
- Overnight (P3, no remaining peak today), the planner targets TOMORROW's 10:00 P1 and selects the
  overnight P3 hours as the valley window.
- With forecast solar comfortably covering the next peak, the rule stands down (≥conf% gate); lower
  `solarConfidencePct` or worsen the forecast and it activates.
- With P1 <2h away and live solar >130% of live load, the rule stands down with the pre-peak-surplus
  reason even if not yet net-exporting.
- Under steady conditions the `deviation` event does NOT fire every tick; a real solar/load swing vs
  forecast triggers exactly one re-plan + `deviation`.
- Advisory mode still commands the battery zero times. UI (desktop + mobile) reflects the new
  WHEN/UNTIL text + the new tunables.
