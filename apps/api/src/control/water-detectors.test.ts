// Unit tests for the water observation detectors' PURE conditions (docs/51 P2). Run with:
//   node --import tsx --test src/control/water-detectors.test.ts
//
// The KEY behavioural test is `night-use ignores a watering night`: irrigation
// attribution must suppress the night-use false positive the owner explicitly asked
// for — a night with heavy irrigation must NOT alert, while an equivalent night with
// the SAME total litres but no irrigation attribution DOES.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  continuousFlowCondition,
  nightUseCondition,
  dailySpikeCondition,
  projectMonthM3,
  monthlyBudgetCondition,
  meterSilentCondition,
} from './water-detectors';

// ---- Night use: the key behavioural test ---------------------------------------

test('a watering night does NOT fire night-use once irrigation is subtracted', () => {
  const nightMeasuredL = 6037; // the brief's captured watering-night figure
  const nightAttributedIrrigationL = 5980; // almost all of it was irrigation
  const toleranceL = 60;
  assert.equal(nightUseCondition(nightMeasuredL, nightAttributedIrrigationL, toleranceL), false);
});

test('an EQUIVALENT unattributed night (same total, zero irrigation attribution) DOES fire', () => {
  const nightMeasuredL = 6037; // same total litres as the watering-night case above
  const nightAttributedIrrigationL = 0; // nothing irrigation-attributed
  const toleranceL = 60;
  assert.equal(nightUseCondition(nightMeasuredL, nightAttributedIrrigationL, toleranceL), true);
});

test('night-use residual right at the tolerance boundary does not fire (strict >)', () => {
  assert.equal(nightUseCondition(160, 100, 60), false); // residual exactly 60
  assert.equal(nightUseCondition(161, 100, 60), true); // residual 61
});

test('night-use never goes negative when irrigation attribution exceeds measured litres', () => {
  // A slightly-over-attributed estimate must not manufacture a negative (auto-pass) residual.
  assert.equal(nightUseCondition(100, 150, 10), false);
});

// ---- Continuous flow: edge / persistence behaviour -----------------------------

test('continuous-flow fires only when EVERY trailing hour stayed above the floor', () => {
  const allAbove = [10, 12, 8, 15, 9]; // all > floor 5
  assert.equal(continuousFlowCondition(allAbove, 5), true);
});

test('continuous-flow clears (does not fire) the instant a SINGLE hour drops to/below the floor', () => {
  const oneQuiet = [10, 12, 8, 5, 9]; // one hour AT the floor (not strictly above)
  assert.equal(continuousFlowCondition(oneQuiet, 5), false);
});

test('continuous-flow does not fire on an empty window (no data yet)', () => {
  assert.equal(continuousFlowCondition([], 5), false);
});

test('continuous-flow is sensitive to a genuinely quiet single hour anywhere in the window', () => {
  const quietAtStart = [0, 10, 10, 10];
  const quietAtEnd = [10, 10, 10, 0];
  assert.equal(continuousFlowCondition(quietAtStart, 5), false);
  assert.equal(continuousFlowCondition(quietAtEnd, 5), false);
});

// ---- Daily spike -----------------------------------------------------------------

test('daily-spike fires when unexplained litres exceed factor x the 30-day median', () => {
  assert.equal(dailySpikeCondition(400, 100, 3), true); // 400 > 3*100
  assert.equal(dailySpikeCondition(250, 100, 3), false); // 250 < 300
});

test('daily-spike floors a thin/empty median history so day-1 does not spuriously fire', () => {
  // median=0 (no history yet); with the default 20L floor, only a genuinely large
  // unexplained figure should fire.
  assert.equal(dailySpikeCondition(10, 0, 3, 20), false); // 10 < 3*20
  assert.equal(dailySpikeCondition(100, 0, 3, 20), true); // 100 > 3*20
});

// ---- Monthly budget (projection) -------------------------------------------------

test('projectMonthM3 scales month-to-date evenly across the full month', () => {
  // 40 m3 by day 10 of a 30-day month -> projects to 120 m3.
  assert.equal(projectMonthM3(40_000, 10, 30), 120);
});

test('projectMonthM3 is 0 with no elapsed days (guards div-by-zero)', () => {
  assert.equal(projectMonthM3(0, 0, 30), 0);
});

test('monthlyBudgetCondition fires only once the projection exceeds the budget', () => {
  assert.equal(monthlyBudgetCondition(79, 80), false);
  assert.equal(monthlyBudgetCondition(81, 80), true);
});

// ---- Meter silent -----------------------------------------------------------------

test('meterSilentCondition fires once the gap exceeds the threshold', () => {
  const now = Date.UTC(2026, 7, 30, 12, 0, 0);
  const last = now - 40 * 3600_000; // 40h ago
  assert.equal(meterSilentCondition(last, now, 36), true);
  assert.equal(meterSilentCondition(now - 10 * 3600_000, now, 36), false);
});

test('meterSilentCondition treats "never seen a reading" (null) as silent', () => {
  assert.equal(meterSilentCondition(null, Date.now(), 36), true);
});
