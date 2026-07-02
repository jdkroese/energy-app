// Unit tests for the P2 interactive smart suggestions (docs/41 §3 + acceptance):
// each deterministic kind (pack / merge / cadence), the Confirm apply mutations, and
// the (kind, subject) suppression memory — ignored twice → permanently suppressed.
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/kitchen/suggestions.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySuggestion,
  bestBiggerPack,
  buildSuggestions,
  cadenceSuggestions,
  isMuted,
  mergeSuggestions,
  MUTE_LIMIT,
  muteKey,
  typicalIntervalDays,
} from './suggestions';
import type { MercadonaProduct } from '../connectors/mercadona';
import type { OrderDraft, OrderHistoryEntry, OrderLine, StaplesItem } from './types';

const NOW = new Date('2026-07-02T12:00:00Z');

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: overrides.id ?? `line-${Math.random().toString(36).slice(2, 7)}`,
    source: 'recipe',
    ingredientKey: 'arroz',
    label: 'Arroz',
    qty: 900,
    unit: 'g',
    checked: true,
    ...overrides,
  };
}

function draft(lines: OrderLine[], suggestions: OrderDraft['suggestions'] = []): OrderDraft {
  return { lines, suggestions, status: 'draft', totalEur: 0, updatedAt: NOW.toISOString() };
}

function product(overrides: Partial<MercadonaProduct> = {}): MercadonaProduct {
  return {
    id: 'p-big',
    name: 'Arroz redondo 5 kg',
    photo: null,
    unitPrice: 6.5,
    packSizeDisplay: '5 kg',
    packSize: { qty: 5, unit: 'kg' },
    referencePrice: null,
    ...overrides,
  };
}

// ---- (a) bigger-pack savings --------------------------------------------------------

test('bestBiggerPack finds a cheaper larger pack in the same unit', () => {
  // Need 2.7 kg, mapped to a 1 kg pack → 3 packs × 2.60 € = 7.80 €.
  const l = line({ qty: 2700, unit: 'g', productId: 'p-small', packsNeeded: 3, priceEur: 7.8 });
  const best = bestBiggerPack(l, [product()]); // 5 kg → 1 pack × 6.50 €
  assert.ok(best);
  assert.equal(best.product.id, 'p-big');
  assert.equal(best.packs, 1);
  assert.equal(best.savingEur, 1.3);
});

test('bestBiggerPack refuses mixed units and same/smaller packs', () => {
  const l = line({ qty: 2700, unit: 'g', productId: 'p-small', packsNeeded: 3, priceEur: 7.8 });
  // A liquid product can't cover a weight need.
  assert.equal(bestBiggerPack(l, [product({ packSize: { qty: 5, unit: 'l' } })]), null);
  // Same pack count as today (still 3 packs) is not a "bigger pack".
  assert.equal(bestBiggerPack(l, [product({ packSize: { qty: 1, unit: 'kg' }, unitPrice: 2.0 })]), null);
});

test('bestBiggerPack demands a real saving (≥ 0.25 €)', () => {
  const l = line({ qty: 2700, unit: 'g', productId: 'p-small', packsNeeded: 3, priceEur: 7.8 });
  assert.equal(bestBiggerPack(l, [product({ unitPrice: 7.7 })]), null); // 0.10 € — noise
});

test('buildSuggestions emits a pack suggestion with a switch-product apply', async () => {
  const l = line({ id: 'l1', qty: 2700, unit: 'g', productId: 'p-small', packsNeeded: 3, priceEur: 7.8 });
  const out = await buildSuggestions({
    draft: draft([l]),
    staples: [],
    history: [],
    mutes: {},
    now: NOW,
    search: async () => [product()],
  });
  const pack = out.find((s) => s.kind === 'pack');
  assert.ok(pack);
  assert.equal(pack.state, 'open');
  assert.equal(pack.subject, 'arroz');
  assert.deepEqual(pack.apply, {
    action: 'switch-product',
    lineId: 'l1',
    productId: 'p-big',
    productName: 'Arroz redondo 5 kg',
    packsNeeded: 1,
  });
});

// ---- (b) merge duplicates ------------------------------------------------------------

test('two lines mapped to the same product suggest a merge', () => {
  const a = line({ id: 'a', productId: 'p1', label: 'Perejil fresco', ingredientKey: 'perejil', qty: 1, unit: 'count' });
  const b = line({ id: 'b', source: 'manual', productId: 'p1', label: 'Perejil', ingredientKey: 'perejil manual', qty: 1, unit: 'count' });
  const out = mergeSuggestions({ draft: draft([a, b]), mutes: {} });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'merge');
  // The recipe line wins as the keeper.
  assert.deepEqual(out[0].apply, { action: 'merge-lines', keepLineId: 'a', dropLineId: 'b' });
});

test('singular/plural ingredient keys merge too; unrelated lines do not', () => {
  const a = line({ id: 'a', ingredientKey: 'tomate', label: 'Tomate', productId: null });
  const b = line({ id: 'b', source: 'manual', ingredientKey: 'tomates', label: 'Tomates', productId: null });
  const c = line({ id: 'c', ingredientKey: 'cebolla', label: 'Cebolla', productId: null });
  const out = mergeSuggestions({ draft: draft([a, b, c]), mutes: {} });
  assert.equal(out.length, 1);
  assert.equal(out[0].apply?.action, 'merge-lines');
});

