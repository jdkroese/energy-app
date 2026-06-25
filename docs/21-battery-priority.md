# 21 — Battery-priority rules (Sonnen-first discharge / Tesla-first charge)

Two coordinator policies that decide **which battery acts first**, so the **Tesla
Powerwall is kept full for backup** — the Sonnen has no backup feature, so we never
want to spend Tesla capacity that an outage might need.

They live on the **Automations** page under a new **Battery** section, alongside the
existing climate automations.

## The two rules

| Rule | Goal | Mechanism (auto) | Throughput cap |
|------|------|------------------|----------------|
| **Discharge — Sonnen first** | Cover the house from the Sonnen; keep the Tesla full for backup. | Raise the Tesla `backup_reserve_percent` to its current SoC so it won't discharge; the Sonnen (self-consumption) carries the load. | Release the Tesla (drop reserve back to the scenario floor) once **grid import > cap kW** (Sonnen can't keep up) or the **Sonnen hits its SoC floor**. |
| **Charge — Tesla first** | When both are low, refill the Tesla first to restore backup. | Idle the Sonnen in manual (mode `1`, 0 W) so all solar surplus charges the Tesla. | Release the Sonnen (back to self-consumption, mode `2`) once **surplus > cap kW** (Tesla can't absorb it) or the **Tesla is full**. |

Only one regime is ever active per tick: there's either net surplus (charge rule
governs) or there isn't (discharge rule governs).

## Authority + safety

Each rule has its own **enable** + **authority**:

- **Shadow** (default) — computes and **logs** the intended action to the control
  command log, **writes nothing**. Watch it in Autopilot → Activity before trusting it.
- **Auto** — issues the real commands through the guardrailed `issue()` path.

The rules only act when the **battery Autopilot is armed in Auto** (Autopilot screen).
They boot **DISARMED** and **Shadow** after any deploy, like the rest of battery control.
All existing guardrails still apply (SoC floor, Tesla reserve floor, 14 kW import cap,
read-back confirm, per-lever 60 s rate-limit). Priority decisions are folded into the
**single** reserve / Sonnen-mode write per tick, so they never collide with the
scenario writes or trip the rate-limit.

## Throughput cap — what it really means

With load-following self-consumption we can't hold a battery to an arbitrary sub-inverter
output, so the cap is implemented as a **grid-flow threshold that releases the other
battery**:

- *Discharge:* the Sonnen carries the house alone; once **grid import** climbs past the
  cap (it's falling short), the Tesla joins to discharge.
- *Charge:* the Tesla absorbs surplus alone; once **export surplus** exceeds the cap (it
  can't take it all), the Sonnen joins to charge.

Default cap: **3.0 kW** each. Range 0–14 kW.

## Code map

- `apps/api/src/store.ts` — `BatteryPriority` / `BatteryPriorityRule` types, `ControlState.batteryPriority`, `defaultBatteryPriority()`, hydrate.
- `apps/api/src/control/battery-priority.ts` — **pure** `decideDischarge` / `decideCharge` / `planBatteryPriority`.
- `apps/api/src/control/coordinator.ts` — applies the plan in `applyActiveScenario` (Tesla reserve hold) + `coordinateSonnen` (charge idle); shadow rules log via `logShadow`.
- `apps/api/src/control/snapshot.ts` — adds `gridExportKw`.
- `apps/api/src/routes/control.ts` — `batteryPriority` in `getStatus`; `setBatteryPriority` updater.
- `apps/api/src/index.ts` — `PUT /api/control/battery-priority/:rule` (admin).
- `apps/web/src/lib/{types,api}.ts` — `BatteryPriority*` types + `api.control.batteryPriority`.
- `apps/web/src/screens/Automations.tsx` — Battery section + `BatteryRuleCard` (web + mobile).
