// Unit tests for the bulk recipe-library generator (docs/46 §2c/§2d): the coverage-plan
// builder, the prompt builder, the dedupe helpers, and batch-result validation/insertion —
// all fed fixture data. NO live Anthropic/Batches call anywhere in this file: startGeneration/
// cancelGeneration are tested only through their refusal paths (no key configured / already
// running / nothing left to generate), which return before any network call would happen —
// see library-generate.ts's comment on why tick() is deliberately NOT invoked by
// startGeneration itself.
//   node --import tsx --test src/kitchen/library-generate.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCoveragePlan,
  buildLibraryPrompt,
  cancelGeneration,
  DUP_SIMILARITY_THRESHOLD,
  isDuplicateTitle,
  jobStatus,
  levenshtein,
  normalizeTitle,
  processResults,
  RECIPES_PER_REQUEST,
  startGeneration,
  titleSimilarity,
} from './library-generate';
import * as recipesRepo from './recipes-repo';
import { defaultHousehold } from './store';
import { update as updateAppStore } from '../store';
import type { BatchResult } from '../connectors/claude-batch';
import type { Cuisine, Household } from './types';

// NOTE on STATE_FILE: apps/api/src/store.ts memoizes its resolved file PATH on first use (by
// design — a real process's data dir never changes mid-run), so re-pointing STATE_FILE at a
// new temp dir mid-test-file has no effect after the first call. RECIPES_DB_FILE/KITCHEN_FILE
// (kitchen/store.ts, recipes-db.ts) re-read their env var fresh every call, so those get a
// brand-new temp dir per test; the app-wide libraryGeneration job state is instead reset
// explicitly via updateAppStore() below, same net effect without fighting the memoization.
function freshEnv(): void {
  const dir = mkdtempSync(join(tmpdir(), 'library-generate-test-'));
  process.env.RECIPES_DB_FILE = join(dir, 'recipes.db');
  process.env.KITCHEN_FILE = join(dir, 'kitchen.json');
  if (!process.env.STATE_FILE) process.env.STATE_FILE = join(dir, 'state.json');
  delete process.env.ANTHROPIC_API_KEY;
  recipesRepo._resetForTests();
  updateAppStore((s) => {
    s.kitchen.libraryGeneration = {
      status: 'idle',
      target: 0,
      capEur: 25,
      startedAt: null,
      updatedAt: new Date(0).toISOString(),
      batchIds: [],
      queued: 0,
      insertedCount: 0,
      duplicateCount: 0,
      failedCount: 0,
      spentEur: 0,
      error: null,
      remainingJson: null,
    };
    s.kitchen.intelligence.apiKey = null;
    s.kitchen.intelligence.usage = { month: '', inputTokens: 0, outputTokens: 0, eur: 0 };
  });
}

function hh(overrides: Partial<Household> = {}): Household {
  return { ...defaultHousehold(), ...overrides };
}

const ZERO_COUNTS: Record<Cuisine, number> = { spanish: 0, dutch: 0, japanese: 0, italian: 0, global: 0 };

// ---- buildCoveragePlan --------------------------------------------------------------------

test('buildCoveragePlan: cuisine split roughly matches the brief (spanish 30% / italian 15% / japanese 15% / dutch 10% / global 30%)', () => {
  const plan = buildCoveragePlan(2000, ZERO_COUNTS);
  const byCuisine = new Map<Cuisine, number>();
  for (const s of plan) byCuisine.set(s.cuisine, (byCuisine.get(s.cuisine) ?? 0) + 1);
  const total = plan.length;
  // Each spec is one request of RECIPES_PER_REQUEST recipes — compare recipe-equivalent shares.
  const share = (c: Cuisine) => ((byCuisine.get(c) ?? 0) * RECIPES_PER_REQUEST) / (total * RECIPES_PER_REQUEST);
  assert.ok(Math.abs(share('spanish') - 0.3) < 0.03, `spanish share ${share('spanish')}`);
  assert.ok(Math.abs(share('italian') - 0.15) < 0.03, `italian share ${share('italian')}`);
  assert.ok(Math.abs(share('japanese') - 0.15) < 0.03, `japanese share ${share('japanese')}`);
  assert.ok(Math.abs(share('dutch') - 0.1) < 0.03, `dutch share ${share('dutch')}`);
  assert.ok(Math.abs(share('global') - 0.3) < 0.03, `global share ${share('global')}`);
});

test('buildCoveragePlan: meets the fish/veggie/weeknight quotas (docs/46: >=20% fish, >=25% veggie, weeknight majority)', () => {
  const plan = buildCoveragePlan(2000, ZERO_COUNTS);
  const fishShare = plan.filter((s) => s.fish).length / plan.length;
  const veggieShare = plan.filter((s) => s.veggie).length / plan.length;
  const weeknightShare = plan.filter((s) => s.weeknight).length / plan.length;
  const kidShare = plan.filter((s) => s.kid).length / plan.length;
  assert.ok(fishShare >= 0.19, `fish share ${fishShare}`);
  assert.ok(veggieShare >= 0.24, `veggie share ${veggieShare}`);
  assert.ok(weeknightShare > 0.5, `weeknight share ${weeknightShare}`);
  assert.ok(kidShare > 0, `kid share ${kidShare}`);
});