test('applySuggestion merge adds quantities (same unit) and drops the duplicate', () => {
  const a = line({ id: 'a', qty: 300, unit: 'g' });
  const b = line({ id: 'b', qty: 0.2, unit: 'kg' });
  const d = draft([a, b]);
  const ok = applySuggestion(d, {
    id: 's',
    kind: 'merge',
    text: '',
    state: 'open',
    subject: 'x',
    apply: { action: 'merge-lines', keepLineId: 'a', dropLineId: 'b' },
  });
  assert.equal(ok, true);
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].qty, 500); // 300 g + 0.2 kg → 500 g
  assert.equal(d.lines[0].unit, 'g');
});

test('applySuggestion merge with incomparable units flags the kept line', () => {
  const a = line({ id: 'a', qty: 2, unit: 'count' });
  const b = line({ id: 'b', qty: 100, unit: 'g' });
  const d = draft([a, b]);
  applySuggestion(d, {
    id: 's',
    kind: 'merge',
    text: '',
    state: 'open',
    apply: { action: 'merge-lines', keepLineId: 'a', dropLineId: 'b' },
  });
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].incomparable, true);
});

// ---- (c) cadence nudge -----------------------------------------------------------------

function staple(overrides: Partial<StaplesItem> = {}): StaplesItem {
  return { id: 'st1', name: 'Dishwasher tablets', defaultQty: 1, cadence: 'monthly', lastOrderedAt: null, ...overrides };
}

function historyAt(daysAgo: number, stapleId = 'st1'): OrderHistoryEntry {
  const date = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
  return {
    id: `h${daysAgo}`,
    date,
    lines: [line({ source: 'staple', ingredientKey: `staple:${stapleId}`, label: 'Tablets' })],
    totalEur: 10,
  };
}

test('typicalIntervalDays uses the median history gap, else the configured cadence', () => {
  const s = staple();
  // Gaps: 28, 30, 26 days → median 28.
  const history = [historyAt(84), historyAt(56), historyAt(26), historyAt(0)];
  assert.equal(typicalIntervalDays(s, history), 28);
  assert.equal(typicalIntervalDays(s, []), 30); // monthly fallback
});

test('cadence nudge fires when the interval lapsed and the line sits unchecked', () => {
  const s = staple({ lastOrderedAt: new Date(NOW.getTime() - 40 * 86_400_000).toISOString() });
  const l = line({ id: 'sl', source: 'staple', ingredientKey: 'staple:st1', label: 'Tablets', checked: false });
  const out = cadenceSuggestions({ draft: draft([l]), staples: [s], history: [], mutes: {}, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'cadence');
  assert.deepEqual(out[0].apply, { action: 'check-line', lineId: 'sl' });
  // Confirm checks the line.
  const d = draft([l]);
  applySuggestion(d, out[0]);
  assert.equal(d.lines[0].checked, true);
});

test('no cadence nudge inside the grace window or when already checked', () => {
  const recent = staple({ lastOrderedAt: new Date(NOW.getTime() - 20 * 86_400_000).toISOString() });
  const l = line({ id: 'sl', source: 'staple', ingredientKey: 'staple:st1', checked: false });
  assert.equal(cadenceSuggestions({ draft: draft([l]), staples: [recent], history: [], mutes: {}, now: NOW }).length, 0);
  const overdue = staple({ lastOrderedAt: new Date(NOW.getTime() - 40 * 86_400_000).toISOString() });
  const checked = line({ id: 'sl', source: 'staple', ingredientKey: 'staple:st1', checked: true });
  assert.equal(cadenceSuggestions({ draft: draft([checked]), staples: [overdue], history: [], mutes: {}, now: NOW }).length, 0);
});

// ---- Suppression: ignored twice for the same (kind, subject) → never again ---------------

test('isMuted flips at exactly MUTE_LIMIT ignores', () => {
  assert.equal(MUTE_LIMIT, 2);
  assert.equal(isMuted({}, 'cadence', 'st1'), false);
  assert.equal(isMuted({ [muteKey('cadence', 'st1')]: 1 }, 'cadence', 'st1'), false);
  assert.equal(isMuted({ [muteKey('cadence', 'st1')]: 2 }, 'cadence', 'st1'), true);
});

test('a muted (kind, subject) never regenerates; other kinds are unaffected', async () => {
  const s = staple({ lastOrderedAt: new Date(NOW.getTime() - 40 * 86_400_000).toISOString() });
  const l = line({ id: 'sl', source: 'staple', ingredientKey: 'staple:st1', checked: false });
  const ctx = { draft: draft([l]), staples: [s], history: [], now: NOW };
  const before = await buildSuggestions({ ...ctx, mutes: { [muteKey('cadence', 'st1')]: 1 } });
  assert.equal(before.filter((x) => x.kind === 'cadence').length, 1); // one ignore → still suggested
  const after = await buildSuggestions({ ...ctx, mutes: { [muteKey('cadence', 'st1')]: 2 } });
  assert.equal(after.filter((x) => x.kind === 'cadence').length, 0); // two ignores → suppressed
});

test('an ignored-in-this-draft suggestion keeps its ignored state on rebuild (no re-nag)', async () => {
  const s = staple({ lastOrderedAt: new Date(NOW.getTime() - 40 * 86_400_000).toISOString() });
  const l = line({ id: 'sl', source: 'staple', ingredientKey: 'staple:st1', checked: false });
  const first = await buildSuggestions({ draft: draft([l]), staples: [s], history: [], mutes: {}, now: NOW });
  first[0].state = 'ignored';
  const rebuilt = await buildSuggestions({ draft: draft([l], first), staples: [s], history: [], mutes: { [muteKey('cadence', 'st1')]: 1 } , now: NOW });
  assert.equal(rebuilt[0].state, 'ignored');
  assert.equal(rebuilt[0].id, first[0].id);
});
