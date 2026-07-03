// Unit tests for the "What can I make with…" ingredient palette (P3, docs/42): frequency
// ranking + dedup by normalised key + curated fallback blend. Run with the Node built-in
// test runner via tsx:
//   node --import tsx --test src/screens/kitchen/ingredientPalette.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPalette, normalizeIngredientText } from './ingredientPalette';
import type { Recipe, RecipeIngredient } from '../../lib/types';

function ing(name: string, es: string): RecipeIngredient {
  return { name, es, qty: 1, unit: 'count' };
}

function recipe(id: string, ingredients: RecipeIngredient[]): Recipe {
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
    ingredients,
    steps: [{ phase: 'cook', text: 'Cook.' }],
    lastCookedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('normalizeIngredientText: lower-cases + strips accents', () => {
  assert.equal(normalizeIngredientText('  Calabacín '), 'calabacin');
  assert.equal(normalizeIngredientText('JamÓn'), 'jamon');
});

test('buildPalette: library ingredients ranked most-frequent first, deduped by key', () => {
  const lib = [
    recipe('r1', [ing('Chicken', 'pollo'), ing('Rice', 'arroz')]),
    recipe('r2', [ing('Chicken', 'pollo'), ing('Courgette', 'calabacín')]),
    recipe('r3', [ing('Chicken', 'pollo')]),
  ];
  const palette = buildPalette(lib);
  const proteins = palette.filter((p) => p.section === 'Proteins').map((p) => p.label);
  // Chicken (×3) should lead the Proteins section ahead of any curated protein.
  assert.equal(proteins[0], 'Chicken');
  // Deduped: only one Chicken entry despite 3 occurrences.
  assert.equal(palette.filter((p) => p.key === 'pollo').length, 1);
});

test('buildPalette: curated fallback fills sections when the library is thin', () => {
  const palette = buildPalette([]);
  const sections = new Set(palette.map((p) => p.section));
  // All five sections seeded from the curated list even with no recipes.
  assert.ok(sections.has('Vegetables'));
  assert.ok(sections.has('Proteins'));
  assert.ok(sections.has('Carbs & grains'));
  assert.ok(sections.has('Dairy & eggs'));
  assert.ok(sections.has('Pantry'));
  assert.ok(palette.some((p) => p.label === 'Onion'));
});

test('buildPalette: a curated item already in the library is not duplicated', () => {
  const lib = [recipe('r1', [ing('Onion', 'cebolla'), ing('Onion', 'cebolla')])];
  const palette = buildPalette(lib);
  // "Onion"/cebolla present once (library entry wins; curated "Onion" keyed the same).
  // Curated "Onion" normalises to "onion" while the library keys by es ("cebolla"), so
  // guard against BOTH surfacing as the same displayed vegetable duplicate.
  const onions = palette.filter((p) => p.label.toLowerCase() === 'onion');
  assert.equal(onions.length, 1);
});

test('buildPalette: per-section cap keeps the palette scannable', () => {
  const veg = Array.from({ length: 20 }, (_, i) => ing(`Veg${i}`, `verdura${i}`));
  const palette = buildPalette([recipe('r1', veg)], 8);
  assert.ok(palette.filter((p) => p.section === 'Vegetables').length <= 8);
});