test('buildCoveragePlan: the global bucket rotates through every required sub-style incl. jamie-style/nigella-style', () => {
  const plan = buildCoveragePlan(2000, ZERO_COUNTS);
  const styles = new Set(plan.filter((s) => s.cuisine === 'global').map((s) => s.styleHint));
  for (const required of ['jamie-style', 'nigella-style', 'mexican', 'indian', 'thai', 'greek', 'moroccan']) {
    assert.ok(styles.has(required), `missing global style ${required}`);
  }
});

test('buildCoveragePlan is resumable: existing counts reduce (or zero out) the shortfall per cuisine', () => {
  const fullPlan = buildCoveragePlan(2000, ZERO_COUNTS);
  const spanishWanted = fullPlan.filter((s) => s.cuisine === 'spanish').length * RECIPES_PER_REQUEST;

  // Spanish already fully stocked — a re-run should ask for zero more spanish.
  const resumed = buildCoveragePlan(2000, { ...ZERO_COUNTS, spanish: spanishWanted + 999 });
  assert.equal(resumed.filter((s) => s.cuisine === 'spanish').length, 0);
  // Other cuisines are untouched by the spanish surplus.
  assert.equal(
    resumed.filter((s) => s.cuisine === 'italian').length,
    fullPlan.filter((s) => s.cuisine === 'italian').length,
  );
});

test('buildCoveragePlan returns nothing once every cuisine bucket is already at/above target', () => {
  const plan = buildCoveragePlan(100, { spanish: 999, dutch: 999, japanese: 999, italian: 999, global: 999 });
  assert.equal(plan.length, 0);
});

// ---- buildLibraryPrompt -------------------------------------------------------------------

test('buildLibraryPrompt includes the fish/veggie/style/season hints and the household hard-avoid list', () => {
  const prompt = buildLibraryPrompt(
    { cuisine: 'global', styleHint: 'jamie-style', fish: true, veggie: true, weeknight: true, kid: true, season: 'summer' },
    hh({ allergies: ['gambas'], adults: 2, kids: 1 }),
    ['Existing Dish One', 'Existing Dish Two'],
  );
  assert.match(prompt, /jamie-style/);
  assert.match(prompt, /fish or seafood/);
  assert.match(prompt, /no meat and no fish/);
  assert.match(prompt, /35 minutes/);
  assert.match(prompt, /kid-friendly/);
  assert.match(prompt, /summer/);
  assert.match(prompt, /gambas/);
  assert.match(prompt, /Existing Dish One/);
});

// ---- Dedupe (normalized-title Levenshtein similarity) --------------------------------------

test('levenshtein / titleSimilarity: identical strings are 0 distance / 1.0 similarity', () => {
  assert.equal(levenshtein('paella', 'paella'), 0);
  assert.equal(titleSimilarity('Tortilla de patatas', 'Tortilla de patatas'), 1);
});

test('normalizeTitle strips diacritics/punctuation/case so near-identical titles compare cleanly', () => {
  assert.equal(normalizeTitle('Tortilla de Patatas!'), normalizeTitle('tortilla   de patatas'));
  assert.equal(normalizeTitle('Paella de Marisco (Merluza)'), 'paella de marisco merluza');
});

test('isDuplicateTitle: catches near-identical titles above the threshold, not genuinely different ones', () => {
  const existing = ['Tortilla de patatas clásica', 'Paella de marisco'];
  assert.ok(isDuplicateTitle('Tortilla de patatas Clasica', existing), 'near-identical (punctuation/accent only)');
  assert.ok(!isDuplicateTitle('Cocido madrileño', existing), 'genuinely different dish');
  assert.ok(titleSimilarity('Tortilla de patatas clásica', 'Tortilla de patatas Clasica') >= DUP_SIMILARITY_THRESHOLD);
});

// ---- processResults (validate -> dedupe -> insert) -----------------------------------------

function fixtureRecipeRaw(title: string, cuisine: Cuisine = 'spanish') {
  return {
    title,
    cuisine,
    ingredients: [
      { name: 'Chicken thighs', es: 'muslos de pollo', qty: 500, unit: 'g' },
      { name: 'Onion', es: 'cebolla', qty: 1, unit: 'count' },
    ],
    steps: [
      { phase: 'mise', text: 'Chop the onion.' },
      { phase: 'cook', text: 'Fry everything together.', timerSec: 900 },
    ],
    nutrition: { kcal: 520, proteinG: 32, carbsG: 40, fatG: 18 },
    prepMin: 15,
    cookMin: 25,
    servingsBase: 4,
    tags: ['weeknight'],
    kidScore: 0.7,
    season: ['summer'],
  };
}

