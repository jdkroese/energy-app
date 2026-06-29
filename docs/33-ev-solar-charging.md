# 33 — EV (car) solar/P3 charging for the metered circuit breaker

**Status:** spec → build (branch `ev-solar-charging`)
**Owner decisions captured 2026-06-29.**

The car charger sits on a metered Tuya **circuit breaker** (`type: 'circuit'`, on/off only,
no modulation). We want it to charge from **excess solar** (and optionally the cheap **P3**
tariff band) instead of always pulling whatever the car asks for. Crucially, the car must
claim surplus **before** the surplus-solar cooling rule, so AC only runs on what's left.

## Owner decisions

1. **Excess-solar priority: Battery → Car → Cooling.** The car uses surplus *beyond* what the
   home battery can absorb. This is exactly what `climateSurplusW` already computes
   (`PV − houseLoad − batteryIntakeHeadroom`), so the battery loop (`coordinator.ts`
   soak-export) is **unchanged**.
2. **Charger draw is auto-learned from the breaker meter.** No fixed kW. BMW i3 "slow" ≈
   3.7 kW (16 A 1-phase), "fast" ≈ 7.4 kW; two cars may charge on one breaker at once, so a
   fixed number is fragile. Start from a conservative estimate and learn the real draw from
   `cur_power`.
3. **"Daytime only" = the existing schedule system** (sunrise+1h → sunset−1h), offered as a
   one-tap preset on the breaker — *not* new control logic.
4. **Primary new control = a checkbox "Solar / P3 charging only"** on the breaker's device
   settings. Checked ⇒ the rule owns the breaker (surplus- or P3-gated). Unchecked ⇒ **max
   charging** = today's behavior (manual/schedule only, rule never touches it).

## Behavior

When a breaker has `solarP3Only = true` **and** the system is **armed + auto**, the EV-surplus
rule decides on/off each surplus tick:

- **Allowed to charge** = `surplusOk` **OR** `bandIsP3`.
  - `surplusOk` (solar): `climateSurplusW ≥ startThresholdW`, where
    `startThresholdW = learnedDrawW + startMarginW`. Hysteresis: once ON for the solar reason,
    stay on until surplus stays below `learnedDrawW − stopHysteresisW` for `surplusClearSec`
    (don't drop the charge for a passing cloud).
  - `bandIsP3` (cheap grid): current tariff band is P3. While P3, charging is allowed even
    without surplus (owner explicitly wants P3 grid-charging).
- **Turn ON** when allowed and currently off (rule-provenance recorded).
- **Turn OFF** when not allowed, debounced by `surplusClearSec` and `minCycleMin` to avoid
  breaker chatter. Only switch off breakers the rule turned on (don't fight manual/schedule).
- **Max charging** (checkbox off): rule is inert, `reservedW = 0`.

### Auto-learn

While the breaker is on and `cur_power > learnFloorW` (e.g. 500 W), update
`learnedDrawW` as an EMA of measured power. Persist it per-device. Seed = `estimateW`
(default 3700). Because it measures the breaker total, two cars charging together are handled
automatically.

### Reservation — how cooling gets "remaining capacity"

The cooling rule reasons about `snap.surplusW`. Once the car is actually charging, its draw is
already in `houseLoad` so surplus drops naturally — but in the **same tick** we decide to turn
it on, metering hasn't caught up. So the EV rule returns `reservedW` and the climate loop
subtracts it before evaluating cooling:

- `reservedW = max(lastMeasuredW, learnedDrawW)` while the rule holds the breaker ON; else 0.
- In `climate-coordinator.tick()`, call `evaluateEvSurplus(snap)` **first**, then run the
  cooling/heating evaluations against `surplusW − reservedW`.

This guarantees the owner's rule: *surplus cooling only runs if, after the car breaker is on,
there's still enough capacity left.*

## Implementation

### API (`apps/api`)
- **New** `src/control/ev-surplus.ts`: `evaluateEvSurplus(snap): { reservedW }`. Gated on
  armed+auto + per-device `solarP3Only`. Issues the breaker switch via the same Tuya path
  `device-schedule-coordinator.ts` uses (`applyOn`/`applyOff` → `buildGenericCommands`).
  Tracks rule provenance + per-device on/off timestamps for `minCycleMin`. Reuse the existing
  **tariff band** helper (the one `coordinateArbitrageValleyCharge` uses) for `bandIsP3`.
- **`src/control/climate-coordinator.ts`**: call `evaluateEvSurplus(snap)` at the **top** of
  `tick()` (before `evaluateSurplusDirection` / precool / preheat) and subtract `reservedW`
  from the surplus those evaluations see.
- **Store** (`src/store.ts`): per-device `solarP3Only: boolean` (default false) +
  `learnedDrawW`. Global tunables block `evSurplus` with defaults: `estimateW: 3700`,
  `startMarginW: 300`, `stopHysteresisW: 300`, `surplusClearSec: 180`, `minCycleMin: 5`,
  `learnFloorW: 500`. Extend the `PUT /api/devices/:id/settings` handler to accept
  `solarP3Only`.
- **No change** to `coordinator.ts` (battery / soak-export).

### Web (`apps/web`) — responsive, both `wide` and narrow branches
- **Breaker device settings** (`screens/GenericDeviceDetail.tsx`, circuit breakers): a "Solar
  charging" section with the **"Solar / P3 charging only"** toggle → `api.devices.setSettings(id,
  { solarP3Only })`. Show a status line: mode, learned draw, and live state (charging on
  surplus / charging on P3 / waiting for surplus / max). Add a **"Daytime only" preset** button
  that creates the sunrise+1h→sunset−1h solar-anchored schedule via the existing schedule API.
- **`screens/Devices.tsx` `CircuitBreakerCard`**: small chip when `solarP3Only` is on (e.g.
  "☀ solar/P3") + current state.
- Follow the **Power** design system; reuse `SegmentedControl`/`Switch`/`Gauge` patterns.

## Safety / shipping
- Default `solarP3Only = false` ⇒ **no behavior change on deploy**; owner opts in per breaker.
  Rule only acts when armed+auto. No disarm needed for this release.
- Verify both viewports (preview ≥768 and <768). Typecheck + build before PR.
