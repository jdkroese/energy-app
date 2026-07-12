// Unit tests for the Kitchen Hub deterministic engine (docs/39 acceptance #2 + #3):
// suggestion filling (rotation / allergies / time budget / cuisine variety / pins &
// skips surviving re-suggest) and the pack-size consolidation math (the hand-checked
// "rice 900 g → 1× 1 kg" example). Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/kitchen/engine.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emptyPlan,
  ingredientKey,
  isFishRecipe,
  isVeggieRecipe,
  normalizeQty,
  packMath,
  rankPlanRequestCandidates,
  ratingAvg,
  scoreRecipe,
  suggestWeek,
  vegRichness,
  weeklyMixCounts,
  weeklyMixTarget,
  weekStartOf,
} from './engine';
import { defaultHousehold, defaultNutritionScales, get as getKitchenData } from './store';
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

test('swap cycles onward through candidates, then wraps to the first again', () => {
  // 4 identically-scored recipes → deterministic id-ordered rotation.
  const lib = [
    recipe('r-a', { cuisine: 'global' }),
    recipe('r-b', { cuisine: 'global' }),
    recipe('r-c', { cuisine: 'global' }),
    recipe('r-d', { cuisine: 'global' }),
  ];
  let plan = emptyPlan(WEEK, 4);
  plan.days = [plan.days[0]]; // single slot
  plan.days[0].recipeId = 'r-a';
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    plan = suggestWeek(plan, lib, defaultHousehold(), NOW, plan.days[0].date);
    seen.push(plan.days[0].recipeId!);
  }
  assert.deepEqual(seen.slice(0, 3), ['r-b', 'r-c', 'r-d'], 'three swaps give three distinct new recipes (no A↔B ping-pong)');
  assert.equal(seen[3], 'r-a', 'once the pool is exhausted the rotation clears and wraps to the first');
});

test('swap never goes dead: 2-recipe library keeps alternating', () => {
  const lib = [recipe('only-a', { cuisine: 'global' }), recipe('only-b', { cuisine: 'global' })];
  let plan = emptyPlan(WEEK, 4);
  plan.days = [plan.days[0]];
  plan.days[0].recipeId = 'only-a';
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    plan = suggestWeek(plan, lib, defaultHousehold(), NOW, plan.days[0].date);
    seen.push(plan.days[0].recipeId!);
  }
  assert.deepEqual(seen, ['only-b', 'only-a', 'only-b', 'only-a'], 'always lands on the other recipe');
});

test('regenerating a fully-planned unpinned week yields a different assignment; pins + skips untouched', () => {
  const lib = library();
  const first = suggestWeek(emptyPlan(WEEK, 4), lib, defaultHousehold(), NOW);
  first.days[1].pinned = true;
  first.days[6].skip = true;
  first.days[6].recipeId = null;
  const before = first.days.map((d) => d.recipeId);
  const out = suggestWeek(first, lib, defaultHousehold(), NOW);
  assert.equal(out.days[1].recipeId, before[1], 'pinned day untouched');
  assert.equal(out.days[1].pinned, true);
  assert.equal(out.days[6].skip, true, 'skip survives');
  assert.equal(out.days[6].recipeId, null, 'skipped day stays empty');
  for (let i = 0; i < out.days.length; i++) {
    const d = out.days[i];
    if (d.pinned || d.skip) continue;
    assert.notEqual(d.recipeId, before[i], `day ${i} visibly re-dealt`);
    assert.ok(d.recipeId, `day ${i} not left empty (graceful degrade beats empty days)`);
  }
});

test('full-week regenerate clears per-day swap memory; manual reuse still avoided softly', () => {
  const lib = library();
  const plan = suggestWeek(emptyPlan(WEEK, 4), lib, defaultHousehold(), NOW);
  plan.days[0].recentSwapIds = ['es-1', 'es-2'];
  const out = suggestWeek(plan, lib, defaultHousehold(), NOW);
  assert.equal(out.days[0].recentSwapIds, undefined, 'a full re-deal resets the Swap rotation');
});

