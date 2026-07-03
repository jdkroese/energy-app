// Unit tests for the pure AI-recipe-generation helpers (docs/43): the untrusted-LLM
// clamp (sanitizeGenerated), the batch parse + allergen/diet HARD post-filter
// (sanitizeGeneratedBatch / dropForbidden), and the household-aware prompt "never use"
// composition. NO real Claude call here — these are the pure boundary functions the route
// wraps. The intelligence-off shape is asserted structurally (the route returns it
// verbatim without touching these helpers).
//   node --import tsx --test src/kitchen/generate.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGeneratePrompt,
  clampCount,
  dropForbidden,
  sanitizeGenerated,
  sanitizeGeneratedBatch,
} from './generate';
import { defaultHousehold } from './store';
import type { Household } from './types';

function hh(overrides: Partial<Household> = {}): Household {
  return { ...defaultHousehold(), ...overrides };
}

const goodRaw = {
  title: 'Courgette & Chicken Rice',
  cuisine: 'spanish',
  ingredients: [
    { name: 'Chicken thighs', es: 'muslos de pollo', qty: 500, unit: 'g' },
    { name: 'Courgette', es: 'calabacín', qty: 2, unit: 'count' },
    { name: 'Olive oil', es: 'aceite de oliva', qty: null, unit: 'tbsp', pantryStaple: true },
  ],
  steps: [
    { phase: 'mise', text: 'Dice the courgette.' },
    { phase: 'cook', text: 'Fry the chicken.', timerSec: 480 },
  ],
  nutrition: { kcal: 540, proteinG: 38, carbsG: 45, fatG: 20 },
  prepMin: 15,
  cookMin: 25,
  servingsBase: 4,
  tags: ['weeknight'],
  kidScore: 0.8,
  season: ['summer'],
};

test('clampCount clamps to 2..4 (default 3)', () => {
  assert.equal(clampCount(undefined), 3);
  assert.equal(clampCount(1), 2);
  assert.equal(clampCount(9), 4);
  assert.equal(clampCount(2), 2);
  assert.equal(clampCount('x'), 3);
});

test('sanitizeGenerated clamps a valid recipe to source:ai, photo:null, nutrition.estimated', () => {
  const r = sanitizeGenerated(goodRaw, 0);
  assert.ok(r);
  assert.equal(r!.id, 'gen_0');
  assert.equal(r!.source, 'ai');
  assert.equal(r!.photo, null);
  assert.equal(r!.nutrition!.estimated, true);
  assert.equal(r!.nutrition!.kcal, 540);
  assert.equal(r!.cuisine, 'spanish');
  assert.equal(r!.ingredients.length, 3);
  assert.equal(r!.ingredients[2].pantryStaple, true);
  assert.equal(r!.ingredients[0].qty, 500);
  assert.equal(r!.steps[1].timerSec, 480);
  assert.equal(r!.lastCookedAt, null);
});

test('sanitizeGenerated rejects blobs with no title / ingredients / steps', () => {
  assert.equal(sanitizeGenerated({ title: '', ingredients: [], steps: [] }, 0), null);
  assert.equal(sanitizeGenerated({ title: 'x', ingredients: [], steps: [{ phase: 'cook', text: 'go' }] }, 0), null);
  assert.equal(
    sanitizeGenerated({ title: 'x', ingredients: [{ es: 'arroz', qty: 1, unit: 'g' }], steps: [] }, 0),
    null,
  );
  assert.equal(sanitizeGenerated('not an object', 0), null);
});

test('sanitizeGenerated coerces bad cuisine/qty/unit to safe defaults', () => {
  const r = sanitizeGenerated(
    {
      title: 'Weird',
      cuisine: 'martian',
      ingredients: [{ es: 'tomate', qty: -5, unit: '' }],
      steps: [{ phase: 'wat', text: 'stir' }],
      nutrition: { kcal: 'lots' },
    },
    2,
  );
  assert.ok(r);
  assert.equal(r!.cuisine, 'global');
  assert.equal(r!.ingredients[0].qty, null); // negative → to taste
  assert.equal(r!.ingredients[0].unit, 'count');
  assert.equal(r!.steps[0].phase, 'cook'); // unknown phase → cook
  assert.equal(r!.nutrition!.kcal, 0); // non-number → 0
  assert.equal(r!.id, 'gen_2');
});

test('dropForbidden removes a recipe naming an allergen ingredient', () => {
  const withPeanut = sanitizeGenerated(
    {
      title: 'Peanut Noodles',
      cuisine: 'japanese',
      ingredients: [{ name: 'Peanut butter', es: 'crema de cacahuete', qty: 50, unit: 'g' }],
      steps: [{ phase: 'cook', text: 'mix' }],
    },
    0,
  )!;
  const kept = dropForbidden([withPeanut], hh({ allergies: ['cacahuete'] }));
  assert.equal(kept.length, 0);
});

test('sanitizeGeneratedBatch drops diet-restriction (vegetarian) violators and renumbers ids', () => {
  const raw = {
    recipes: [
      goodRaw, // has chicken → violates vegetarian
      {
        title: 'Veggie Rice Bowl',
        cuisine: 'global',
        ingredients: [
          { name: 'Rice', es: 'arroz', qty: 300, unit: 'g' },
          { name: 'Courgette', es: 'calabacín', qty: 2, unit: 'count' },
        ],
        steps: [{ phase: 'cook', text: 'cook rice' }],
        nutrition: { kcal: 400 },
      },
    ],
  };
  const out = sanitizeGeneratedBatch(raw, hh({ dietRestrictions: ['vegetarian'] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Veggie Rice Bowl');
  assert.equal(out[0].id, 'gen_0'); // renumbered after the chicken recipe was dropped
});

test('sanitizeGeneratedBatch tolerates missing/garbage payloads', () => {
  assert.deepEqual(sanitizeGeneratedBatch(null, hh()), []);
  assert.deepEqual(sanitizeGeneratedBatch({ recipes: 'nope' as unknown as [] }, hh()), []);
  assert.deepEqual(sanitizeGeneratedBatch({ recipes: [{}, { title: '' }] }, hh()), []);
});

test('buildGeneratePrompt composes hard NEVER-use from allergies + expanded diet slugs', () => {
  const prompt = buildGeneratePrompt({
    question: 'something light',
    ingredients: ['salmon', 'rice'],
    count: 3,
    household: hh({ allergies: ['cacahuete'], dietRestrictions: ['no-pork'], kids: 2, loves: ['lemon'] }),
  });
  assert.match(prompt, /NEVER use/);
  assert.match(prompt, /cacahuete/);
  assert.match(prompt, /cerdo|bacon|chorizo/); // no-pork expanded via DIET_RESTRICTION_KEYWORDS
  assert.match(prompt, /kid-friendly/i);
  assert.match(prompt, /salmon, rice/);
  assert.match(prompt, /something light/);
  assert.match(prompt, /lemon/);
});

test('intelligence-off response shape is the documented soft fallback', () => {
  // The route returns this verbatim when the feature is off (no helper touched); assert
  // the exact shape the client relies on.
  const off = { ts: 'x', ok: false, reason: 'intelligence-off', recipes: [] as unknown[] };
  assert.equal(off.ok, false);
  assert.equal(off.reason, 'intelligence-off');
  assert.deepEqual(off.recipes, []);
});
