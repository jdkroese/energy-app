// Unit tests for the Sungrow per-inverter plausibility guard (the fix for the
// physically-impossible ~15.6 kW single-sample production spike). Run with the Node
// built-in test runner via tsx:
//   node --import tsx --test src/connectors/sungrow.test.ts
// (apps/api has no formal test-runner script; tsx is a devDependency.)
//
// These cover the pure guard predicate directly, plus the production-sum arithmetic
// getNormalized() performs (sum of reachable inverters' acPowerW), so a rejected
// sample — whose acPowerW is forced to 0 — cannot inflate the total.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { plausibleAcPowerW } from './sungrow';
import type { InverterNormalized } from './sungrow';

// ---- plausibleAcPowerW (the guard predicate) --------------------------------

test('a normal SG5.0RS reading (3.94 kW) is plausible', () => {
  assert.equal(plausibleAcPowerW(3940), true);
});

test('a reading exactly at the 10% headroom (5.5 kW) is still accepted', () => {
  // rated 5.0 kW × 1.1 = 5.5 kW — the boundary is inclusive.
  assert.equal(plausibleAcPowerW(5500), true);
});

test('a reading just over the ceiling (5.51 kW) is rejected', () => {
  assert.equal(plausibleAcPowerW(5510), false);
});

test('the observed ~15.6 kW spike (per inverter) is rejected', () => {
  assert.equal(plausibleAcPowerW(15600), false);
});

test('NaN / non-finite readings are rejected (never propagate)', () => {
  assert.equal(plausibleAcPowerW(Number.NaN), false);
  assert.equal(plausibleAcPowerW(Number.POSITIVE_INFINITY), false);
});

test('a custom ratedKw shifts the ceiling', () => {
  // A hypothetical 10 kW inverter: 10 × 1.1 = 11 kW ceiling.
  assert.equal(plausibleAcPowerW(10500, 10), true);
  assert.equal(plausibleAcPowerW(11500, 10), false);
});

// ---- production sum excludes a rejected sample ------------------------------
// Mirrors getNormalized(): productionW = Σ reachable inverters' acPowerW. A rejected
// sample is stored with acPowerW=0 (+ powerRejected), so it contributes 0 to the sum.

function inv(p: Partial<InverterNormalized>): InverterNormalized {
  return {
    id: '1.2.3.4',
    name: 'Solar Inverter 1',
    ip: '1.2.3.4',
    model: 'SG5.0RS',
    acPowerW: 0,
    dailyKwh: 0,
    totalKwh: 0,
    tempC: null,
    workState: 'Run',
    reachable: true,
    lastSeen: null,
    faults: [],
    ...p,
  };
}

function productionW(inverters: InverterNormalized[]): number {
  return inverters.reduce((sum, i) => sum + (i.reachable ? i.acPowerW : 0), 0);
}

test('a rejected sample (acPowerW forced to 0) does not inflate the production sum', () => {
  const good = inv({ acPowerW: 3940 });
  // The guard would have set acPowerW=0 + powerRejected=true for the 15.6 kW spike.
  const bad = inv({ id: '5.6.7.8', name: 'Solar Inverter 2', acPowerW: 0, powerRejected: true });
  assert.equal(productionW([good, bad]), 3940);
});

test('two normal readings sum through unchanged', () => {
  const a = inv({ acPowerW: 3940 });
  const b = inv({ id: '5.6.7.8', name: 'Solar Inverter 2', acPowerW: 4100 });
  assert.equal(productionW([a, b]), 8040);
});