test('diet restrictions are a hard filter — preset slug and free text', () => {
  const household: Household = { ...defaultHousehold(), dietRestrictions: ['no-pork', 'coriander'] };
  const lib = [
    ...library(),
    recipe('porky', { cuisine: 'global', ingredients: [{ name: 'Pork loin', es: 'lomo de cerdo', qty: 500, unit: 'g' }] }),
    recipe('herby', { cuisine: 'global', ingredients: [{ name: 'Coriander chicken', es: 'pollo con cilantro', qty: 400, unit: 'g' }] }),
  ];
  const out = suggestWeek(emptyPlan(WEEK, 4), lib, household, NOW);
  assert.ok(!out.days.some((d) => d.recipeId === 'porky'), 'preset slug (no-pork → cerdo/lomo/…) filters hard');
  assert.ok(!out.days.some((d) => d.recipeId === 'herby'), 'free-text restriction behaves exactly like an allergy');
});

test('allergies still hard-filter alongside diet restrictions', () => {
  const household: Household = { ...defaultHousehold(), dietRestrictions: ['no-beef'], allergies: ['gambas'] };
  const lib = [
    ...library(),
    recipe('allergen', { cuisine: 'global', ingredients: [{ name: 'Prawns', es: 'gambas peladas', qty: 500, unit: 'g' }] }),
    recipe('beefy', { cuisine: 'global', ingredients: [{ name: 'Beef stew', es: 'estofado de ternera', qty: 600, unit: 'g' }] }),
  ];
  const out = suggestWeek(emptyPlan(WEEK, 4), lib, household, NOW);
  assert.ok(!out.days.some((d) => d.recipeId === 'allergen'));
  assert.ok(!out.days.some((d) => d.recipeId === 'beefy'));
});

