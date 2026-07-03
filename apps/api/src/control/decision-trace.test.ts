// Unit tests for the decision trace (Phase 0): ring persistence, stance-change diffing,
// and the fail-soft guarantee. Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/control/decision-trace.test.ts

// Isolate persistence to a throwaway file so the test never touches the dev .data/state.json
// (same pattern as climate-coordinator.test.ts).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.STATE_FILE = join(mkdtempSync(join(tmpdir(), 'energy-dt-test-')), 'state.json');

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../store';
import { beginDecision, recordTesla, recordSonnen, recordStandDown, commitDecision, _resetDecisionTrace } from './decision-trace';
import type { RichSnapshot } from './snapshot';

/** Minimal snapshot for the trace (only the fields beginDecision reads). */
function snap(over: Partial<RichSnapshot> = {}): RichSnapshot {
  return {
    ageMs: 0,
    band: 'P2',
    sonnenSoc: 40,
    teslaSoc: 90,
    teslaReservePct: 20,
    gridImportKw: 1.2,
    gridExportKw: 0,
    scenario: store.DEFAULT_SCENARIOS.balanced,
    sonnen: null,
    tesla: null,
    ...over,
  } as RichSnapshot;
}

function lastRecord() {
  const ring = store.get().control.decisionTrace;
  return ring[ring.length - 1];
}

test('commit pushes one record with the recorded winners + stand-downs', () => {
  _resetDecisionTrace();
  store.update((s) => {
    s.control.decisionTrace = [];
  });

  beginDecision(snap(), 'auto');
  recordTesla('self_consumption', 'self-consumption — Tesla discharges for the house');
  recordSonnen('self-consumption', 'self-consumption', 'cover the house load');
  recordStandDown('tariff-arbitrage', 'disabled');
  recordStandDown('tariff-arbitrage', 'duplicate must be de-duped');
  commitDecision();

  const rec = lastRecord();
  assert.equal(rec.tesla.mode.value, 'self_consumption');
  assert.equal(rec.sonnen.branch, 'self-consumption');
  assert.equal(rec.band, 'P2');
  assert.equal(rec.inputs.gridSource, 'none'); // both device views null in this snapshot
  assert.equal(rec.stoodDown.filter((s) => s.rule === 'tariff-arbitrage').length, 1);
  assert.deepEqual(rec.changed, []); // first record after reset — no previous to diff
});

test('a stance change is flagged in `changed`; a steady tick is not', () => {
  beginDecision(snap(), 'auto');
  recordTesla('backup', 'discharge-priority hold (Tesla backup-only, Sonnen discharges first)');
  recordSonnen('discharge-priority', 'manual discharge 1800W', 'covers the house residual');
  commitDecision();
  assert.deepEqual(lastRecord().changed, ['tesla.mode', 'sonnen']);

  beginDecision(snap(), 'auto');
  recordTesla('backup', 'discharge-priority hold (Tesla backup-only, Sonnen discharges first)');
  recordSonnen('discharge-priority', 'manual discharge 1750W', 'covers the house residual');
  commitDecision();
  assert.deepEqual(lastRecord().changed, []); // same stance, different wattage — no change
});

test('the ring is capped at DECISION_TRACE_RING_MAX', () => {
  for (let i = 0; i < store.DECISION_TRACE_RING_MAX + 20; i++) {
    beginDecision(snap(), 'auto');
    recordTesla('self_consumption', 'r');
    recordSonnen('self-consumption', 'self-consumption', 'r');
    commitDecision();
  }
  assert.equal(store.get().control.decisionTrace.length, store.DECISION_TRACE_RING_MAX);
});

test('fail-soft: record/commit without begin are safe no-ops', () => {
  _resetDecisionTrace();
  const before = store.get().control.decisionTrace.length;
  assert.doesNotThrow(() => {
    recordTesla('backup', 'x');
    recordSonnen('a', 'b', 'c');
    recordStandDown('r', 'x');
    commitDecision();
  });
  assert.equal(store.get().control.decisionTrace.length, before);
});
