// Tests for the "my regulars" browser mapping (docs/43 — decoupled from staples).
// The live myregulars endpoint returns WRAPPER rows { product, recommended_quantity, … };
// mapRegulars must unwrap .product before normalizing, carry the quantity, and flag rows
// whose product is already on the order draft (`inDraft`).
// Run: node --import tsx --test src/kitchen/regulars.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampQty, mapRegulars } from './regulars';

// A minimal slice of a real myregulars wrapper row.
function row(id: string, name: string, unitPrice: string, recommended_quantity?: unknown) {
  return {
    product: { id, display_name: name, price_instructions: { unit_price: unitPrice } },
    source: 'x',
    selling_method: 0,
    ...(recommended_quantity === undefined ? {} : { recommended_quantity }),
  };
}

test('mapRegulars unwraps .product and yields real id/name (the imported-0 fix)', () => {
  const out = mapRegulars([row('10505', 'Leche semidesnatada Asturiana', '10.74', 4)], new Set());
  assert.equal(out.length, 1, 'wrapper row must not be filtered out');
  assert.equal(out[0].id, '10505');
  assert.equal(out[0].name, 'Leche semidesnatada Asturiana');
  assert.equal(out[0].unitPrice, 10.74);
  assert.equal(out[0].recommendedQty, 4);
  assert.equal(out[0].inDraft, false);
});

test('mapRegulars flags products already on the order draft as inDraft', () => {
  const out = mapRegulars([row('10505', 'Leche', '1.00', 1)], new Set(['10505']));
  assert.equal(out[0].inDraft, true);
});

test('mapRegulars marks only the draft products inDraft (mixed set)', () => {
  const rows = [row('a', 'A', '1.00', 1), row('b', 'B', '1.00', 1), row('c', 'C', '1.00', 1)];
  const out = mapRegulars(rows, new Set(['b']));
  assert.deepEqual(
    out.map((p) => [p.id, p.inDraft]),
    [
      ['a', false],
      ['b', true],
      ['c', false],
    ],
  );
});

test('mapRegulars tolerates a flat product row (no wrapper)', () => {
  const flat = { id: '999', display_name: 'Pan', price_instructions: { unit_price: '0.85' }, recommended_quantity: 2 };
  const out = mapRegulars([flat], new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '999');
  assert.equal(out[0].name, 'Pan');
  // recommended_quantity read from the flat row too.
  assert.equal(out[0].recommendedQty, 2);
});

test('mapRegulars defaults/clamps odd recommended quantities', () => {
  const rows = [
    row('a', 'A', '1.00'), //           missing → 1
    row('b', 'B', '1.00', 0), //        below range → 1
    row('c', 'C', '1.00', 3.9), //      float → floored 3
    row('d', 'D', '1.00', 250), //      above range → 99
    row('e', 'E', '1.00', 'nope'), //   non-numeric → 1
    row('f', 'F', '1.00', '6'), //      numeric string → 6
  ];
  const out = mapRegulars(rows, new Set());
  assert.deepEqual(
    out.map((p) => p.recommendedQty),
    [1, 1, 3, 99, 1, 6],
  );
});

test('mapRegulars drops rows with no usable product id/name', () => {
  const bad = { product: { price_instructions: { unit_price: '1.00' } } }; // no id/display_name
  const good = row('7', 'Good', '2.00', 1);
  const out = mapRegulars([bad, good], new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '7');
});

test('clampQty: default 1, floor, and 1..99 clamp', () => {
  assert.equal(clampQty(undefined), 1);
  assert.equal(clampQty(null), 1);
  assert.equal(clampQty(0), 1);
  assert.equal(clampQty(-5), 1);
  assert.equal(clampQty(2.7), 2);
  assert.equal(clampQty(100), 99);
  assert.equal(clampQty('8'), 8);
  assert.equal(clampQty('abc'), 1);
});
