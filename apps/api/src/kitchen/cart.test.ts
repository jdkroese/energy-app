// Unit tests for the P2 cart-fill plan (docs/41 acceptance): the EXACT batched
// flattened payload for a hand-checked draft, and the server-side spend-cap refusal.
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/kitchen/cart.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertRealFillAllowed, assertUnderSpendCap, buildCartPlan, lineQuantity, SpendCapError, wireLines } from './cart';
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

test('an unpriced (obsolete) mapped line is SKIPPED, not sent, and not summed', () => {
  const plan = buildCartPlan([line({ label: 'Café en grano', productId: 'p1', priceEur: null })]);
  assert.deepEqual(wireLines(plan), []); // never reaches the wire payload
  assert.equal(plan.items.length, 0);
  assert.deepEqual(plan.skipped, [{ label: 'Café en grano', reason: 'unpriced' }]);
  assert.equal(plan.unpricedCount, 1); // still counted (informational)
  assert.equal(plan.estimatedCount, 0);
  assert.equal(plan.totalEur, 0);
});

// ---- Last-known-price estimates (flaky-Mercadona) --------------------------------------
// enrich preserves a line's last-known price as an ESTIMATE (priceEst) when the live
// re-check is unavailable. buildCartPlan must count those as estimated (NOT unpriced),
// flag the item, and fold their price into a REAL totalEur (not the 0-sum no-op).

test('estimated lines feed a REAL total; the unpriced line is skipped, not summed', () => {
  const plan = buildCartPlan([
    line({ id: 'a', productId: 'p1', priceEur: 12.5, priceEst: true }),
    line({ id: 'b', productId: 'p2', priceEur: 3.0 }), // live-confirmed
    line({ id: 'c', label: 'Fresón', productId: 'p3', priceEur: null }), // obsolete → skipped
  ]);
  assert.equal(plan.totalEur, 15.5); // 12.50 (estimate) + 3.00 — a REAL total, not 0
  assert.equal(plan.estimatedCount, 1);
  assert.equal(plan.unpricedCount, 1); // the never-priced line, now skipped
  assert.deepEqual(plan.skipped, [{ label: 'Fresón', reason: 'unpriced' }]);
  assert.equal(plan.items.length, 2); // only the two priced products ship
  const est = plan.items.find((it) => it.product_id === 'p1');
  assert.equal(est?.estimated, true);
  const live = plan.items.find((it) => it.product_id === 'p2');
  assert.equal(live?.estimated, undefined);
});

test('an estimated contributor flags a merged item', () => {
  const plan = buildCartPlan([
    line({ id: 'a', productId: 'p1', qty: 2, priceEur: 2, priceEst: true }),
    line({ id: 'b', source: 'manual', productId: 'p1', qty: 1, priceEur: 1 }),
  ]);
  assert.equal(plan.items[0].estimated, true);
  assert.equal(plan.totalEur, 3);
  assert.equal(plan.estimatedCount, 1);
});

test('an estimated-but-under-cap real fill PASSES (the cap judged a real total)', () => {
  const plan = buildCartPlan([
    line({ id: 'a', productId: 'p1', priceEur: 40.0, priceEst: true }),
    line({ id: 'b', productId: 'p2', priceEur: 10.0 }),
  ]);
  assert.equal(plan.totalEur, 50.0);
  assert.equal(plan.unpricedCount, 0);
  assert.doesNotThrow(() => assertRealFillAllowed(plan, 150));
});

test('an estimated total OVER the cap is refused with the cap error', () => {
  const plan = buildCartPlan([line({ productId: 'p1', priceEur: 200.0, priceEst: true })]);
  assert.throws(() => assertRealFillAllowed(plan, 150), SpendCapError);
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

// ---- Unpriced (obsolete) lines are SKIPPED, not refused --------------------------------------
// Genuinely unavailable/obsolete regulars carry no catalog price (priceEur == null) even
// when Mercadona is reachable. Rather than hard-refusing the whole fill (which let a
// handful of dead items block everything), buildCartPlan SKIPS them out of the wire
// payload and totalEur; the real-fill pre-flight now only enforces the spend cap on the
// REAL, priced total. The user resolves the skipped items (swap/remove) in Groceries.

test('a real fill with only unpriced items sends nothing but does NOT refuse', () => {
  const plan = buildCartPlan([
    line({ id: 'a', label: 'Agua con gas Cortes', productId: 'p1', priceEur: null }),
    line({ id: 'b', label: 'Ginebra', productId: 'p2', priceEur: null }),
    line({ id: 'c', label: 'Café en grano', productId: 'p3', priceEur: null }),
  ]);
  assert.equal(plan.items.length, 0); // nothing ships
  assert.equal(plan.totalEur, 0);
  assert.equal(plan.unpricedCount, 3);
  assert.deepEqual(
    plan.skipped.map((s) => s.reason),
    ['unpriced', 'unpriced', 'unpriced'],
  );
  assert.doesNotThrow(() => assertRealFillAllowed(plan, 150)); // no longer blocks
});

test('one unpriced item among priced ones is skipped; the rest fill', () => {
  const plan = buildCartPlan([
    line({ id: 'a', productId: 'p1', priceEur: 12.5 }),
    line({ id: 'b', label: 'Ginebra', productId: 'p2', priceEur: null }),
  ]);
  assert.deepEqual(wireLines(plan), [{ product_id: 'p1', quantity: 1 }]);
  assert.deepEqual(plan.skipped, [{ label: 'Ginebra', reason: 'unpriced' }]);
  assert.equal(plan.totalEur, 12.5);
  assert.doesNotThrow(() => assertRealFillAllowed(plan, 150));
});

test('a fully-priced under-cap plan passes the real-fill pre-flight', () => {
  const plan = buildCartPlan([line({ productId: 'p1', priceEur: 42.0 })]);
  assert.doesNotThrow(() => assertRealFillAllowed(plan, 150));
});

test('the cap still refuses an over-cap priced total (unpriced items skipped)', () => {
  const plan = buildCartPlan([
    line({ id: 'a', productId: 'p1', priceEur: 200.0 }),
    line({ id: 'b', productId: 'p2', priceEur: null }),
  ]);
  assert.throws(() => assertRealFillAllowed(plan, 150), SpendCapError);
});
