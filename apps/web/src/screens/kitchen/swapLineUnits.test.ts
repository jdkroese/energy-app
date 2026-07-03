// Unit tests for the obsolete-item resolver order-line helpers (docs/43). isUnavailable
// flags the mapped-but-priceless (obsolete) lines; swapLineUnits mirrors the server's
// cart.lineQuantity so a swapped-in line prices the same way a fresh enrich would
// (unit price × units). Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/screens/kitchen/swapLineUnits.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isUnavailable, swapLineUnits } from './orderLines';
import type { OrderLine } from '../../lib/types';

function line(overrides: Partial<OrderLine>): OrderLine {
  return {
    id: 'l',
    source: 'regular',
    ingredientKey: 'x',
    label: 'X',
    qty: 1,
    unit: 'count',
    checked: true,
    productId: 'p1',
    ...overrides,
  };
}

// ---- isUnavailable -----------------------------------------------------------------------

test('isUnavailable: checked + mapped + no price + not estimate = unavailable', () => {
  assert.equal(isUnavailable(line({ priceEur: null })), true);
});

test('isUnavailable: a priced line is available', () => {
  assert.equal(isUnavailable(line({ priceEur: 2.5 })), false);
});

test('isUnavailable: a preserved estimate is NOT unavailable (it keeps a price)', () => {
  assert.equal(isUnavailable(line({ priceEur: null, priceEst: true })), false);
});

test('isUnavailable: an unmapped line is not "unavailable" (it is unmapped)', () => {
  assert.equal(isUnavailable(line({ productId: null, priceEur: null })), false);
});

test('isUnavailable: an unchecked line is never flagged', () => {
  assert.equal(isUnavailable(line({ checked: false, priceEur: null })), false);
});

// ---- swapLineUnits -----------------------------------------------------------------------

test('swapLineUnits: packsNeeded wins over the raw qty', () => {
  assert.equal(swapLineUnits({ packsNeeded: 3, unit: 'g', qty: 2700 }), 3);
});

test('swapLineUnits: a count line orders that many units', () => {
  assert.equal(swapLineUnits({ unit: 'count', qty: 6 }), 6);
});

test('swapLineUnits: weight/volume without pack math falls back to one unit', () => {
  assert.equal(swapLineUnits({ unit: 'g', qty: 750 }), 1);
});

test('swapLineUnits: "to taste" falls back to one unit', () => {
  assert.equal(swapLineUnits({ unit: 'to taste', qty: 0 }), 1);
});

// The line price the swap handler computes: unit price × units, rounded to cents.
test('swap price = unit price × units (rounded to cents) — matches regulars pricing', () => {
  const units = swapLineUnits({ unit: 'count', qty: 6 });
  const priceEur = Math.round(1.05 * units * 100) / 100;
  assert.equal(priceEur, 6.3);
});
