// Unit tests for expensiveImportCondition — the "buying expensive grid while the
// batteries hold energy" watchdog condition (Phase 0). Run with the Node built-in
// test runner via tsx:
//   node --import tsx --test src/monitors-expensive-import.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  expensiveImportCondition,
  idleUsableKwh,
  EXPENSIVE_IMPORT_GRID_KW,
  EXPENSIVE_IMPORT_IDLE_DISCHARGE_KW,
  EXPENSIVE_IMPORT_HEADROOM_PP,
  type ExpensiveImportInputs,
} from './monitors';

/** The 2026-07-02 incident, verbatim: P2 band, 3.7 kW import, Tesla idle at 100%. */
function tonight(overrides: Partial<ExpensiveImportInputs> = {}): ExpensiveImportInputs {
  return {
    band: 'P2',
    gridImportKw: 3.7,
    batteryDischargeKw: 0,
    teslaSoc: 100,
    teslaReservePct: 20,
    sonnenSoc: 0,
    sonnenFloorPct: 10,
    ...overrides,
  };
}

test('fires on the observed incident: P2 import with a full, idle Tesla', () => {
  assert.equal(expensiveImportCondition(tonight()), true);
});

test('fires in P1 too', () => {
  assert.equal(expensiveImportCondition(tonight({ band: 'P1' })), true);
});

test('never fires in the P3 valley (cheap grid is allowed)', () => {
  assert.equal(expensiveImportCondition(tonight({ band: 'P3' })), false);
});

test(`needs a real import (> ${EXPENSIVE_IMPORT_GRID_KW} kW noise floor)`, () => {
  assert.equal(expensiveImportCondition(tonight({ gridImportKw: 0.4 })), false);
  assert.equal(expensiveImportCondition(tonight({ gridImportKw: 0.51 })), true);
});

test(`batteries actually discharging (≥ ${EXPENSIVE_IMPORT_IDLE_DISCHARGE_KW} kW) → not idle, no fire`, () => {
  assert.equal(expensiveImportCondition(tonight({ batteryDischargeKw: 1.2 })), false);
  assert.equal(expensiveImportCondition(tonight({ batteryDischargeKw: 0.29 })), true);
});

test('no usable energy anywhere → no fire (both at/near their floors)', () => {
  const i = tonight({ teslaSoc: 22, teslaReservePct: 20, sonnenSoc: 12, sonnenFloorPct: 10 });
  assert.equal(expensiveImportCondition(i), false);
});

test(`Tesla headroom must clear reserve + ${EXPENSIVE_IMPORT_HEADROOM_PP}pp`, () => {
  const base = { sonnenSoc: 0, sonnenFloorPct: 10 };
  assert.equal(expensiveImportCondition(tonight({ ...base, teslaSoc: 25, teslaReservePct: 20 })), false);
  assert.equal(expensiveImportCondition(tonight({ ...base, teslaSoc: 26, teslaReservePct: 20 })), true);
});

test('Sonnen alone holding energy is enough (Tesla offline)', () => {
  const i = tonight({ teslaSoc: null, teslaReservePct: null, sonnenSoc: 60, sonnenFloorPct: 10 });
  assert.equal(expensiveImportCondition(i), true);
});

test('both batteries offline → no fire (nulls never count as energy)', () => {
  const i = tonight({ teslaSoc: null, teslaReservePct: null, sonnenSoc: null });
  assert.equal(expensiveImportCondition(i), false);
});

test('idleUsableKwh sums the energy above each floor (for the summary line)', () => {
  // Tesla 100% over a 20% reserve = 80% of its usable capacity; Sonnen at 0% adds nothing.
  const kwh = idleUsableKwh(tonight());
  assert.ok(kwh > 0, 'a full Tesla above reserve must count');
  assert.equal(idleUsableKwh(tonight({ teslaSoc: 20, sonnenSoc: 10 })), 0);
});
