// Unit tests for the photo-enrichment coordinator (docs/47 §3b): one tick with a mocked
// provider stores photo+credit on a found result, marks a recipe tried on a definitive
// no-hit, leaves it alone on throttled/error, skips photo-present recipes entirely, and
// re-tries a stale (>=30 day) no-hit. NO live network — photo-providers' fetch/clock seams
// are swapped out exactly like photo-providers.test.ts.
//   node --import tsx --test src/kitchen/photo-enrich.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tick } from './photo-enrich';
import * as recipesRepo from './recipes-repo';
import { update as updateAppStore } from '../store';
import { _resetThrottleForTests, _setClockForTests, _setFetchForTests } from './photo-providers';
import type { Recipe } from './types';

function freshEnv(): void {
  const dir = mkdtempSync(join(tmpdir(), 'photo-enrich-test-'));
  process.env.RECIPES_DB_FILE = join(dir, 'recipes.db');
  process.env.KITCHEN_FILE = join(dir, 'kitchen.json');
  recipesRepo._resetForTests();
  _resetThrottleForTests();
  _setClockForTests();
  _setFetchForTests();
  updateAppStore((s) => {
    s.kitchen.intelligence.pexelsApiKey = null;
  });
}

function recipe(id: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    id,
    title: id,
    source: 'ai',
    photo: null,
    servingsBase: 4,
    prepMin: 10,
    cookMin: 15,
    tags: [],
    cuisine: 'spanish',
    tools: [],
    ingredients: [{ name: 'Rice', es: 'arroz redondo', qty: 300, unit: 'g' }],
    steps: [{ phase: 'cook', text: 'Cook it.' }],
    lastCookedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

test('tick: a found photo is stored with its credit, and the recipe no longer looks photo-null', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1', { title: 'Tortilla de patatas' }));
  _setFetchForTests(async () =>
    fakeResponse(200, {
      results: [{ url: 'https://example.com/tortilla.jpg', creator: 'Ana', foreign_landing_url: 'https://x.test/ana', width: 800, height: 600 }],
    }),
  );

  await tick();

  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photo, 'https://example.com/tortilla.jpg');
  assert.deepEqual(full?.photoCredit, { name: 'Ana', url: 'https://x.test/ana', provider: 'openverse' });
  assert.equal(full?.photoTriedAt, null, 'a found photo clears any stale tried marker');
});

test('tick: a definitive no-hit marks the recipe tried but does not touch its photo', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1'));
  _setFetchForTests(async () => fakeResponse(200, { results: [] }));

  await tick();

  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photo, null);
  assert.ok(full?.photoTriedAt, 'no-hit records a tried timestamp');
});

test('tick: photo-present recipes are skipped entirely — never queried', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1', { photo: '/recipes/r1.jpg' }));
  let calls = 0;
  _setFetchForTests(async () => {
    calls++;
    return fakeResponse(200, { results: [] });
  });

  await tick();
  assert.equal(calls, 0, 'a recipe that already has a photo is never a candidate');
});

test('tick: a recipe tried recently (< 30 days) is not retried; one tried > 30 days ago is', async () => {
  freshEnv();
  const now = Date.now();
  const recent = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
  const stale = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(); // 31 days ago
  recipesRepo.insertRecipe(recipe('recent', { photoTriedAt: recent }));
  recipesRepo.insertRecipe(recipe('stale', { photoTriedAt: stale }));

  const queried: string[] = [];
  _setFetchForTests(async (url: string) => {
    queried.push(url);
    return fakeResponse(200, { results: [] });
  });

  await tick();
  // The recipe fixture's one non-pantry ingredient gives it a fallback query, so a no-hit
  // candidate costs 2 requests (primary + fallback) — both against the STALE candidate; the
  // recent one is skipped and generates zero requests.
  assert.equal(queried.length, 2, 'only the stale candidate was queried this tick, not the recent one');
  const staleAfter = recipesRepo.getFull('stale');
  assert.ok(staleAfter?.photoTriedAt && staleAfter.photoTriedAt !== stale, 'stale recipe got a fresh tried timestamp');
  const recentAfter = recipesRepo.getFull('recent');
  assert.equal(recentAfter?.photoTriedAt, recent, 'recent no-hit is left completely untouched');
});

test('tick: throttled/error outcomes leave the candidate exactly as-is (retried later, not marked tried)', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1'));
  // Force a 429 on the very first call so the outcome is 'error', not 'no-hit'.
  _setFetchForTests(async () => fakeResponse(429, {}));

  await tick();

  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photo, null);
  assert.equal(full?.photoTriedAt, null, 'a transient error must never be recorded as a definitive no-hit');
});

test('tick: nothing photo-null to do is a clean no-op (no fetch call, no throw)', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1', { photo: '/recipes/r1.jpg' }));
  let calls = 0;
  _setFetchForTests(async () => {
    calls++;
    return fakeResponse(200, { results: [] });
  });
  await tick();
  assert.equal(calls, 0);
});

test('tick: picks up a Pexels key from settings and prefers it over Openverse', async () => {
  freshEnv();
  updateAppStore((s) => {
    s.kitchen.intelligence.pexelsApiKey = 'test-key';
  });
  recipesRepo.insertRecipe(recipe('r1'));
  let sawPexelsUrl = false;
  _setFetchForTests(async (url: string) => {
    if (url.includes('api.pexels.com')) sawPexelsUrl = true;
    return fakeResponse(200, { photos: [] });
  });

  await tick();
  assert.equal(sawPexelsUrl, true, 'a configured Pexels key routes the search to Pexels, not Openverse');
});