test('old kitchen.json without dietRestrictions / recentSwapIds still loads (store defaults)', () => {
  // Point the store at a legacy-shaped file BEFORE its lazy first load (this is the
  // only test that touches the store's persistence, so the module cache is cold).
  const dir = mkdtempSync(join(tmpdir(), 'kitchen-engine-test-'));
  const file = join(dir, 'kitchen.json');
  writeFileSync(
    file,
    JSON.stringify({
      recipes: [],
      household: {
        adults: 3,
        kids: 1,
        allergies: ['gambas'],
        dislikes: [],
        loves: [],
        weeknightMaxMin: 30,
        cuisineWeights: { spanish: 80 },
        goals: { mode: null, kcalPerDinner: null },
        showNutritionOnCards: true,
      },
      plans: {
        '2026-07-06': { weekStart: '2026-07-06', days: [{ date: '2026-07-06', recipeId: 'x', servings: 4 }] },
      },
      seededAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  );
  process.env.KITCHEN_FILE = file;
  const data = getKitchenData();
  assert.equal(data.household.adults, 3);
  assert.deepEqual(data.household.dietRestrictions, [], 'legacy household hydrates with an empty dietRestrictions');
  const day = data.plans['2026-07-06'].days[0];
  assert.equal(day.recipeId, 'x');
  assert.equal(day.recentSwapIds, undefined, 'legacy plan days parse without recentSwapIds');
  // And the hydrated data drives the engine without blowing up.
  const out = suggestWeek(data.plans['2026-07-06'], [], data.household, NOW, '2026-07-06');
  assert.equal(out.days.length, 1);
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

test('cooked feedback (P3): 👍 boosts and 👎 penalises the score a little (±6)', () => {
  assert.equal(ratingAvg({ ratings: {} }), 0);
  assert.equal(ratingAvg({ ratings: { a: 1, b: -1 } }), 0);
  assert.equal(ratingAvg({ ratings: { a: 1, b: 1 } }), 1);
  const ctx = { household: defaultHousehold(), date: WEEK, prevCuisine: null, usedThisWeek: new Set<string>(), now: NOW };
  const base = scoreRecipe(recipe('plain'), ctx);
  const loved = scoreRecipe(recipe('loved', { ratings: { '2026-06-01': 1 } }), ctx);
  const hated = scoreRecipe(recipe('hated', { ratings: { '2026-06-01': -1 } }), ctx);
  assert.equal(loved - base, 6);
  assert.equal(base - hated, 6);
});

// ==== docs/46 — dietary guardrail scales + seasonal/boost prefs + per-day picker ==========

function withScale(patch: Partial<Household['nutritionScales']>, extra: Partial<Household> = {}): Household {
  return { ...defaultHousehold(), nutritionScales: { ...defaultNutritionScales(), ...patch }, ...extra };
}

function ctxFor(household: Household, date = WEEK): Parameters<typeof scoreRecipe>[1] {
  return { household, date, prevCuisine: null, usedThisWeek: new Set<string>(), now: NOW };
}

// ---- Classification helpers ---------------------------------------------------------

test('isFishRecipe: fish/seafood ingredient (ES or EN) matches; a meat-only recipe does not', () => {
  const fish = recipe('fish', { ingredients: [{ name: 'Salmon fillet', es: 'salmón', qty: 200, unit: 'g' }] });
  const meat = recipe('meat', { ingredients: [{ name: 'Chicken breast', es: 'pollo', qty: 200, unit: 'g' }] });
  assert.equal(isFishRecipe(fish), true);
  assert.equal(isFishRecipe(meat), false);
});

test('isVeggieRecipe: no meat AND no fish; either present disqualifies it', () => {
  const veggie = recipe('veg', { ingredients: [{ name: 'Tomato', es: 'tomate', qty: 200, unit: 'g' }] });
  const meat = recipe('meat', { ingredients: [{ name: 'Chicken breast', es: 'pollo', qty: 200, unit: 'g' }] });
  const fish = recipe('fish', { ingredients: [{ name: 'Salmon fillet', es: 'salmón', qty: 200, unit: 'g' }] });
  assert.equal(isVeggieRecipe(veggie), true);
  assert.equal(isVeggieRecipe(meat), false);
  assert.equal(isVeggieRecipe(fish), false);
});

test('vegRichness: 0..1 share of produce ingredients', () => {
  const allProduce = recipe('p', {
    ingredients: [
      { name: 'Tomato', es: 'tomate', qty: 200, unit: 'g' },
      { name: 'Zucchini', es: 'calabacín', qty: 150, unit: 'g' },
    ],
  });
  const halfProduce = recipe('h', {
    ingredients: [
      { name: 'Tomato', es: 'tomate', qty: 200, unit: 'g' },
      { name: 'Chicken breast', es: 'pollo', qty: 200, unit: 'g' },
    ],
  });
  const noProduce = recipe('n', { ingredients: [{ name: 'Chicken breast', es: 'pollo', qty: 200, unit: 'g' }] });
  assert.equal(vegRichness(allProduce), 1);
  assert.equal(vegRichness(halfProduce), 0.5);
  assert.equal(vegRichness(noProduce), 0);
  assert.equal(vegRichness(recipe('empty', { ingredients: [] })), 0, 'no ingredients never divides by zero');
});

// ---- Per-recipe scale bias direction ------------------------------------------------

test('calories bias: a light recipe scores best under a light-calorie household, worst under a hearty one', () => {
  const light = recipe('light', { nutrition: { kcal: 450, proteinG: 20, carbsG: 40, fatG: 10, estimated: false } });
  const lowScore = scoreRecipe(light, ctxFor(withScale({ calories: 1 })));
  const highScore = scoreRecipe(light, ctxFor(withScale({ calories: 10 })));
  assert.ok(lowScore > highScore, 'a 450 kcal recipe should score higher when the household wants light dinners');
  assert.equal(lowScore - highScore, 10, 'calories bias caps at ±10 — a 450 kcal gap (target 450 vs 900) saturates it');
});

test('carbs bias: low-carb scale penalizes a high-carb recipe; carb-happy scale rewards it', () => {
  const carby = recipe('carby', { nutrition: { kcal: 600, proteinG: 20, carbsG: 100, fatG: 10, estimated: false } });
  const lowCarbHH = scoreRecipe(carby, ctxFor(withScale({ carbs: 2 })));
  const carbHappyHH = scoreRecipe(carby, ctxFor(withScale({ carbs: 9 })));
  assert.ok(carbHappyHH > lowCarbHH, 'a 100 g-carb recipe scores better under a carb-happy household');
});

test('protein bias: high-protein scale boosts a high-protein recipe; low scale never penalizes protein', () => {
  const proteiny = recipe('proteiny', { nutrition: { kcal: 600, proteinG: 60, carbsG: 40, fatG: 15, estimated: false } });
  const lean = recipe('lean', { nutrition: { kcal: 600, proteinG: 5, carbsG: 40, fatG: 15, estimated: false } });
  const proteinFocusHH = withScale({ protein: 9 });
  const indifferentHH = withScale({ protein: 2 });
  assert.ok(
    scoreRecipe(proteiny, ctxFor(proteinFocusHH)) > scoreRecipe(lean, ctxFor(proteinFocusHH)),
    'protein-focused household prefers the high-protein recipe',
  );
  assert.equal(
    scoreRecipe(proteiny, ctxFor(indifferentHH)),
    scoreRecipe(lean, ctxFor(indifferentHH)),
    'scale <=5 is protein-indifferent — never penalizes the lean recipe',
  );
});

test('fish bias: "avoid fish" penalizes a fish recipe; "fish-forward" boosts it; non-fish unaffected', () => {
  const fish = recipe('fish', { ingredients: [{ name: 'Salmon fillet', es: 'salmón', qty: 200, unit: 'g' }] });
  const meat = recipe('meat', { ingredients: [{ name: 'Chicken breast', es: 'pollo', qty: 200, unit: 'g' }] });
  const avoidHH = withScale({ fish: 1 });
  const forwardHH = withScale({ fish: 10 });
  assert.ok(scoreRecipe(fish, ctxFor(avoidHH)) < scoreRecipe(fish, ctxFor(forwardHH)), 'fish recipe scores much better under fish-forward');
  assert.equal(
    scoreRecipe(meat, ctxFor(avoidHH)),
    scoreRecipe(meat, ctxFor(forwardHH)),
    'the fish scale never touches a non-fish recipe\'s score',
  );
});

test('veg bias: veg-forward scale boosts a produce-rich recipe and penalizes a meat-forward one, and vice versa', () => {
  const veggie = recipe('veggie', {
    ingredients: [
      { name: 'Tomato', es: 'tomate', qty: 200, unit: 'g' },
      { name: 'Zucchini', es: 'calabacín', qty: 150, unit: 'g' },
    ],
  });
  const meaty = recipe('meaty', { ingredients: [{ name: 'Beef', es: 'ternera', qty: 300, unit: 'g' }] });
  const vegForwardHH = withScale({ veg: 9 });
  const meatForwardHH = withScale({ veg: 1 });
  assert.ok(scoreRecipe(veggie, ctxFor(vegForwardHH)) > scoreRecipe(veggie, ctxFor(meatForwardHH)), 'produce-rich recipe prefers veg-forward');
  assert.ok(scoreRecipe(meaty, ctxFor(meatForwardHH)) > scoreRecipe(meaty, ctxFor(vegForwardHH)), 'meat-forward recipe prefers a meat-forward household');
});

// ---- Weekly fish/veggie mix targets (suggestWeek) -------------------------------------

test('weeklyMixTarget bands (docs/46 §1b: 1–2→0 · 3–4→1 · 5–6→1–2 · 7–8→2–3 · 9–10→3–4)', () => {
  assert.equal(weeklyMixTarget(1), 0);
  assert.equal(weeklyMixTarget(2), 0);
  assert.equal(weeklyMixTarget(3), 1);
  assert.equal(weeklyMixTarget(4), 1);
  assert.equal(weeklyMixTarget(5), 1.5);
  assert.equal(weeklyMixTarget(6), 1.5);
  assert.equal(weeklyMixTarget(7), 2.5);
  assert.equal(weeklyMixTarget(8), 2.5);
  assert.equal(weeklyMixTarget(9), 3.5);
  assert.equal(weeklyMixTarget(10), 3.5);
});

/** Library with plenty of distinct fish AND meat options, one shared cuisine (isolates the
 *  fish/veggie weekly-mix bias from the cuisine-variety and rotation factors). */
function fishVsMeatLibrary(): Recipe[] {
  const fish = (id: string) => recipe(id, { cuisine: 'global', ingredients: [{ name: 'Salmon fillet', es: 'salmón', qty: 200, unit: 'g' }] });
  const meat = (id: string) => recipe(id, { cuisine: 'global', ingredients: [{ name: 'Chicken breast', es: 'pollo', qty: 200, unit: 'g' }] });
  return [1, 2, 3, 4, 5, 6, 7].flatMap((n) => [fish(`f${n}`), meat(`m${n}`)]);
}

test('fish-forward household (9–10) fills the week with 3–4 fish dinners, never all 7', () => {
  const household = withScale({ fish: 9 }, { seasonalLocal: false });
  const out = suggestWeek(emptyPlan(WEEK, 4), fishVsMeatLibrary(), household, NOW);
  const { fish } = weeklyMixCounts(out, fishVsMeatLibrary());
  assert.ok(fish >= 3 && fish <= 4, `expected 3–4 fish dinners, got ${fish}`);
});

test('"avoid fish" household (1–2) fills the week with zero fish dinners when meat alternatives exist', () => {
  const household = withScale({ fish: 1 }, { seasonalLocal: false });
  const out = suggestWeek(emptyPlan(WEEK, 4), fishVsMeatLibrary(), household, NOW);
  const { fish } = weeklyMixCounts(out, fishVsMeatLibrary());
  assert.equal(fish, 0);
});

/** Same shape for the veg axis: produce-rich veggie recipes vs a meat-forward alternative. */
function veggieVsMeatLibrary(): Recipe[] {
  const veggie = (id: string) =>
    recipe(id, {
      cuisine: 'global',
      ingredients: [
        { name: 'Tomato', es: 'tomate', qty: 200, unit: 'g' },
        { name: 'Zucchini', es: 'calabacín', qty: 150, unit: 'g' },
      ],
    });
  const meat = (id: string) => recipe(id, { cuisine: 'global', ingredients: [{ name: 'Beef', es: 'ternera', qty: 300, unit: 'g' }] });
  return [1, 2, 3, 4, 5, 6, 7].flatMap((n) => [veggie(`v${n}`), meat(`m${n}`)]);
}

test('veg-forward household (9–10) fills the week with 3–4 full-veggie dinners', () => {
  const household = withScale({ veg: 9 }, { seasonalLocal: false });
  const out = suggestWeek(emptyPlan(WEEK, 4), veggieVsMeatLibrary(), household, NOW);
  const { veg } = weeklyMixCounts(out, veggieVsMeatLibrary());
  assert.ok(veg >= 3 && veg <= 4, `expected 3–4 veggie dinners, got ${veg}`);
});

test('meat-forward household (1–2) fills the week with zero full-veggie dinners when meat alternatives exist', () => {
  const household = withScale({ veg: 1 }, { seasonalLocal: false });
  const out = suggestWeek(emptyPlan(WEEK, 4), veggieVsMeatLibrary(), household, NOW);
  const { veg } = weeklyMixCounts(out, veggieVsMeatLibrary());
  assert.equal(veg, 0);
});

test('single-day re-suggest uses the WEEK\'s current counts (a pinned fish dinner counts toward the target)', () => {
  const household = withScale({ fish: 9 }, { seasonalLocal: false }); // target 3.5
  let plan = emptyPlan(WEEK, 4);
  // Pin 4 fish dinners by hand — the target (3.5, i.e. "up to 4") is already met.
  const lib = fishVsMeatLibrary();
  const fishIds = lib.filter((r) => isFishRecipe(r)).map((r) => r.id).slice(0, 4);
  fishIds.forEach((id, i) => {
    plan.days[i].recipeId = id;
    plan.days[i].pinned = true;
  });
  // Re-suggest the 5th day only — with 4 fish already pinned, it should NOT pick another fish.
  plan = suggestWeek(plan, lib, household, NOW, plan.days[4].date);
  const picked = lib.find((r) => r.id === plan.days[4].recipeId);
  assert.ok(picked && !isFishRecipe(picked), 'the target is already met from pins, so the 5th day goes to meat');
});

// ---- Seasonal/local + boost ingredients ------------------------------------------------

test('seasonalLocal on boosts a recipe naming an in-season (July) ingredient; off leaves it neutral', () => {
  const julyTomato = recipe('tomato', { ingredients: [{ name: 'Tomato', es: 'tomate', qty: 200, unit: 'g' }] });
  const on = scoreRecipe(julyTomato, ctxFor({ ...defaultHousehold(), seasonalLocal: true }, WEEK));
  const off = scoreRecipe(julyTomato, ctxFor({ ...defaultHousehold(), seasonalLocal: false }, WEEK));
  assert.ok(on > off, 'seasonalLocal on should score an in-season ingredient higher');
});

test('seasonalLocal has no effect on a recipe with no in-season ingredient match', () => {
  const cheesy = recipe('cheesy', { ingredients: [{ name: 'Cheese', es: 'queso', qty: 100, unit: 'g' }] });
  const on = scoreRecipe(cheesy, ctxFor({ ...defaultHousehold(), seasonalLocal: true }, WEEK));
  const off = scoreRecipe(cheesy, ctxFor({ ...defaultHousehold(), seasonalLocal: false }, WEEK));
  assert.equal(on, off);
});

test('boost ingredients: +8 per distinct match (name/es, diacritic-insensitive), capped at +20', () => {
  const household: Household = { ...defaultHousehold(), seasonalLocal: false, boostIngredients: ['aguacate', 'tomate'] };
  const noBoost = recipe('carrot', { ingredients: [{ name: 'Carrot', es: 'zanahoria', qty: 200, unit: 'g' }] });
  const twoBoosts = recipe('avotom', {
    ingredients: [
      { name: 'Avocado', es: 'aguacate', qty: 100, unit: 'g' },
      { name: 'Tomato', es: 'tomate', qty: 150, unit: 'g' },
    ],
  });
  const diff = scoreRecipe(twoBoosts, ctxFor(household)) - scoreRecipe(noBoost, ctxFor(household));
  assert.equal(diff, 16, '2 distinct matches × 8 = 16 (both recipes share the same vegRichness=1, isolating the boost)');

  const capped: Household = { ...household, boostIngredients: ['aguacate', 'tomate', 'calabacín'] };
  const threeBoosts = recipe('avotomzuc', {
    ingredients: [
      { name: 'Avocado', es: 'aguacate', qty: 100, unit: 'g' },
      { name: 'Tomato', es: 'tomate', qty: 150, unit: 'g' },
      { name: 'Zucchini', es: 'calabacín', qty: 150, unit: 'g' },
    ],
  });
  const cappedDiff = scoreRecipe(threeBoosts, ctxFor(capped)) - scoreRecipe(noBoost, ctxFor(capped));
  assert.equal(cappedDiff, 20, '3 matches × 8 = 24 caps at +20');
});

test('boost matching is case + diacritic insensitive (Aguacate vs AGUACATE vs aguacaté)', () => {
  const household: Household = { ...defaultHousehold(), seasonalLocal: false, boostIngredients: ['AGUACATE'] };
  const recipeAccented = recipe('r', { ingredients: [{ name: 'Avocado', es: 'aguacaté', qty: 100, unit: 'g' }] });
  const baseline = recipe('b', { ingredients: [{ name: 'Carrot', es: 'zanahoria', qty: 200, unit: 'g' }] });
  assert.equal(scoreRecipe(recipeAccented, ctxFor(household)) - scoreRecipe(baseline, ctxFor(household)), 8);
});

// ---- Per-day request/pick (POST /plan/request) ------------------------------------------

function requestLibrary(): Recipe[] {
  return [
    recipe('fish-tacos', { title: 'Grilled fish tacos', tags: ['fish', 'quick'], cuisine: 'global', prepMin: 10, cookMin: 15, ingredients: [{ name: 'Cod', es: 'bacalao', qty: 300, unit: 'g' }] }),
    recipe('chicken-rice', { title: 'Chicken and rice', tags: ['comfort'], cuisine: 'spanish', prepMin: 15, cookMin: 30, ingredients: [{ name: 'Chicken', es: 'pollo', qty: 400, unit: 'g' }] }),
    recipe('veggie-stew', { title: 'Vegetable stew', tags: ['veggie'], cuisine: 'global', prepMin: 15, cookMin: 40, ingredients: [{ name: 'Carrot', es: 'zanahoria', qty: 200, unit: 'g' }] }),
    recipe('pasta-bake', { title: 'Cheesy pasta bake', tags: ['comfort'], cuisine: 'italian', prepMin: 10, cookMin: 30, ingredients: [{ name: 'Cheese', es: 'queso', qty: 150, unit: 'g' }] }),
  ];
}

test('plan/request deterministic path: text keyword match ranks the matching recipe first', () => {
  const plan = emptyPlan(WEEK, 4);
  const ranked = rankPlanRequestCandidates(requestLibrary(), defaultHousehold(), plan, { date: plan.days[0].date, now: NOW, text: 'fish' });
  assert.equal(ranked[0].recipe.id, 'fish-tacos', 'the title/tag keyword match should outrank everything else');
  assert.match(ranked[0].why, /fish/);
});

test('plan/request excludes recipes already planned this week — other days AND the request day itself', () => {
  const plan = emptyPlan(WEEK, 4);
  plan.days[0].recipeId = 'fish-tacos'; // the day being requested
  plan.days[1].recipeId = 'chicken-rice'; // a different day
  const ranked = rankPlanRequestCandidates(requestLibrary(), defaultHousehold(), plan, { date: plan.days[0].date, now: NOW });
  assert.ok(!ranked.some((c) => c.recipe.id === 'chicken-rice'), 'already-planned recipes never come back as a candidate');
  assert.ok(!ranked.some((c) => c.recipe.id === 'fish-tacos'), "the day's own current pick is a no-op candidate — excluded too");
});

test('plan/request excludeIds (Refresh) drops the previously-shown candidates', () => {
  const plan = emptyPlan(WEEK, 4);
  const first = rankPlanRequestCandidates(requestLibrary(), defaultHousehold(), plan, { date: plan.days[0].date, now: NOW });
  const shownIds = first.map((c) => c.recipe.id);
  const refreshed = rankPlanRequestCandidates(requestLibrary(), defaultHousehold(), plan, {
    date: plan.days[0].date,
    now: NOW,
    excludeIds: shownIds,
  });
  assert.equal(refreshed.length, 0, 'every candidate was excluded — nothing left to show');
});

test('plan/request "why" reasons are short and human (max 3 parts)', () => {
  const plan = emptyPlan(WEEK, 4);
  const ranked = rankPlanRequestCandidates(requestLibrary(), defaultHousehold(), plan, { date: plan.days[0].date, now: NOW });
  for (const c of ranked) {
    assert.ok(c.why.length > 0);
    assert.ok(c.why.split(' · ').length <= 3);
  }
});
