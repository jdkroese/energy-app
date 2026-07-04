// Unit tests for the per-inverter energy-flow split (FIX 2): a local-unreachable but
// cloud-alive inverter (reachable:false, source:'cloud', acPowerW>0) must NOT be drawn as
// dark — its power is already counted in getNormalized().productionW, so the split has to
// stay consistent with it. Run with:
//   node --import tsx --test src/routes/live-solar-split.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isInverterLive, splitSungrowArrays, teslaDedicatedKw } from './live';

// Minimal shape the pure helpers actually read.
type Inv = { name: string; acPowerW: number; reachable: boolean; source?: 'local' | 'cloud' | 'none' };

test('isInverterLive: local-reachable is live', () => {
  assert.equal(isInverterLive({ reachable: true, source: 'local' }), true);
});

test('isInverterLive: cloud-alive (reachable:false, source:cloud) is live', () => {
  assert.equal(isInverterLive({ reachable: false, source: 'cloud' }), true);
});

test('isInverterLive: unreachable with no cloud is NOT live', () => {
  assert.equal(isInverterLive({ reachable: false, source: 'none' }), false);
  assert.equal(isInverterLive({ reachable: false }), false);
});

test('both inverters live locally → both counted, none dark', () => {
  const inv: Inv[] = [
    { name: 'A', acPowerW: 2500, reachable: true, source: 'local' },
    { name: 'B', acPowerW: 3000, reachable: true, source: 'local' },
  ];
  const { arrays, sungrowKw } = splitSungrowArrays(inv);
  assert.equal(sungrowKw, 5.5);
  assert.deepEqual(arrays, [
    { name: 'A', kw: 2.5 },
    { name: 'B', kw: 3 },
  ]);
});

test('cloud-alive inverter is counted (kw from merged acPowerW), NOT dark — the FIX 2 case', () => {
  // A is local-unreachable but the cloud backstop supplies its value.
  const inv: Inv[] = [
    { name: 'A', acPowerW: 2100, reachable: false, source: 'cloud' },
    { name: 'B', acPowerW: 2600, reachable: true, source: 'local' },
  ];
  const { arrays, sungrowKw } = splitSungrowArrays(inv);
  // Both contribute → 2.1 + 2.6 = 4.7 (matches getNormalized().productionW which counts
  // reachable || source==='cloud').
  assert.equal(sungrowKw, 4.7);
  assert.equal(arrays[0].dark, undefined);
  assert.equal(arrays[0].kw, 2.1);
  assert.equal(arrays[1].kw, 2.6);
});

test('genuinely dark inverter (unreachable, no cloud) → kw 0 + dark:true, excluded from sum', () => {
  const inv: Inv[] = [
    { name: 'A', acPowerW: 0, reachable: false, source: 'none' },
    { name: 'B', acPowerW: 2600, reachable: true, source: 'local' },
  ];
  const { arrays, sungrowKw } = splitSungrowArrays(inv);
  assert.equal(sungrowKw, 2.6);
  assert.deepEqual(arrays[0], { name: 'A', kw: 0, dark: true });
  assert.equal(arrays[1].kw, 2.6);
});

// ---- Tesla-array DEDUP (Part A) — the Tesla meter reads TOTAL site solar (Sungrows
// included), so the Tesla TILE must show only the dedicated residual and the three tiles
// must sum EXACTLY to the true total, never double-counting. -----------------------
test('no double-count: sungrow 3.6 + 3.7 with tesla-total 12.8 → Tesla tile 5.5, combined 12.8', () => {
  const inv: Inv[] = [
    { name: 'S1', acPowerW: 3600, reachable: true, source: 'local' },
    { name: 'S2', acPowerW: 3700, reachable: true, source: 'local' },
  ];
  const { sungrowKw } = splitSungrowArrays(inv);
  assert.equal(sungrowKw, 7.3);
  const teslaTotal = 12.8; // Tesla gateway solar_power = whole-site total
  const teslaTile = teslaDedicatedKw(teslaTotal, sungrowKw);
  assert.equal(teslaTile, 5.5); // 12.8 − 7.3
  // Combined = sungrow + dedicated Tesla = the true site total (no 20.1 kW double-count).
  assert.equal(Math.round((sungrowKw + teslaTile) * 100) / 100, 12.8);
});

test('teslaDedicatedKw floors at 0 when a Sungrow sample momentarily exceeds the Tesla meter', () => {
  // A WiNet catch-up spike briefly reads Sungrows higher than the Tesla-meter total.
  assert.equal(teslaDedicatedKw(6.0, 7.3), 0); // never negative
  // Combined then equals the (higher) sungrow value = max(teslaSolar, sungrowKw).
  assert.equal(Math.round((7.3 + teslaDedicatedKw(6.0, 7.3)) * 100) / 100, 7.3);
});

test('teslaDedicatedKw is fail-soft on non-finite inputs', () => {
  assert.equal(teslaDedicatedKw(NaN, 3), 0);
  assert.equal(teslaDedicatedKw(5, NaN), 5);
});

test('sum stays consistent with productionW semantics (reachable || cloud)', () => {
  const inv: Inv[] = [
    { name: 'A', acPowerW: 1234, reachable: false, source: 'cloud' },
    { name: 'B', acPowerW: 0, reachable: false, source: 'none' }, // truly dark
    { name: 'C', acPowerW: 987, reachable: true, source: 'local' },
  ];
  const productionW = inv.reduce(
    (s, i) => s + (i.reachable || i.source === 'cloud' ? i.acPowerW : 0),
    0,
  );
  const { sungrowKw } = splitSungrowArrays(inv);
  // Round productionW/1000 the same way the split rounds for a fair comparison.
  assert.equal(sungrowKw, Math.round((productionW / 1000) * 100) / 100);
});
