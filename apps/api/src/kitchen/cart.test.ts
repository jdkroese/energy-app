// Unit tests for the P2 cart-fill plan (docs/41 acceptance): the EXACT batched
// flattened payload for a hand-checked draft, and the server-side spend-cap refusal.
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/kitchen/cart.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertUnderSpendCap, buildCartPlan, lineQuantity, SpendCapError, wireLines } from './cart';
import type { OrderLine } from './types';

function line(overrides: Partial<OrderLine>): OrderLine {
  return {
    id: overrides.id ?? 'l',
    source: 'recipe',
    ingredientKey: 'x',
    label: 'X',
    qty: 1,
    unit: 'count',
    checked: true,
    ...overrides,
  };
}

// ---- Hand-checked draft → exact payload -----------------------------------------------
// Draft: rice 2.7 kg → 3× 1 kg (4506, 2.60 €/pack), milk staple 6 × 1.05 €, olive oil
// "to taste" mapped (60101), an unmapped checked line and an unchecked line.

const HAND_CHECKED: OrderLine[] = [
  line({ id: 'l1', label: 'Arroz', qty: 2700, unit: 'g', productId: '4506', packsNeeded: 3, priceEur: 7.8 }),
  line({ id: 'l2', source: 'staple', label: 'Leche entera', ingredientKey: 'staple:milk', productId: '68923', qty: 6, priceEur: 6.3 }),
  line({ id: 'l3', label: 'Aceite de oliva', ingredientKey: 'aceite', productId: '60101', qty: 0, unit: 'to taste', priceEur: 3.15 }),
  line({ id: 'l4', label: 'Azafrán', ingredientKey: 'azafran', productId: null }),
  line({ id: 'l5', label: 'Pan', productId: '111', checked: false, priceEur: 1.0 }),
];

test('buildCartPlan produces the exact flattened batched payload', () => {
  const plan = buildCartPlan(HAND_CHECKED);
  // Hand-checked expectation:
  //  - 4506 × 3 (packsNeeded wins over the gram qty)
  //  - 68923 × 6 (count line orders that many units)
  //  - 60101 × 1 ("to taste" falls back to one unit)
  //  - l4 skipped (unmapped), l5 excluded (unchecked)
  assert.deepEqual(wireLines(plan), [
    { product_id: '4506', quantity: 3 },
    { product_id: '68923', quantity: 6 },
    { product_id: '60101', quantity: 1 },
  ]);
  assert.deepEqual(plan.skipped, [{ label: 'Azafrán', reason: 'unmapped' }]);
  assert.equal(plan.totalEur, 17.25); // 7.80 + 6.30 + 3.15
  assert.equal(plan.unpricedCount, 0);
});

test('duplicate product ids merge into one batched line', () => {
  const plan = buildCartPlan([
    line({ id: 'a', productId: 'p1', qty: 2, priceEur: 2 }),
    line({ id: 'b', source: 'manual', productId: 'p1', qty: 1, priceEur: 1 }),
  ]);
  assert.deepEqual(wireLines(plan), [{ product_id: 'p1', quantity: 3 }]);
  assert.equal(plan.totalEur, 3);
});

test('lineQuantity: packsNeeded > count qty > 1-unit fallback', () => {
  assert.equal(lineQuantity(line({ packsNeeded: 4, qty: 900, unit: 'g' })), 4);
  assert.equal(lineQuantity(line({ qty: 6, unit: 'count' })), 6);
  assert.equal(lineQuantity(line({ qty: 750, unit: 'g' })), 1); // no pack math → one unit
  assert.equal(lineQuantity(line({ qty: 0, unit: 'to taste' })), 1);
});

test('unpriced lines are counted (the cap cannot see them)', () => {
  const plan = buildCartPlan([line({ productId: 'p1', priceEur: null })]);
  assert.equal(plan.unpricedCount, 1);
  assert.equal(plan.totalEur, 0);
});

// ---- Spend cap ---------------------------------------------------------------------------

test('a fill over the spend cap is refused with a readable error', () => {
  const plan = buildCartPlan([line({ productId: 'p1', priceEur: 151.0 })]);
  assert.throws(() => assertUnderSpendCap(plan, 150), SpendCapError);
  try {
    assertUnderSpendCap(plan, 150);
  } catch (e) {
    assert.match((e as Error).message, /151\.00 € is over the 150 € spend cap/);
  }
});

test('a fill at exactly the cap passes; the default cap is 150', () => {
  const plan = buildCartPlan([line({ productId: 'p1', priceEur: 150.0 })]);
  assert.doesNotThrow(() => assertUnderSpendCap(plan, 150));
});
