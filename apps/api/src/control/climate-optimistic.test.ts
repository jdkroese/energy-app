// Unit tests for the server-side climate optimistic overlay — run with the Node
// built-in test runner via tsx:
//   node --import tsx --test src/control/climate-optimistic.test.ts
// (apps/api has no formal test-runner script; tsx is a devDependency.)

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { recordWrite, clearWrite, applyOptimistic, _reset } from './climate-optimistic';
import type { ClimateUnit } from '../connectors/intesis';

function unit(p: Partial<ClimateUnit> = {}): ClimateUnit {
  return {
    id: 'ac-1',
    name: 'Kitchen 1',
    power: false,
    mode: 'cool',
    setpointC: 24,
    currentTempC: 25,
    minSetpointC: 16,
    maxSetpointC: 30,
    online: true,
    ...p,
  } as ClimateUnit;
}

test('overlays a just-written value while the real read still lags', () => {
  _reset();
  recordWrite('ac-1', 'power', true);
  const [u] = applyOptimistic([unit({ power: false })]); // cache still shows off
  assert.equal(u.power, true, 'read reflects the written value immediately');
});

test('reconciles and stops overlaying once the real read catches up', () => {
  _reset();
  recordWrite('ac-1', 'power', true);
  // First read matches the written value → entry is dropped as reconciled…
  const [a] = applyOptimistic([unit({ power: true })]);
  assert.equal(a.power, true);
  // …so a later genuine change to off is no longer masked.
  const [b] = applyOptimistic([unit({ power: false })]);
  assert.equal(b.power, false, 'overlay does not stick after reconciliation');
});

test('setpoint and mode overlays carry the written value', () => {
  _reset();
  recordWrite('ac-1', 'setpoint', 21);
  recordWrite('ac-1', 'mode', 'heat');
  const [u] = applyOptimistic([unit({ setpointC: 24, mode: 'cool' })]);
  assert.equal(u.setpointC, 21);
  assert.equal(u.mode, 'heat');
});

test('clearWrite removes a pending overlay (e.g. rejected command)', () => {
  _reset();
  recordWrite('ac-1', 'power', true);
  clearWrite('ac-1', 'power');
  const [u] = applyOptimistic([unit({ power: false })]);
  assert.equal(u.power, false, 'cleared overlay is not applied');
});

test('only the targeted device is overlaid', () => {
  _reset();
  recordWrite('ac-1', 'power', true);
  const out = applyOptimistic([unit({ id: 'ac-1', power: false }), unit({ id: 'ac-2', power: false })]);
  assert.equal(out[0].power, true);
  assert.equal(out[1].power, false, 'other devices are untouched');
});

test('an overlay expires after the TTL and stops masking the real value', () => {
  _reset();
  mock.timers.enable({ apis: ['Date'] });
  try {
    recordWrite('ac-1', 'power', true);
    mock.timers.tick(61_000); // past the 60s TTL
    const [u] = applyOptimistic([unit({ power: false })]);
    assert.equal(u.power, false, 'stale optimistic value self-heals after TTL');
  } finally {
    mock.timers.reset();
  }
});
