// Unit tests for decideDischargeTarget — the Sonnen-first discharge-priority decision.
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/control/coordinator-discharge.test.ts
// (apps/api has no formal test-runner script; tsx is a devDependency.)
//
// Regression: the old drawW = sonnenDischarge + teslaDischarge + gridImport counted the
// Sonnen's OWN discharge as house load, so once it was discharging ~4.6 kW the "draw"
// stayed ~4.6 kW, it force-discharged at max, dumped to the grid, and flip-flopped with
// soak-export every 90 s tick (observed 2026-07-02, live P1 with a 7.7 kW PV surplus).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideDischargeTarget, DISCHARGE_DEADBAND_W } from './coordinator';

test('stands down on a PV surplus (the live runaway case: PV 7670W, load 1190W)', () => {
  const { residualW, standDown } = decideDischargeTarget(7670, 1190);
  assert.equal(standDown, true, 'must not force-discharge while PV covers the load');
  assert.equal(residualW, 0);
});

test('covers a genuine deficit (evening, no PV)', () => {
  const { residualW, standDown } = decideDischargeTarget(0, 3000);
  assert.equal(standDown, false);
  assert.equal(residualW, 3000);
});

test('clamps the target to the real residual — never more than load − PV', () => {
  // load 4000, PV 1000 → residual 3000 (so it can never push the extra to grid).
  const { residualW } = decideDischargeTarget(1000, 4000);
  assert.equal(residualW, 3000);
});

test('deadband: a tiny residual stands down (no flapping near zero)', () => {
  const { standDown } = decideDischargeTarget(1000, 1000 + DISCHARGE_DEADBAND_W - 1);
  assert.equal(standDown, true);
});

test('deadband: a residual clearly over the band engages', () => {
  const { residualW, standDown } = decideDischargeTarget(1000, 1000 + DISCHARGE_DEADBAND_W + 200);
  assert.equal(standDown, false);
  assert.equal(residualW, DISCHARGE_DEADBAND_W + 200);
});

test('self-reference is gone: the Sonnen already discharging does not inflate the target', () => {
  // Regardless of any battery discharge, the decision depends ONLY on load & PV, so it
  // cannot latch. With PV ≥ load it stands down even if the battery is mid-discharge.
  const { standDown } = decideDischargeTarget(2000, 1200);
  assert.equal(standDown, true);
});