function succeeded(customId: string, titles: string[], cuisine: Cuisine = 'spanish'): BatchResult {
  return {
    customId,
    outcome: 'succeeded',
    text: JSON.stringify({ recipes: titles.map((t) => fixtureRecipeRaw(t, cuisine)) }),
    inputTokens: 300,
    outputTokens: 3000,
  };
}

test('processResults: inserts valid recipes, counts spend, and skips near-duplicate titles', () => {
  freshEnv();
  recipesRepo.insertRecipe({
    id: 'existing-1',
    title: 'Tortilla de patatas clásica',
    source: 'seed',
    servingsBase: 4,
    prepMin: 10,
    cookMin: 20,
    tags: [],
    cuisine: 'spanish',
    tools: [],
    ingredients: [{ name: 'Potato', es: 'patata', qty: 500, unit: 'g' }],
    steps: [{ phase: 'cook', text: 'Fry.' }],
    lastCookedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const results: BatchResult[] = [
    succeeded('r0', ['Paella Valenciana', 'Tortilla de patatas Clasica'], 'spanish'), // 2nd is a near-dup of existing-1
    { customId: 'r1', outcome: 'errored', detail: 'overloaded' },
  ];

  const outcome = processResults(results, hh());
  assert.equal(outcome.inserted, 1, 'only Paella Valenciana is new');
  assert.equal(outcome.duplicates, 1, 'the near-duplicate tortilla is skipped, not inserted');
  // The succeeded result only returned 2 of the nominal RECIPES_PER_REQUEST (5) — the
  // shortfall (3) counts as failed, PLUS the errored result's full RECIPES_PER_REQUEST (5).
  assert.equal(outcome.failed, RECIPES_PER_REQUEST - 2 + RECIPES_PER_REQUEST, 'shortfall from r0 + all of r1 (errored)');
  assert.ok(outcome.spentEur > 0, 'batch-priced cost was tallied from usage tokens');
  assert.equal(recipesRepo.count(), 2, 'existing-1 + the one newly inserted recipe — the dup was not added');
});

test('processResults: an unparseable succeeded result still counts spend (tokens were billed) but inserts nothing', () => {
  freshEnv();
  const results: BatchResult[] = [{ customId: 'r0', outcome: 'succeeded', text: 'not json at all', inputTokens: 100, outputTokens: 200 }];
  const outcome = processResults(results, hh());
  assert.equal(outcome.inserted, 0);
  assert.equal(outcome.failed, RECIPES_PER_REQUEST);
  assert.ok(outcome.spentEur > 0);
});

test('processResults respects the household hard allergy filter (belt-and-braces, same as the interactive generator)', () => {
  freshEnv();
  const results: BatchResult[] = [succeeded('r0', ['Gambas al ajillo'], 'spanish')];
  // gambas (prawns) is the fixture's only forbidden-test ingredient path — but our fixture
  // recipe always uses chicken, so instead assert the allergy household still inserts a
  // chicken-based recipe (title doesn't matter — the HARD filter is ingredient-based).
  const outcome = processResults(results, hh({ allergies: ['pollo'] }));
  assert.equal(outcome.inserted, 0, 'the fixture recipe uses chicken (pollo) — the allergy household must reject it');
});

// ---- Job orchestration refusal paths (no network reachable from these branches) ------------

test('startGeneration refuses with no Anthropic key configured', () => {
  freshEnv();
  const result = startGeneration(2000);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /Anthropic key/);
  assert.equal(jobStatus().status, 'idle');
});

test('startGeneration refuses when a run is already in progress; cancelGeneration then re-enables starting', () => {
  freshEnv();
  process.env.ANTHROPIC_API_KEY = 'sk-test-fixture-key-not-real';
  try {
    const first = startGeneration(2000);
    assert.equal(first.ok, true);
    assert.equal(jobStatus().status, 'running');

    const second = startGeneration(2000);
    assert.equal(second.ok, false);
    assert.match(second.reason ?? '', /already in progress/);

    const cancelled = cancelGeneration();
    assert.equal(cancelled.ok, true);
    assert.equal(jobStatus().status, 'cancelled');

    const third = startGeneration(2000);
    assert.equal(third.ok, true, 'starting again after a cancel works');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('startGeneration refuses when the library is already at/above every cuisine target', () => {
  freshEnv();
  process.env.ANTHROPIC_API_KEY = 'sk-test-fixture-key-not-real';
  try {
    recipesRepo.bulkInsert(
      Array.from({ length: 40 }, (_, i) => ({
        id: `already-${i}`,
        title: `Already Have ${i}`,
        source: 'seed' as const,
        servingsBase: 4,
        prepMin: 10,
        cookMin: 10,
        tags: [],
        cuisine: 'spanish' as const,
        tools: [],
        ingredients: [{ name: 'Rice', es: 'arroz', qty: 200, unit: 'g' }],
        steps: [{ phase: 'cook' as const, text: 'Cook.' }],
        lastCookedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
    );
    // Target so small that spanish's 30% share (already far exceeded by the 40 seeded above)
    // and every other bucket's tiny share round to zero requests.
    const result = startGeneration(1);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /nothing left/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
