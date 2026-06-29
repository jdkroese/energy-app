// Unit tests for the irrigation ET / water-need engine + the coordinator's shadow/live
// decision and edge-firing logic. No real controller, network, or store needed.
//   run:  node --import tsx --test src/control/irrigation-engine.test.ts
//
// Covers the agronomic math (Kc, ETc, precip-rate, deficit), the schedule TRIM rules
// (rain-skip, low-ET reduction, heat top-up, soil-moisture override, ceiling invariant),
// and the pure coordinator helpers (edge crossing, due-time selection, window preference).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_KC,
  DEFAULT_FLOW_LPM,
  kcFor,
  flowLpmFor,
  volumeLiters,
  precipRateMmPerMin,
  etcMm,
  effectiveRainMm,
  rollupDayWeather,
  trimZone,
  daySavedPct,
  advanceDeficit,
  type DayWeather,
} from "./irrigation-engine";
import type { IrrigationZoneConfig } from "../store";
import { __test, liveAllowed } from "./irrigation-coordinator";
import type { StoreSchema } from "../store";

// ---- Fixtures ---------------------------------------------------------------

function zone(over: Partial<IrrigationZoneConfig> = {}): IrrigationZoneConfig {
  return {
    zoneId: "rb-1",
    name: "Lawn",
    plantType: "lawn",
    emitterType: "spray",
    managedBy: "app",
    heatTopupEnabled: false,
    wateringTimes: [],
    ...over,
  };
}

const dryDay: DayWeather = {
  et0Mm: 6,
  precipMm: 0,
  precipProbabilityPct: 10,
  peakHourEt0Mm: 0.8,
};
const wetDay: DayWeather = {
  et0Mm: 1,
  precipMm: 12,
  precipProbabilityPct: 90,
  peakHourEt0Mm: 0.2,
};

// ---- Agronomic math ---------------------------------------------------------

test("kcFor uses override else plant-type default", () => {
  assert.equal(kcFor(zone()), DEFAULT_KC.lawn);
  assert.equal(kcFor(zone({ kc: 1.4 })), 1.4);
  assert.equal(kcFor(zone({ kc: 0 })), DEFAULT_KC.lawn); // 0 is not a valid override
});

test("flowLpmFor uses override else emitter default; volume = minutes × flow", () => {
  assert.equal(
    flowLpmFor(zone({ emitterType: "drip" })),
    DEFAULT_FLOW_LPM.drip,
  );
  assert.equal(flowLpmFor(zone({ flowLpm: 5 })), 5);
  assert.equal(volumeLiters(zone({ flowLpm: 10 }), 6), 60);
});

test("etcMm = et0 × Kc × sunExposure, clamped", () => {
  const z = zone({ kc: 0.8, sunExposure: 0.5 });
  assert.equal(etcMm(z, 6), 6 * 0.8 * 0.5);
  assert.equal(etcMm(zone({ kc: 1 }), 6), 6); // sun defaults to 1
  assert.equal(etcMm(z, -3), 0); // negative et0 floored
});

test("effectiveRainMm applies the 0.8 retention factor", () => {
  assert.equal(effectiveRainMm(10), 8);
  assert.equal(effectiveRainMm(-5), 0);
});

test("precipRateMmPerMin = flow / area, clamped to [0.05, 2]", () => {
  assert.equal(precipRateMmPerMin(zone({ flowLpm: 10, areaM2: 20 })), 0.5);
  assert.equal(precipRateMmPerMin(zone({ flowLpm: 100, areaM2: 1 })), 2); // clamp high
  assert.equal(precipRateMmPerMin(zone({ flowLpm: 0.01, areaM2: 100 })), 0.05); // clamp low
});

test("rollupDayWeather sums precip/et0 and peaks probability + hourly et0", () => {
  const d = rollupDayWeather({
    et0: [1, 2, 3],
    precipitation: [0, 1, 0.5],
    precipitationProbability: [10, 80, 30],
  });
  assert.equal(d.et0Mm, 6);
  assert.equal(d.precipMm, 1.5);
  assert.equal(d.precipProbabilityPct, 80);
  assert.equal(d.peakHourEt0Mm, 3);
});

// ---- Trim rules -------------------------------------------------------------

test("rain-skip: precip over threshold → 0 minutes", () => {
  const t = trimZone(zone(), 20, wetDay, {
    globalRainSkipMm: 5,
    rainSkipProbabilityPct: 60,
    deficitMm: 30,
  });
  assert.equal(t.trimmedMin, 0);
  assert.equal(t.rainSkipped, true);
  assert.equal(t.savedMin, 20);
  assert.equal(t.savedPct, 1);
});

