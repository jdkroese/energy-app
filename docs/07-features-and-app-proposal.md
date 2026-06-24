# Feature Recommendations & Web App Proposal

> 2026-06-24. Built on `05-api-capability-matrix.md` + `06-strategy-context.md`
> + tariff (`00` §4). Phase 2 (features) + Phase 3 (app structure) of the plan.

## Part 1 — Feature recommendations (by capability group, with build priority)

Priority key: **[MVP]** first release · **[V1]** core · **[V2]** advanced.

### A. Consolidated monitoring & reporting
- **[MVP]** Live unified dashboard — animated power-flow (solar→house→batteries→grid),
  both arrays, both batteries (combined + individual SoC/power), house load, grid
  import/export, **current tariff band (P1/P2/P3)**, active scenario, **Tesla backup
  readiness**.
- **[MVP]** History & reporting — solar produced, self-consumption %, self-sufficiency,
  grid import/export, **cost in € via 2.0TD bands** + export compensation; day/week/
  month/year; Tesla `calendar_history` + our logged Sonnen series unified.
- **[V1]** Per-system deep views — Sonnen cell temps/voltages, cycle count, health
  bitfield; Tesla site/backup status, per-Powerwall (via TEDAPI later).
- **[V1]** Savings tracker — € saved vs "no optimization" baseline; payback view.

### B. The Coordinator ("the boss") — control
- **[V1]** Two-battery orchestration using the asymmetry: shape **Tesla** via
  mode/reserve/grid-charge/export/tariff; use **Sonnen setpoints** as the fast
  balancer (forces it to discharge → fixes "stuck at 100%").
- **[V1]** **Scenario profiles** (the core configurable feature) — each profile sets a
  coherent combo of Tesla + Sonnen levers + flexible-load schedule, **backup-aware
  (Tesla reserve)**, informed by tariff + solar + thermal forecast. Seed set:
  Summer self-consumption · Storm/outage-risk · Cold snap · Dull-day arbitrage ·
  Cheap-night EV.
- **[V1]** Scheduled automation engine — time + tariff-band + forecast triggers, with
  **guardrails** (≤14 kW grid cap, SoC floors/ceilings, fail-safe back to vendor auto).
- **[MVP-]** Manual control panel — apply scenario now, set reserves, override; (read-only
  until control is enabled).

### C. Forecasting & optimization intelligence
- **[V1]** Weather feed for **Jávea** — solar irradiance + temperature.
- **[V1]** Solar-yield forecast → battery headroom planning + overnight P3 charge
  decision for dull tomorrows.
- **[V2]** Thermal-demand forecast (heat pump/underfloor + A/C >30 °C) → **pre-heat/
  pre-cool** scheduling using slab thermal inertia to dodge the P1 peak.
- **[V1]** Price-aware optimizer (2.0TD now; ready for PVPC hourly later).
- **[V1]** "Today's plan" timeline — what the boss intends to do hour-by-hour.

### D. Load intelligence
- **[V2]** Appliance disaggregation (NILM) from whole-home signal and/or per-circuit /
  smart-plug metering → identify appliances + usage patterns.
- **[V2]** Pattern learning (daily/weekly habits) → better forecasts.
- **[V1]** Flexible-load scheduler — 2× BMW i3, pool pump, water heating, laundry,
  HVAC pre-conditioning → into solar/P3 windows, bounded by 14 kW.
- **[V2]** EV deeper integration; **[V2+]** V2G/V2H/V2X when a capable vehicle arrives.

### E. Alerts & notifications (WhatsApp + PWA)
- **[MVP]** **Tesla dropout / power-off detection** (today's silent failure) + grid-
  outage / island-mode alert.
- **[MVP]** Fault/alarm alerts — Sonnen `systemalarm`/`ic_status`, device offline.
- **[V1]** Low **Tesla** backup-reserve warning; abnormal grid-charging; threshold alerts.
- **[V1]** Optimization notices ("grid-charging tonight; dull day forecast").

### F. Configuration & system
- **[MVP]** Connections health (Tesla tokens, Sonnen token, weather, Sungrow).
- **[MVP]** Tariff config (2.0TD bands, power term, export rates).
- **[V1]** Asset inventory (batteries, arrays, EV, HVAC), guardrail/safety config.

## Part 2 — Web app structure (pages)

1. **Dashboard (Live)** — hero power-flow diagram, key tiles (solar, load, grid, each
   battery SoC, tariff band, backup readiness), active scenario, mini "today's plan".
2. **Reporting / History** — charts: production, self-sufficiency, flows, € savings;
   date-range + P1/P2/P3 breakdown; export vs self-consumed.
3. **Batteries** — combined view + **Sonnen** detail (health/cells/cycles) + **Tesla**
   detail (backup status, reserve); role/utilisation explainer.
4. **Solar** — Array A (Sungrow) + Array B (Tesla), forecast vs actual, per-array yield.
5. **Scenarios / Strategy** — profile list, visual editor (levers per battery + loads),
   schedule/triggers, active profile, "apply now", guardrails.
6. **Forecast** — weather (solar + temp), solar-yield forecast, thermal-demand outlook,
   planned-actions timeline.
7. **Loads & Appliances** — disaggregation/patterns, flexible-load scheduler, EV charging.
8. **Alerts** — event feed, rule config, channel setup (WhatsApp + PWA).
9. **Settings** — connections, tariff, asset inventory, safety limits, users.

Cross-cutting: installable **PWA** (push + mobile), dark theme, near-real-time updates,
role of "boss" status always visible.

## Part 3 — Suggested build phasing (gate each)
- **MVP** — pages 1,2,8,9 (read-only monitoring + reporting + alerts + settings). No control.
- **V1** — coordinator + scenarios (pages 3,5,6), forecasting, flexible-load scheduler;
  requires the Spain↔VPS VPN for live Sonnen control.
- **V2** — load disaggregation, thermal pre-conditioning, EV depth, V2X-ready.

## Part 4 — Design brief seed (for Claude design, Phase 3 final)
Direction to refine with owner: clean, data-dense but calm energy dashboard; dark-first;
clear power-flow visualization as the signature element; trustworthy/"in control" tone
(this app is the boss); mobile/PWA-first; accent that reads as solar/energy. Full brief
to be written once scope + look are agreed.
