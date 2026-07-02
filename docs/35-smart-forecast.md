# 35 — Smarter rolling production / consumption / charging forecast

## Problem

The Live **"Today"** chart's production forecast is structurally off (owner report,
2026-07-01). Root cause: two forecast surfaces have diverged and the one the owner
looks at is the naïve one.

- **Live "Today" chart** — `apps/api/src/routes/history-day.ts`
  - `solarForecast(rad)` = `shortwave/1000 × kWp × 0.82` — a **flat** performance
    ratio, no learning, no clear-sky reference, no day-shape, no inverter cap.
  - `loadForecast(temp)` = a **hardcoded generic** 24 h curve + thermal nudge — not
    learned from this house.
  - **No charging forecast** (`forecast.chargeKw` left null).
- **Autopilot 24 h plan** — `apps/api/src/routes/brain.ts` — *does* use the learned
  model (`effectivePR()` from `solar-model.ts`), but only a **single scalar PR per
  month** (no day-shape), and its `solarForecast`/`loadForecast` are its own copies.

We already have the raw materials:
- `solar-model.ts` — Haurwitz **clear-sky GHI** ("ideal parabola" for the time of
  year via solar geometry at 38.79 °N) + a self-learning per-month PR with confidence
  blending, nightly ingest, and one-time history backfill.
- `history5m.ts` — **30 days** of measured 5-min buckets: `solarKw`, `homeKw`,
  `chargeKw`, `dischargeKw`, SoC. This is the training set.
- `weather.ts` — Open-Meteo hourly `shortwave_radiation`, `cloudcover`, temp, etc.

## Goal

One shared, self-improving forecast, used by **both** surfaces:

1. **Solar** = clear-sky ideal × learned **per-hour** roof shape × live per-hour
   weather attenuation (the owner's exact mental model: "ideal parabola for the time
   of year, combined with hourly sun/cloud data").
2. **Consumption** = learned household profile (per hour, weekday/weekend) blended
   with the generic base by confidence, plus the thermal nudge.
3. **Charging** = derived from the SoC trajectory battery deltas (charge when solar
   surplus fills the tank), so the "Charging" series gets a forecast extension too.

## Design

### 1. Solar — decomposed clear-sky × learned shape × live weather

In `solar-model.ts`:

- **Clear-sky potential** (already have): `clearSkyKw[h] = haurwitzGHI(elev(h,doy,lat))/1000 × kWp`.
- **Learned per-hour roof shape** — extend the learned model from a scalar to a
  24-length profile. `roofShape[h]` = median over retained daytime days of
  `measuredSolarKw[h] / clearSkyKw[h]`. This captures orientation/tilt/shading
  asymmetry (e.g. SE roof → mornings over-perform, late afternoon shaded) — i.e. the
  **shape**, not just the level. Where a given hour is thin on samples, fall back to
  the scalar `prEff` (blend by per-hour sample confidence).
- **Live weather attenuation** — `weatherFactor[h] = clamp(liveShortwave[h] / clearSkyGHI[h], 0, 1.1)`.
  Decouples fast-moving clouds (per-hour) from the slow-moving roof factor. When no
  live weather, `weatherFactor = 1` over daylight (clear-sky assumption) — but keep
  the synthetic bell as the ultimate fallback when geometry can't be trusted.
- **Compose**: `solarKw[h] = clearSkyKw[h] × roofShape[h] × weatherFactor[h]`, capped
  at the inverter AC limit (use `config.site.solarKwp` as a sane clip, or a dedicated
  AC-cap const if you add one — document the choice).

New export: `forecastSolarKw(weather: WeatherForecast | null, date: Date): number[]`
(24 hourly kW). Keep `effectivePR()` for the confidence badge the UI shows.

### Addendum (2026-07-02) — learn from the CLEAR-DAY percentile, not the median

Two problems surfaced with a median-based roof shape:

1. **Weather double-count.** `measured/clearSky` on a historical day already bakes in
   *that day's* clouds, and we *also* apply today's live `weatherFactor` on top — so a
   median (≈ the typical, partly-cloudy day) under-reads clear days by ~10%.
2. **Outage contamination.** A real multi-day inverter fault (2026-07-01: one of two
   Sungrow inverters down → array at ~50%) is a run of low `measured/clearSky` days. A
   median gets dragged down by a sustained outage and then under-forecasts for days
   *after* the fix.

Fix (both at once): learn the per-hour roof factor as a **high percentile (p80)** of
the `measured/clearSky` distribution instead of the median — i.e. the roof's
**clear-day efficiency** (its best, clear, fully-healthy days). The live
`weatherFactor` then cleanly applies today's actual clouds on top (no double-count).
Cloudy days *and* inverter-outage days are low-side samples the p80 ignores, so a
fault no longer corrupts the learned roof and the forecast keeps predicting full
potential — the shortfall shows up as a visible actual-vs-forecast gap. Genuine
shading (a hour that is low even on clear days) still reads low → correctly learned.
Thin hours (< 4 sample-days) fall back to the median. Constants:
`ROOF_SHAPE_PERCENTILE = 0.8`, `ROOF_SHAPE_MIN_DAYS_FOR_PCTL = 4`.

Follow-ups (not in this change): (a) persist hourly **irradiance** alongside
production so future learning can compute a truly weather-independent roof efficiency
(`measured / actualIrradiance`); (b) once Sungrow per-inverter telemetry is connected,
raise a **production-vs-forecast deviation alert** to auto-detect exactly this kind of
inverter outage.

Model persistence changes (`solar-model.ts` `MonthRecord`):
- Add `hourlyPR: number[]` (24) + `hourlyDays: number[]` (24 per-hour sample counts).
- `dayHourlyPRFromHistory(dateKey)` → per-hour ratio array (null where that hour had
  no usable daytime production).
- `applyDayPR` folds **both** the scalar and the per-hour arrays (running mean).
- `backfillFromHistory` + `ingestDay` populate both. Bump the file `v` and hydrate
  old files (missing hourly arrays → seed from scalar). Keep it backward-compatible.

### 2. Consumption — learned household profile

New `apps/api/src/load-model.ts` (pure functions over `history5m`; no new persistence
— the 30 days are already in memory):

- `forecastLoadKw(date: Date, temp: number[] | null): number[]`:
  - Learned base = per-hour median of measured `homeKw` over the last ~21 retained
    days, **split weekday vs weekend** (consumption differs); pick the day-type
    matching `date`.
  - Blend with the existing hardcoded base curve by `confidence = min(1, daysSeen/14)`.
  - Add the thermal nudge on top (heating < 16 °C, cooling > 26 °C) as today.
  - Return 24 hourly kW. Falls back cleanly to the base curve with no history.

### 3. Charging — derive from the SoC trajectory

The `plan()` / `socTrajectory()` loop already computes per-hour battery `deltaKwh`.
Return it and split: `chargeKw[h] = max(0, deltaKwh)`, `dischargeKw[h] = max(0, -deltaKwh)`.
Wire into `history-day.ts` `forecast.chargeKw` / `forecast.dischargeKw`.
`DayChart.tsx` already has a "Charging" series → its dashed forecast extension appears
with no frontend change (verify the field mapping).

### 4. Share the model across both surfaces

- `history-day.ts`: delete the local `solarForecast`/`loadForecast`; call
  `forecastSolarKw` + `forecastLoadKw`; have the trajectory emit charge/discharge and
  populate `forecast.chargeKw`/`dischargeKw`.
- `brain.ts`: replace its `solarForecast(rad, prEff)` + `loadForecast(temp)` with the
  shared functions so Autopilot and Live agree pixel-for-pixel. Keep `genKwh` /
  `sunIntensityPct` derived from the new `solarKw`.

## Tests

- `solar-model`: per-hour profile learning from a synthetic history; `forecastSolarKw`
  July-at-38.79 °N clear-sky peak is sane (near kWp × PR); weatherFactor attenuates;
  no-weather fallback; inverter cap; back-compat hydrate of an old scalar-only file.
- `load-model`: learned blend + confidence ramp + fallback with no history; weekday
  vs weekend split.
- Keep every existing test green (`climate-optimistic.test.ts`, `irrigation-engine.test.ts`, …).

## Safety / deploy

- Forecast is advisory/display and feeds the plan SoC trajectory (display) and the
  tariff-arbitrage overlay (**Advisory only — not Active**, per the arbitrage soak).
  No new live control authority; live surplus/discharge logic reads live values, not
  the forecast.
- Normal CI deploy on merge to `main` — **preserve armed state, do NOT disarm**
  (no risky control-logic change).