test("rain-skip: high probability (even with low precip) → 0 minutes", () => {
  const t = trimZone(
    zone(),
    20,
    { et0Mm: 5, precipMm: 1, precipProbabilityPct: 75, peakHourEt0Mm: 0.5 },
    {
      globalRainSkipMm: 5,
      rainSkipProbabilityPct: 60,
      deficitMm: 30,
    },
  );
  assert.equal(t.trimmedMin, 0);
  assert.equal(t.rainSkipped, true);
});

test("per-zone rainSkipMm overrides the global threshold", () => {
  // global 5 would NOT skip 4mm, but the zone's own 3mm threshold does.
  const t = trimZone(
    zone({ rainSkipMm: 3 }),
    20,
    { et0Mm: 5, precipMm: 4, precipProbabilityPct: 10, peakHourEt0Mm: 0.5 },
    {
      globalRainSkipMm: 5,
      rainSkipProbabilityPct: 60,
      deficitMm: 30,
    },
  );
  assert.equal(t.rainSkipped, true);
});

test("low ET / small deficit trims minutes BELOW the ceiling but never above it", () => {
  // deficit 3mm at 0.5 mm/min ⇒ needs 6 min; ceiling is 20 ⇒ trimmed to 6.
  const t = trimZone(zone({ flowLpm: 10, areaM2: 20 }), 20, dryDay, {
    globalRainSkipMm: 5,
    rainSkipProbabilityPct: 60,
    deficitMm: 3,
  });
  assert.equal(t.trimmedMin, 6);
  assert.ok(t.trimmedMin <= 20, "never exceeds ceiling");
  assert.ok(t.savedPct > 0);
});

test("large deficit does NOT push the run above the scheduled ceiling", () => {
  const t = trimZone(zone({ flowLpm: 10, areaM2: 20 }), 15, dryDay, {
    globalRainSkipMm: 5,
    rainSkipProbabilityPct: 60,
    deficitMm: 999,
  });
  assert.equal(t.trimmedMin, 15); // capped at ceiling
  assert.equal(t.savedMin, 0);
});

test("soil-moisture sensor override suppresses the run when wet", () => {
  const t = trimZone(zone(), 20, dryDay, {
    globalRainSkipMm: 5,
    rainSkipProbabilityPct: 60,
    deficitMm: 30,
    soilMoisturePct: 70,
  });
  assert.equal(t.trimmedMin, 0);
});

test("heat top-up adds minutes back (opted-in, hot day) but never above ceiling", () => {
  const hot: DayWeather = {
    et0Mm: 8,
    precipMm: 0,
    precipProbabilityPct: 5,
    peakHourEt0Mm: 7,
  };
  const base = trimZone(zone({ flowLpm: 10, areaM2: 20 }), 20, hot, {
    globalRainSkipMm: 5,
    rainSkipProbabilityPct: 60,
    deficitMm: 4,
  });
  const topped = trimZone(
    zone({ flowLpm: 10, areaM2: 20, heatTopupEnabled: true }),
    20,
    hot,
    {
      globalRainSkipMm: 5,
      rainSkipProbabilityPct: 60,
      deficitMm: 4,
    },
  );
  assert.ok(topped.trimmedMin >= base.trimmedMin, "top-up >= base");
  assert.ok(topped.trimmedMin <= 20, "never above ceiling");
  if (topped.trimmedMin > base.trimmedMin) assert.equal(topped.heatTopup, true);
});

test("no schedule (0 ceiling) → 0 minutes, savedPct 0", () => {
  const t = trimZone(zone(), 0, dryDay, {
    globalRainSkipMm: 5,
    rainSkipProbabilityPct: 60,
    deficitMm: 5,
  });
  assert.equal(t.trimmedMin, 0);
  assert.equal(t.savedPct, 0);
});

test("daySavedPct is minutes-weighted across zones", () => {
  const pct = daySavedPct([
    {
      zoneId: "a",
      scheduledMin: 10,
      trimmedMin: 0,
      savedMin: 10,
      savedPct: 1,
      rainSkipped: true,
      heatTopup: false,
      reasons: [],
      volumeL: 0,
    },
    {
      zoneId: "b",
      scheduledMin: 10,
      trimmedMin: 10,
      savedMin: 0,
      savedPct: 0,
      rainSkipped: false,
      heatTopup: false,
      reasons: [],
      volumeL: 0,
    },
  ]);
  assert.equal(pct, 0.5);
});

