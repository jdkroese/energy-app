// Unit tests for the Kitchen Hub deterministic engine (docs/39 acceptance #2 + #3):
// suggestion filling (rotation / allergies / time budget / cuisine variety / pins &
// skips surviving re-suggest) and the pack-size consolidation math (the hand-checked
// "rice 900 g → 1× 1 kg" example). Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/kitchen/engine.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyPlan, ingredientKey, normalizeQty, packMath, suggestWeek, weekStartOf } from './engine';
import { defaultHousehold } from './store';
import type { Household, Recipe } from './types';

const NOW = new Date(2026, 6, 2, 12, 0); // Thu 2026-07-02
const WEEK = weekStartOf(new Date(2026, 6, 6)); // Mon 2026-07-06

function recipe(id: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    id,
    title: id,
    source: 'seed',
    servingsBase: 4,
    prepMin: 10,
    cookMin: 15,
    tags: [],
    cuisine: 'spanish',
    tools: [],
    ingredients: [{ name: 'Rice', es: 'arroz redondo', qty: 300, unit: 'g' }],
    steps: [{ phase: 'cook', text: 'Cook.' }],
    lastCookedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A library big enough to fill a week with variety. */
function library(): Recipe[] {
  return [
    recipe('es-1', { cuisine: 'spanish' }),
    recipe('es-2', { cuisine: 'spanish' }),
    recipe('it-1', { cuisine: 'italian' }),
    recipe('it-2', { cuisine: 'italian' }),
    recipe('jp-1', { cuisine: 'japanese' }),
    recipe('jp-2', { cuisine: 'japanese' }),
    recipe('nl-1', { cuisine: 'dutch' }),
    recipe('gl-1', { cuisine: 'global' }),
    recipe('gl-2', { cuisine: 'global' }),
    recipe('slow-1', { cuisine: 'global', prepMin: 30, cookMin: 60 }), // over the weeknight budget
  ];
}

test('suggest week fills all 7 non-skipped slots with 7 distinct recipes', () => {
  const plan = emptyPlan(WEEK, 4);
  const out = suggestWeek(plan, library(), defaultHousehold(), NOW);
  const ids = out.days.map((d) => d.recipeId).filter(Boolean) as string[];
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, 7, 'no recipe repeats within the week');
});

test('no two consecutive days share a cuisine', () => {
  const out = suggestWeek(emptyPlan(WEEK, 4), library(), defaultHousehold(), NOW);
  const byId = new Map(library().map((r) => [r.id, r]));
  for (let i = 1; i < out.days.length; i++) {
    const a = out.days[i - 1].recipeId ? byId.get(out.days[i - 1].recipeId!)?.cuisine : null;
    const b = out.days[i].recipeId ? byId.get(out.days[i].recipeId!)?.cuisine : null;
    if (a && b) assert.notEqual(a, b, `days ${i - 1}/${i} both ${a}`);
  }
});

test('allergies are a hard filter — never suggested', () => {
  const household: Household = { ...defaultHousehold(), allergies: ['gambas'] };
  const lib = [
    ...library(),
    recipe('allergen', { ingredients: [{ name: 'Prawns', es: 'gambas peladas', qty: 500, unit: 'g' }] }),
  ];
  const out = suggestWeek(emptyPlan(WEEK, 4), lib, household, NOW);
  assert.ok(!out.days.some((d) => d.recipeId === 'allergen'));
});

test('weeknights respect the time budget when quick options exist', () => {
  const lib = library();
  const out = suggestWeek(emptyPlan(WEEK, 4), lib, defaultHousehold(), NOW);
  const byId = new Map(lib.map((r) => [r.id, r]));
  // Mon–Thu are indexes 0..3 of a Monday-start week.
  for (let i = 0; i < 4; i++) {
    const r = byId.get(out.days[i].recipeId!)!;
    assert.ok(r.prepMin + r.cookMin <= 30, `weeknight ${out.days[i].date} got ${r.id} (${r.prepMin + r.cookMin} min)`);
  }
});

test('rotation: a recipe cooked last week scores out; a never-cooked twin wins', () => {
  const recent = recipe('recent', { cuisine: 'global', lastCookedAt: new Date(NOW.getTime() - 5 * 86_400_000).toISOString() });
  const fresh = recipe('fresh', { cuisine: 'global' });
  const plan = emptyPlan(WEEK, 4);
  plan.days = [plan.days[0]]; // single slot → direct head-to-head
  const out = suggestWeek(plan, [recent, fresh], defaultHousehold(), NOW);
  assert.equal(out.days[0].recipeId, 'fresh');
});

test('pins and skips survive re-suggest', () => {
  const plan = emptyPlan(WEEK, 4);
  plan.days[1].recipeId = 'nl-1';
  plan.days[1].pinned = true;
  plan.days[6].skip = true;
  const out = suggestWeek(plan, library(), defaultHousehold(), NOW);
  assert.equal(out.days[1].recipeId, 'nl-1', 'pin survives');
  assert.equal(out.days[1].pinned, true);
  assert.equal(out.days[6].skip, true, 'skip survives');
  assert.equal(out.days[6].recipeId, null, 'skipped day stays empty');
});

test('single-slot re-suggest swaps only that day and avoids the current pick', () => {
  const first = suggestWeek(emptyPlan(WEEK, 4), library(), defaultHousehold(), NOW);
  const before = first.days.map((d) => d.recipeId);
  const target = first.days[2].date;
  const out = suggestWeek(first, library(), defaultHousehold(), NOW, target);
  for (let i = 0; i < 7; i++) {
    if (first.days[i].date === target) assert.notEqual(out.days[i].recipeId, before[i], 'swap changes the slot');
    else assert.equal(out.days[i].recipeId, before[i], `day ${i} untouched`);
  }
});

// ---- Pack math (acceptance #3: rice 900 g across 3 recipes → 1× 1 kg) -------------

test('hand-checked example: 900 g across 3 recipes → one 1 kg pack, covered', () => {
  const res = packMath(900, 'g', 3, { qty: 1, unit: 'kg', display: '1 kg' });
  assert.ok(res);
  assert.equal(res!.packsNeeded, 1);
  assert.equal(res!.coverageNote, '900 g across 3 recipes → 1× 1 kg ✓ (100 g spare)');
});

test('1.3 kg needs 2 packs of 1 kg', () => {
  const res = packMath(1300, 'g', 2, { qty: 1, unit: 'kg', display: '1 kg' });
  assert.equal(res!.packsNeeded, 2);
  assert.match(res!.coverageNote, /2× 1 kg/);
});

test('multipack: 5 l of milk against a 6 x 1 L pack → 1 pack', () => {
  const res = packMath(5, 'l', 1, { qty: 6, unit: 'l', display: '6 x 1 L' });
  assert.equal(res!.packsNeeded, 1);
});

test('incomparable units (count vs g) → null (no fake math)', () => {
  assert.equal(packMath(3, 'count', 2, { qty: 1, unit: 'kg', display: '1 kg' }), null);
});

test('unit normalization: kg→g, l→ml, count synonyms', () => {
  assert.deepEqual(normalizeQty(1.5, 'kg'), { qty: 1500, unit: 'g' });
  assert.deepEqual(normalizeQty(2, 'L'), { qty: 2000, unit: 'ml' });
  assert.deepEqual(normalizeQty(3, 'ud'), { qty: 3, unit: 'count' });
});

test('ingredient keys normalize accents + case (mapping memory stability)', () => {
  assert.equal(ingredientKey({ es: 'Judía Verde Plana' }), 'judia verde plana');
});
