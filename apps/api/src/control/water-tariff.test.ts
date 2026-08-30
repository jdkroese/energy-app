// Unit tests for the water tariff/cost maths (docs/52 P3). Run with:
//   node --import tsx --test src/control/water-tariff.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { costFor, marginalCostFor } from './water-tariff';
import { defaultWaterTariff } from '../store';

const TARIFF = defaultWaterTariff();

test('costFor bills 0 m3 as just the fixed service charge', () => {
  const c = costFor(0, TARIFF);
  assert.equal(c.lines.length, 1);
  assert.equal(c.lines[0].label, 'Fixed service charge');
  assert.equal(c.subtotalEur, TARIFF.fixedEurMonth);
  assert.equal(c.ivaEur, Math.round(TARIFF.fixedEurMonth * (TARIFF.ivaPct / 100) * 100) / 100);
});

test('costFor bills progressively across blocks (10 m3 stays entirely in block 1)', () => {
  const c = costFor(10, TARIFF);
  const b1 = c.lines.find((l) => l.label.startsWith('Block 1'));
  assert.ok(b1);
  assert.equal(b1!.m3, 10);
  assert.equal(c.lines.find((l) => l.label.startsWith('Block 2')), undefined);
});

test('costFor splits consumption across all three blocks when it spans them', () => {
  // block1 upTo=15, block2 upTo=30 -> 40 m3 spans all three blocks.
  const c = costFor(40, TARIFF);
  const b1 = c.lines.find((l) => l.label.startsWith('Block 1'))!;
  const b2 = c.lines.find((l) => l.label.startsWith('Block 2'))!;
  const b3 = c.lines.find((l) => l.label.startsWith('Block 3'))!;
  assert.equal(b1.m3, 15);
  assert.equal(b2.m3, 15); // 30-15
  assert.equal(b3.m3, 10); // 40-30
  // Each block priced at its OWN rate, not the marginal rate applied to everything.
  assert.equal(b1.eur, Math.round(15 * TARIFF.block1.eurM3 * 100) / 100);
  assert.equal(b2.eur, Math.round(15 * TARIFF.block2.eurM3 * 100) / 100);
  assert.equal(b3.eur, Math.round(10 * TARIFF.block3.eurM3 * 100) / 100);
});

test('costFor adds sewerage + canon on the FULL consumption, then applies IVA on the subtotal', () => {
  const c = costFor(20, TARIFF);
  const sewer = c.lines.find((l) => l.label === 'Sewerage')!;
  const canon = c.lines.find((l) => l.label === 'Canon de saneamiento')!;
  assert.equal(sewer.m3, 20);
  assert.equal(canon.m3, 20);
  const rawSubtotal = c.lines.reduce((s, l) => s + l.eur, 0);
  assert.ok(Math.abs(rawSubtotal - c.subtotalEur) < 0.02);
  assert.equal(c.totalEur, Math.round((c.subtotalEur + c.ivaEur) * 100) / 100);
});

test('marginalCostFor prices the NEXT litre at the TOP applicable block', () => {
  // At 5 m3 (inside block 1), the marginal rate is block1's rate + sewer + canon (+IVA).
  const low = marginalCostFor(5, TARIFF);
  const expectedLow = Math.round((TARIFF.block1.eurM3 + TARIFF.sewerEurM3 + TARIFF.canonEurM3) * (1 + TARIFF.ivaPct / 100) * 100) / 100;
  assert.equal(low, expectedLow);

  // At 50 m3 (past block2.upToM3), the marginal rate is block3's (highest) rate.
  const high = marginalCostFor(50, TARIFF);
  const expectedHigh = Math.round((TARIFF.block3.eurM3 + TARIFF.sewerEurM3 + TARIFF.canonEurM3) * (1 + TARIFF.ivaPct / 100) * 100) / 100;
  assert.equal(high, expectedHigh);
  assert.ok(high > low, 'waste at high consumption must cost more per litre than at low consumption');
});
