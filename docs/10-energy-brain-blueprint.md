# Energy Brain — Orchestration Blueprint

> The "boss" that turns two dueling batteries, two solar arrays, a thermal house,
> EVs and the grid into one optimized system. 2026-06-24.
> Grounded in `05-api-capability-matrix.md`, `06-strategy-context.md`, tariff `00` §4.

---

## 0. Design philosophy
- **One optimizer, many actuators.** A single brain owns the plan; batteries,
  flexible loads and (future) house circuits are its hands. No device self-optimizes
  against the others — that's today's problem.
- **Predict, then act.** Decisions are driven by *forecasts* (solar, temperature →
  demand, prices, habits), not just the current instant. The instant only triggers
  fast corrections.
- **Value-aware, not power-aware.** Every kWh is priced at its real marginal value
  (avoided P1 import ≈ €0.21, not the €0.03 export rate). The brain optimizes money
  and independence, not raw flows.
- **Safe and humble.** Hard guardrails, fail-safe to vendor auto mode, explainable
  decisions, and "first, do no harm" defaults. It earns autonomy in stages.

## 1. The value ladder (why the brain leans the way it does)
Each kWh of solar, ranked by what it's worth to *you*:
1. **Self-consumed during P1** → avoids €0.2093 (the jackpot).
2. **Self-consumed during P2** → avoids €0.1309.
3. **Stored now, self-consumed in P1 later** → ≈ €0.21 minus round-trip loss.
4. **Self-consumed during P3 / charges the car** → avoids €0.0957.
5. **Exported** → €0.003–0.029 (essentially given away).
⇒ **Rule of thumb: never export a kWh you could store and use in P1; never import in
P1 what a battery could supply.** The whole strategy falls out of this ladder.

## 2. Architecture — five layers
```
 ┌─────────────────────────────────────────────────────────────────────┐
 │ 5. GUARDRAILS  SoC floors/ceilings · 14 kW cap · rate limits ·       │
 │                watchdog → fail-safe to vendor auto · manual override  │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 4. ACT      plan → commands.  Tesla: mode/reserve/grid-charge/ToU     │
 │             (policy).  Sonnen: manual setpoints (precise actuator).    │
 │             Flexible loads: EV/water/pool/HVAC.  House: load tiers.    │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 3. PLAN  (the brain)  ── MPC optimizer over a 36 h rolling horizon ──  │
 │          day-ahead dispatch + real-time "reflex" balancer             │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 2. FORECAST  solar yield · thermal demand · base load · price calendar │
 ├─────────────────────────────────────────────────────────────────────┤
 │ 1. SENSE  Sonnen · Tesla · solar(2 arrays) · grid · weather · EV ·     │
 │           (future) per-circuit meters / smart switches                 │
 └─────────────────────────────────────────────────────────────────────┘
```
Runs server-side on the VPS (always-on); the PWA is the window into it.

## 3. Forecast layer (the brain's foresight)
- **Solar yield** — Open-Meteo solar-radiation API for Jávea (lat 38.79, lon 0.17),
  GHI/DNI → per-array kWh/hour using each array's kWp + orientation. Tells the brain
  how full tomorrow's "free" tank will be.
- **Thermal demand** — temperature + humidity forecast → heating need (cold) / cooling
  need (hot > ~30 °C) for the all-electric house, via a simple RC thermal model of the
  house + underfloor slab. This is the key, under-used signal: weather drives **both**
  supply and demand here.
- **Base load** — learned daily/weekly consumption profile (later sharpened by
  appliance disaggregation). Predicts the non-deferrable baseline.
- **Price calendar** — deterministic 2.0TD band schedule incl. Spanish holidays;
  ready to swap to PVPC hourly prices if the contract changes.
- Each forecast carries an error band; the optimizer is re-solved as they sharpen.

## 4. Plan layer — Model Predictive Control (MPC)
**Why MPC:** the problem is multi-step, constrained, and forecast-driven — exactly
what MPC is for. It co-optimizes both batteries, thermal pre-conditioning and
flexible loads over a horizon, then re-plans as reality updates. Far smarter than
fixed rules, and naturally handles "charge cheap tonight only if tomorrow is cloudy."

**Horizon / cadence:** 36 h at 15-min steps, re-solved every ~10 min (rolling/
receding horizon). A lightweight LP/MILP — small enough to solve in milliseconds.

**Decision variables (per step):** Sonnen charge/discharge power (±4.6 kW, continuous);
Tesla SoC trajectory (realised via policy — see §5); flexible-load schedule (EV kW,
water-heater on/off, pool, HVAC pre-condition); grid import/export (derived).

**State:** Sonnen SoC, Tesla SoC, house thermal state (indoor temp / slab energy).

