// Unit tests for the "what can I make with…" deterministic coverage ranking (P3
// acceptance #4: coverage math + pantry-always-available). Run with the Node built-in
// test runner via tsx:
//   node --import tsx --test src/kitchen/whatcanimake.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanAnswer, rankRecipesByCoverage, termMatchesIngredient } from './whatcanimake';
import type { Recipe, RecipeIngredient } from './types';

function ing(name: string, es: string, pantryStaple = false): RecipeIngredient {
  return pantryStaple ? { name, es, qty: 1, unit: 'count', pantryStaple: true } : { name, es, qty: 1, unit: 'count' };
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

test('term matching: substring-of-name, accents, plural collapse, no false positives', () => {
  const chicken = ing('Chicken thighs, boneless', 'contramuslos de pollo');
  assert.equal(termMatchesIngredient('chicken thighs', chicken), true);
  assert.equal(termMatchesIngredient('chicken', chicken), true);
  assert.equal(termMatchesIngredient('pollo', chicken), true);
  assert.equal(termMatchesIngredient('beef', chicken), false);
  // Accent-insensitive + singular/plural collapse both ways.
  assert.equal(termMatchesIngredient('judias', ing('Flat green beans', 'judía verde plana')), true);
  assert.equal(termMatchesIngredient('tomate', ing('Tomatoes', 'tomates')), true);
  // Multi-word terms need every word to hit — "chicken stock" must not match plain chicken.
  assert.equal(termMatchesIngredient('chicken stock', chicken), false);
});

test('coverage math: have/total counts matched + pantry, missing lists the rest', () => {
  const r = recipe('katsu', [
    ing('Chicken breasts', 'pechuga de pollo'),
    ing('Panko', 'pan rallado panko'),
    ing('Eggs', 'huevos'),
    ing('Rice', 'arroz redondo'),
    ing('Neutral oil', 'aceite de girasol', true), // pantry
  ]);
  const [top] = rankRecipesByCoverage([r], ['chicken', 'rice', 'eggs']);
  assert.ok(top);
  assert.equal(top.total, 5);
  assert.equal(top.have, 4); // chicken + rice + eggs + pantry oil
  assert.equal(top.matchedFresh, 3);
  assert.deepEqual(top.missing, ['Panko']);
});

test('pantry staples count as always available but never carry a match alone', () => {
  const pantryOnly = recipe('pantry-only', [ing('Olive oil', 'aceite de oliva', true), ing('Salt', 'sal', true)]);
  const mixed = recipe('mixed', [ing('Courgette', 'calabacín'), ing('Olive oil', 'aceite de oliva', true)]);
  // On-hand list matches nothing fresh in pantry-only → excluded even though have=total.
  assert.deepEqual(rankRecipesByCoverage([pantryOnly], ['courgette']), []);
  const [top] = rankRecipesByCoverage([mixed], ['courgette']);
  assert.equal(top.recipeId, 'mixed');
  assert.equal(top.have, 2); // courgette matched + pantry oil free
  assert.equal(top.missing.length, 0);
});

test('ranking: higher coverage first, deterministic tie-break by id', () => {
  const full = recipe('b-full', [ing('Chicken', 'pollo'), ing('Rice', 'arroz')]);
  const half = recipe('a-half', [ing('Chicken', 'pollo'), ing('Cream', 'nata'), ing('Mushrooms', 'champiñones'), ing('Pasta', 'pasta')]);
  const twin = recipe('a-full', [ing('Chicken', 'pollo'), ing('Rice', 'arroz')]);
  const out = rankRecipesByCoverage([half, full, twin], ['chicken', 'rice']);
  assert.deepEqual(
    out.map((x) => x.recipeId),
    ['a-full', 'b-full', 'a-half'], // 100% before 25%; equal scores fall back to id order
  );
});

test('empty/blank input ranks nothing; limit caps the list', () => {
  const lib = Array.from({ length: 12 }, (_, i) => recipe(`r${String(i).padStart(2, '0')}`, [ing('Rice', 'arroz')]));
  assert.deepEqual(rankRecipesByCoverage(lib, []), []);
  assert.deepEqual(rankRecipesByCoverage(lib, ['   ']), []);
  assert.equal(rankRecipesByCoverage(lib, ['rice']).length, 8);
  assert.equal(rankRecipesByCoverage(lib, ['rice'], 3).length, 3);
});

// ---- cleanAnswer (AI free-form answer boundary) --------------------------------------

test('cleanAnswer: keeps only real library ids, dedups, caps at 5', () => {
  const lib = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => recipe(id, [ing('Rice', 'arroz')]));
  const out = cleanAnswer({ libraryIds: ['a', 'b', 'b', 'zzz', 'c', 'd', 'e', 'f'], ideas: [] }, lib);
  // 'b' de-duped, 'zzz' dropped (not in library), capped to 5 real ids in order.
  assert.deepEqual(out.libraryIds, ['a', 'b', 'c', 'd', 'e']);
});

test('cleanAnswer: clamps ideas to 4, trims + length-caps title/note, drops title-less', () => {
  const out = cleanAnswer(
    {
      libraryIds: [],
      ideas: [
        { title: '  Veggie-dough pizza  ', note: '  Blend cauliflower, bake a base, top light.  ' },
        { title: 'x'.repeat(200), note: 'y'.repeat(400) },
        { note: 'no title — dropped' },
        { title: 'B' },
        { title: 'C' },
        { title: 'D' },
        { title: 'E — over the cap' },
      ],
    },
    [],
  );
  assert.equal(out.ideas.length, 4);
  assert.equal(out.ideas[0].title, 'Veggie-dough pizza');
  assert.equal(out.ideas[0].note, 'Blend cauliflower, bake a base, top light.');
  assert.equal(out.ideas[1].title.length, 80);
  assert.equal(out.ideas[1].note.length, 240);
  assert.deepEqual(out.ideas.map((i) => i.title.slice(0, 1)), ['V', 'x', 'B', 'C']);
});

test('cleanAnswer: tolerates null/garbage input → empty arrays', () => {
  assert.deepEqual(cleanAnswer(null, []), { libraryIds: [], ideas: [] });
  assert.deepEqual(cleanAnswer({ libraryIds: 'nope', ideas: 42 } as never, []), { libraryIds: [], ideas: [] });
  // The veggie-pizza case: no library fits, answer lives entirely in ideas.
  const out = cleanAnswer({ ideas: [{ title: 'Cauliflower-crust pizza', note: 'Rice the cauli, bind with egg, bake.' }] }, []);
  assert.equal(out.libraryIds.length, 0);
  assert.equal(out.ideas.length, 1);
});