test("advanceDeficit adds ETc, subtracts effective rain + applied, clamps ≥ 0", () => {
  const z = zone({ kc: 1, sunExposure: 1, flowLpm: 10, areaM2: 20 }); // rate 0.5 mm/min
  // start 5mm + ETc(6) - rain(0.8*2=1.6) - applied(10min*0.5=5) = 4.4
  const next = advanceDeficit(z, 5, { et0Mm: 6, precipMm: 2 }, 10);
  assert.ok(Math.abs(next - 4.4) < 1e-9);
  // heavy rain + watering drives it to the 0 floor
  assert.equal(advanceDeficit(z, 1, { et0Mm: 1, precipMm: 100 }, 60), 0);
});

// ---- Coordinator pure helpers ----------------------------------------------

test("crossed fires a scheduled minute that fell in (prev, now] same day", () => {
  const prev = { day: 3, min: 360 }; // 06:00
  const now = { day: 3, min: 365 }; // 06:05
  assert.equal(__test.crossed(prev, now, 3, 362), true); // 06:02 falls in window
  assert.equal(__test.crossed(prev, now, 3, 360), false); // exactly prev edge — not included
  assert.equal(__test.crossed(prev, now, 3, 365), true); // exactly now edge — included
  assert.equal(__test.crossed(prev, now, 2, 362), false); // wrong weekday
});

test("crossed handles the midnight straddle", () => {
  const prev = { day: 3, min: 1438 }; // Wed 23:58
  const now = { day: 4, min: 2 }; // Thu 00:02
  assert.equal(__test.crossed(prev, now, 3, 1439), true); // Wed 23:59 — tail of prev day
  assert.equal(__test.crossed(prev, now, 4, 1), true); // Thu 00:01 — head of new day
});

test("scheduledMinForDay sums only the times that run on that weekday", () => {
  const z = zone({
    wateringTimes: [
      {
        id: "a",
        startTime: "06:00",
        durationMin: 10,
        days: [false, true, false, false, false, false, false],
      },
      {
        id: "b",
        startTime: "20:00",
        durationMin: 15,
        days: [false, true, false, false, false, false, false],
      },
      {
        id: "c",
        startTime: "06:00",
        durationMin: 99,
        days: [true, false, false, false, false, false, false],
      },
    ],
  });
  assert.equal(__test.scheduledMinForDay(z, 1), 25); // Monday: 10 + 15
  assert.equal(__test.scheduledMinForDay(z, 0), 99); // Sunday: just c
  assert.equal(__test.scheduledMinForDay(z, 2), 0); // Tuesday: none
});

test("dueWateringTimes returns the times whose start fell in the tick window", () => {
  const z = zone({
    wateringTimes: [
      {
        id: "a",
        startTime: "06:03",
        durationMin: 10,
        days: [false, false, false, true, false, false, false],
      },
      {
        id: "b",
        startTime: "07:00",
        durationMin: 10,
        days: [false, false, false, true, false, false, false],
      },
    ],
  });
  const due = __test.dueWateringTimes(
    z,
    { day: 3, min: 360 },
    { day: 3, min: 365 },
  );
  assert.deepEqual(
    due.map((w) => w.id),
    ["a"],
  );
});

test("windowFavorable reflects the chosen preference", () => {
  const mk = (window: string) => ({ irrigation: { window } }) as never;
  assert.equal(__test.windowFavorable(mk("solar-surplus"), 500).ok, true);
  assert.equal(__test.windowFavorable(mk("solar-surplus"), 0).ok, false);
  assert.equal(__test.windowFavorable(mk("none"), 0).ok, true);
});

// ---- Coordinator shadow/live gate -------------------------------------------

test("liveAllowed actuates ONLY in mode live AND armed AND devices not off", () => {
  const mk = (mode: string, armed: boolean, devicesMode: string): StoreSchema =>
    ({
      irrigation: { mode },
      devices: { armed, mode: devicesMode },
    }) as unknown as StoreSchema;

  // The one true path: live + armed + a real devices mode.
  assert.equal(liveAllowed(mk("live", true, "auto")), true);

  // SHADOW-FIRST defence: any of the three conditions failing → no actuation.
  assert.equal(liveAllowed(mk("shadow", true, "auto")), false); // not live
  assert.equal(liveAllowed(mk("off", true, "auto")), false); // not live
  assert.equal(liveAllowed(mk("live", false, "auto")), false); // disarmed
  assert.equal(liveAllowed(mk("live", true, "off")), false); // devices layer off
});