**Constraints:**
- Battery dynamics `SoC[t+1] = SoC[t] + η·P·Δt`; SoC ∈ [floor, ceiling]; Tesla ≥ dynamic
  reserve (§7); Sonnen ≤ 4.6 kW.
- Power balance every step (solar + discharge + import = load + charge + export + flex).
- **Grid import ≤ 14 kW** (hard — physical + power-term), export ≤ 9 kW.
- Thermal comfort band on indoor temp; HVAC energy ↔ temp via the RC model.

**Objective (minimise), scenario-weighted (§9):**
`Σ import·price[band]  −  value_of_stored_energy(terminal)  +  export·(−comp_rate)
 +  w_comfort·thermal_deviation  +  w_health·battery_throughput
 +  w_resilience·shortfall_below_dynamic_reserve`
i.e. pay the least, keep useful energy, barely value export, stay comfortable, don't
shred battery life for pennies, and stay resilient.

**Reflex layer (between MPC solves, seconds-scale):** fast safety/optimal corrections
that don't wait for the next solve —
- **Peak-shave:** import nearing 14 kW → ramp Sonnen discharge instantly.
- **Anti-idle (fixes "Sonnen stuck at 100%"):** surplus solar + battery not full →
  force charge; P1 + load present + battery idle → force discharge.
- **Export-avoidance:** exporting while a battery has headroom → redirect to charge.

## 5. Two-battery coordination (the core trick)
The batteries are **asymmetric**, so we use them for different jobs:
- **Tesla = the reservoir + policy engine (27 kWh, no exact-W command).** The brain
  sets `default_real_mode` (self_consumption / autonomous), `backup_reserve_percent`
  (the resilience floor), grid-charge enable, export rule = `pv_only`, and feeds it the
  **2.0TD tariff** so its native optimizer pulls in the same direction. Tesla carries
  the bulk energy and the backup duty.
- **Sonnen = the precise fast valve (≤4.6 kW, exact setpoints).** Held in **manual
  mode**; the brain issues charge/discharge setpoints each cycle to fill the gaps Tesla's
  coarse policy leaves — peak-shaving, fine self-consumption tracking, and never sitting
  idle when it should work. Falls back to self-consumption mode if the brain drops out.
- **Dispatch order** (from the MPC allocation, so they never fight): charge → soak solar
  into whichever battery preserves the best *evening* position (avoid both hitting 100%
  by noon and then exporting); discharge in P1 → Sonnen trims precisely while Tesla
  carries the base, both sized to avoid grid import without over-cycling.

## 6. Weather & thermal intelligence — the "virtual battery"
The house itself stores energy. The underfloor slab + building mass = a **thermal
battery** with hours of inertia, and it's free.
- **Pre-cool** before hot P1 afternoons (forecast > 30 °C): run A/C on midday solar /
  cheap P2 so the house coasts cool through the 18:00–22:00 peak with the compressor off.
- **Pre-heat** the slab in P3 / solar on cold days so evening warmth needs no P1 import.
- **Solar-aware charging:** only grid-charge overnight (P3) for the deficit tomorrow's
  forecast solar *won't* cover — never blindly fill.
- Net effect: shift a big chunk of HVAC (your largest all-electric load) off P1 and
  onto solar/P3, using thermal mass instead of battery cycles.

## 7. Independence & resilience
- **Self-sufficiency push:** objective weight rewards self-consumption; loads chase
  solar; P3 pre-charge bridges the night; thermal pre-conditioning removes P1 HVAC.
  Target: near-zero P1 import, season-aware (summer = solar-led; winter = P3 + pre-heat).
- **Dynamic Tesla reserve (weather-driven):** backup floor isn't fixed at 20 %. It
  rises automatically when outage risk rises — **storm forecast, grid-instability
  history (the Tesla voltage dropouts), or low grid reliability windows** — and relaxes
  when calm, so you're protected when it matters without wasting capacity daily.
  (Sonnen is **never** counted as backup — it can't island.)
- **Islanding readiness:** the brain knows Tesla's true backup runtime at all times and
  surfaces it; on a real outage it flips to backup-management mode (§8).

## 8. House modes & smart switches (the future multiplier)
Switchable circuits turn "how much battery" into "how *long* the battery lasts."
- **Circuit tiers** (mapped once, per smart switch / smart breaker — e.g. Shelly Pro,
  smart panel):
  - **Critical** — fridge/freezer, network, security, medical, a few lights.
  - **Comfort** — HVAC, water heating, general sockets.
  - **Discretionary** — pool pump, EV charging, dryer, secondary AC.
- **Mode state machine:** `Normal → Eco (Reduced) → Critical`, with **auto-transitions**:
  - Grid **outage** (Tesla island) → shed to **Critical** to stretch the 27 kWh; one A/C
    zone kept in extreme heat if SoC allows.
  - **Low SoC + expensive P1** → **Eco**: pause discretionary, throttle comfort.
  - **Storm forecast** → pre-charge + raise reserve (§7), pre-condition (§6).
- **Why it's powerful:** Normal ≈ 27 kWh / ~1.7 kW ≈ **16 h**. Critical (~0.4 kW) ≈
  **2.5+ days**. Load-tier shedding multiplies your resilience far more than more battery.
- Designed as a clean abstraction now (tiers + a `setMode()` interface) so adding the
  physical switches later is plug-in, not a rebuild.

## 9. Scenario profiles (user-selectable strategies)
Each profile is just a **re-weighting of the MPC objective + a few constraints** — same
brain, different priorities:
| Profile | Leans toward | Key settings |
|---|---|---|
| Max self-consumption | independence | high self-use weight, export `pv_only`, no grid-charge |
| Max savings | money | aggressive P3→P1 arbitrage, grid-charge on when profitable |
| Max independence | off-grid feel | minimise all grid import, deep pre-conditioning |
| Storm / outage-risk | resilience | Tesla reserve high, pre-charge, Eco-ready |
| Cheap-night EV | EV cost | schedule both i3s in P3 under 14 kW |
| Comfort-first | thermal | tighter comfort band, HVAC priority |

## 10. Safety, guardrails, fail-safe
- **Hard limits** the optimizer can never violate: SoC floor/ceiling per battery,
  14 kW import cap, per-device power/ramp limits, Tesla reserve floor.
- **Watchdog → fail-safe:** if the brain, a connector, or the VPN drops, devices revert
  to safe vendor defaults (Sonnen self-consumption mode; Tesla self_consumption +
  standing reserve). Stale-command guard: never act on data older than N seconds.
- **Battery-health budget:** a per-day throughput/cycle budget so it won't trade cycle
  life for marginal cents; respects warranty envelopes.
- **Manual override + "explain":** one-tap return to manual, and every action is logged
  with a plain-English reason ("charging now: cloudy tomorrow, P1 in 2 h").
- **Conflict resolution:** the MPC allocation is the single source of truth so the two
  batteries can never fight or double-serve a load.

## 11. Learning loop
- Learn the household's consumption signature (and sharpen with appliance
  disaggregation later) → better base-load forecasts.
- Online correction of solar/thermal forecast bias from realised data.
- Track **counterfactual savings** (€ saved vs the old vendor-default behaviour) and
  feed realised-vs-planned error back to improve the next plan.

## 12. What makes this genuinely innovative
1. **MPC co-optimizing two heterogeneous batteries** with asymmetric control surfaces —
   precise Sonnen + policy-driven Tesla — most home systems control one battery with rules.
2. **The house as a thermal battery** — pre-conditioning the slab to dodge P1, modeled
   explicitly, not just "smart thermostat" guesswork.
3. **Weather-driven dynamic resilience** — backup reserve that breathes with storm/outage
   risk, directly answering the silent-Tesla-dropout pain.
4. **Tier-based load shedding** — turning a fixed battery into days of autonomy.
5. **Value-priced optimization** — decisions made on avoided-cost €, not raw kW.
6. **Explainable autopilot + digital twin** — preview "what the boss plans today" with
   projected € and self-sufficiency, and simulate any scenario before trusting it.

## 13. Phased rollout (earn autonomy)
- **Phase 0 — Shadow mode.** Brain computes the full plan and logs *what it would do*,
  takes **no control**. Validate forecasts + dispatch vs reality, show projected savings.
  Zero risk; builds trust. (Pairs with the monitoring MVP already designed.)
- **Phase 1 — Gentle control.** Set Tesla mode/reserve + Sonnen anti-idle and
  peak-shave. Immediately fixes "Sonnen stuck at 100 %" and "exporting cheap, importing
  dear." Conservative guardrails.
- **Phase 2 — Full MPC orchestration.** Day-ahead optimization + flexible-load scheduling
  (EV, water, pool, HVAC pre-conditioning) + scenario profiles.
- **Phase 3 — House modes / smart switches + EV V2X.** Tiered shedding, Normal/Eco/
  Critical automation, and bidirectional EV as another battery when a V2X car arrives.

## 14. Interfaces (control-surface mapping)
- **Tesla (cloud):** `operation.default_real_mode`, `backup.backup_reserve_percent`,
  `grid_import_export` (grid-charge + export rule), `time_of_use_settings` (feed 2.0TD),
  `storm_mode`. Poll `live_status` 30–60 s; commands event-driven (rate/billing aware).
- **Sonnen (LAN via VPN):** `EM_OperatingMode` (1 manual), `setpoint/charge|discharge`,
  `EM_USOC`, `EM_ToU_Schedule`. Poll `latestdata`/`powermeter` ~5–15 s for the reflex loop.
- **Weather:** Open-Meteo (free) for Jávea.  **EV:** charge windows now → V2X later.
  **House:** `setMode()` + per-circuit relays (future).
