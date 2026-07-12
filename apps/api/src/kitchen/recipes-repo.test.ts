// Unit tests for the recipe library repository (docs/46 §2a/§2b/§2d): CRUD + FTS5 search,
// pagination/filtering, retrieval-capped AI-prompt pool, and idempotent fail-safe boot
// migration from kitchen.json. Each test gets its own temp dir (RECIPES_DB_FILE +
// KITCHEN_FILE) via freshEnv() + _resetForTests() so the module-level sqlite handle / JSON
// cache never leaks between cases. No live network — sqlite only.
//   node --import tsx --test src/kitchen/recipes-repo.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as repo from './recipes-repo';
import { isRecipesDbEnabled } from './recipes-db';
import { _resetCacheForTests as resetKitchenJsonCache } from './store';
import type { Recipe } from './types';

function freshEnv(): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'recipes-repo-test-'));
  process.env.RECIPES_DB_FILE = join(dir, 'recipes.db');
  process.env.KITCHEN_FILE = join(dir, 'kitchen.json');
  repo._resetForTests();
  return { dir };
}

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
    steps: [{ phase: 'cook', text: 'Cook it.' }],
    lastCookedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('sqlite is actually enabled in this test environment (better-sqlite3 loads)', () => {
  freshEnv();
  assert.equal(isRecipesDbEnabled(), true, 'if this fails, every other test here exercises the JSON fallback instead of sqlite');
});

test('insertRecipe / getFull / updateRecipe / deleteRecipe round-trip, steps included in getFull', () => {
  freshEnv();
  const r = recipe('r1', { title: 'Tortilla de patatas', steps: [{ phase: 'cook', text: 'Fry the potatoes.', timerSec: 600 }] });
  repo.insertRecipe(r);
  assert.equal(repo.count(), 1);
  assert.equal(repo.exists('r1'), true);
  assert.equal(repo.exists('nope'), false);

  const full = repo.getFull('r1');
  assert.ok(full);
  assert.equal(full!.title, 'Tortilla de patatas');
  assert.equal(full!.steps.length, 1);
  assert.equal(full!.steps[0].timerSec, 600);

  const updated = { ...r, title: 'Tortilla de patatas (updated)' };
  repo.updateRecipe(updated);
  assert.equal(repo.getFull('r1')!.title, 'Tortilla de patatas (updated)');
  assert.equal(repo.count(), 1, 'update must not create a duplicate row');

  repo.deleteRecipe('r1');
  assert.equal(repo.count(), 0);
  assert.equal(repo.getFull('r1'), null);
});

test('listAllSlim omits steps but keeps ingredients (needed by the engine)', () => {
  freshEnv();
  repo.insertRecipe(recipe('r1'));
  const [slim] = repo.listAllSlim();
  assert.ok(slim);
  assert.equal('steps' in slim, false);
  assert.equal(slim.ingredients.length, 1);
  assert.equal(slim.ingredients[0].es, 'arroz redondo');
});

test('search: FTS matches title, English ingredient name, and Spanish ingredient name', () => {
  freshEnv();
  repo.bulkInsert([
    recipe('paella', { title: 'Seafood Paella', ingredients: [{ name: 'Prawns', es: 'gambas', qty: 200, unit: 'g' }] }),
    recipe('tortilla', { title: 'Tortilla de patatas', ingredients: [{ name: 'Potato', es: 'patata', qty: 500, unit: 'g' }] }),
    recipe('pasta', { title: 'Pasta al pesto', cuisine: 'italian', ingredients: [{ name: 'Basil', es: 'albahaca', qty: 20, unit: 'g' }] }),
  ]);

  assert.deepEqual(
    repo.search({ q: 'paella' }).items.map((r) => r.id),
    ['paella'],
  );
  assert.deepEqual(
    repo.search({ q: 'prawns' }).items.map((r) => r.id),
    ['paella'],
    'matches the English ingredient name',
  );
  assert.deepEqual(
    repo.search({ q: 'gambas' }).items.map((r) => r.id),
    ['paella'],
    'matches the Spanish (es) ingredient name',
  );
  assert.deepEqual(
    repo.search({ q: 'patata' }).items.map((r) => r.id),
    ['tortilla'],
  );
  // Prefix match — "toma" should not hit "tortilla" but "tort" should.
  assert.deepEqual(
    repo.search({ q: 'tort' }).items.map((r) => r.id),
    ['tortilla'],
  );
});

test('search: filters — cuisine, tag, maxMin, fish, veggie', () => {
  freshEnv();
  repo.bulkInsert([
    recipe('spanish-fish', {
      title: 'Merluza a la plancha',
      cuisine: 'spanish',
      tags: ['quick'],
      prepMin: 10,
      cookMin: 15,
      ingredients: [{ name: 'Hake', es: 'merluza', qty: 400, unit: 'g' }],
    }),
    recipe('spanish-veg', {
      title: 'Menestra de verduras',
      cuisine: 'spanish',
      tags: ['slow'],
      prepMin: 20,
      cookMin: 40,
      ingredients: [{ name: 'Carrot', es: 'zanahoria', qty: 200, unit: 'g' }],
    }),
    recipe('italian-meat', {
      title: 'Bolognese',
      cuisine: 'italian',
      tags: ['quick'],
      prepMin: 15,
      cookMin: 30,
      ingredients: [{ name: 'Beef mince', es: 'carne picada de ternera', qty: 400, unit: 'g' }],
    }),
  ]);

  assert.deepEqual(repo.search({ cuisine: 'spanish' }).items.map((r) => r.id).sort(), ['spanish-fish', 'spanish-veg']);
  assert.deepEqual(repo.search({ tag: 'quick' }).items.map((r) => r.id).sort(), ['italian-meat', 'spanish-fish']);
  assert.deepEqual(repo.search({ maxMin: 25 }).items.map((r) => r.id), ['spanish-fish']);
  assert.deepEqual(repo.search({ fish: true }).items.map((r) => r.id), ['spanish-fish']);
  assert.deepEqual(repo.search({ veggie: true }).items.map((r) => r.id), ['spanish-veg']);
  assert.deepEqual(repo.search({ cuisine: 'spanish', fish: true }).items.map((r) => r.id), ['spanish-fish']);
});

test('search: pagination — total is the full match count, items are the requested page', () => {
  freshEnv();
  const many = Array.from({ length: 12 }, (_, i) => recipe(`p${i}`, { title: `Plato ${i}` }));
  repo.bulkInsert(many);

  const page1 = repo.search({ page: 1, pageSize: 5 });
  assert.equal(page1.total, 12);
  assert.equal(page1.items.length, 5);
  assert.equal(page1.page, 1);
  assert.equal(page1.pageSize, 5);

  const page3 = repo.search({ page: 3, pageSize: 5 });
  assert.equal(page3.items.length, 2, 'last page has the 2 remaining items');

  const page1Ids = new Set(page1.items.map((r) => r.id));
  const page2Ids = new Set(repo.search({ page: 2, pageSize: 5 }).items.map((r) => r.id));
  for (const id of page2Ids) assert.equal(page1Ids.has(id), false, 'pages must not overlap');
});

test('promptPool caps to `limit` and ranks by keyword relevance (never embeds the full library)', () => {
  freshEnv();
  const many = Array.from({ length: 200 }, (_, i) => recipe(`bulk-${i}`, { title: `Filler dish ${i}`, cuisine: 'global' }));
  repo.bulkInsert([
    ...many,
    recipe('salmon-1', { title: 'Grilled salmon with lemon', ingredients: [{ name: 'Salmon', es: 'salmón', qty: 400, unit: 'g' }] }),
    recipe('salmon-2', { title: 'Salmon and rice bowl', ingredients: [{ name: 'Salmon', es: 'salmón', qty: 300, unit: 'g' }] }),
  ]);

  const pool = repo.promptPool('a nice recipe with salmon', 10);
  assert.equal(pool.length, 10, 'pool is capped to the limit even though the library has 202 recipes');
  const ids = pool.map((r) => r.id);
  assert.ok(ids.includes('salmon-1') && ids.includes('salmon-2'), 'the relevant salmon recipes rank into the capped pool');
});

test('boot migration: idempotent — moves kitchen.json recipes into sqlite, backs up, empties the array; re-running is a no-op', () => {
  const { dir } = freshEnv();
  const kitchenFile = join(dir, 'kitchen.json');
  const seedRecipe = recipe('legacy-1', { title: 'Legacy Recipe' });
  writeFileSync(
    kitchenFile,
    JSON.stringify({
      recipes: [seedRecipe],
      productMap: {},
      staples: [],
      plans: {},
      orderDraft: { lines: [], suggestions: [], status: 'draft', totalEur: 0, updatedAt: '2026-01-01T00:00:00.000Z' },
      orderHistory: [],
      household: {
        adults: 2, kids: 2, allergies: [], dietRestrictions: [], dislikes: [], loves: [], weeknightMaxMin: 30,
        cuisineWeights: { spanish: 80, japanese: 65, italian: 60, dutch: 45, global: 50 },
        goals: { mode: null, kcalPerDinner: null }, showNutritionOnCards: true,
        nutritionScales: { calories: 5, carbs: 5, fish: 5, veg: 5, protein: 5 }, seasonalLocal: true, boostIngredients: [],
      },
      reminders: { planWeekDow: 0, planWeekHour: 18, submitByDow: 0, submitByHour: 22, targetSlotLabel: 'Mon 19:00–20:00' },
      suggestionMutes: {},
      seededAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  );

  const first = repo.runBootMigrationIfNeeded();
  assert.equal(first.migrated, true);
  assert.equal(first.count, 1);
  assert.equal(repo.count(), 1, 'recipe now lives in sqlite');
  assert.equal(repo.getFull('legacy-1')!.title, 'Legacy Recipe');

  const bak = `${kitchenFile}.pre-sqlite.bak`;
  assert.ok(existsSync(bak), 'kitchen.json.pre-sqlite.bak exists');
  const bakParsed = JSON.parse(readFileSync(bak, 'utf8'));
  assert.equal(bakParsed.recipes.length, 1, 'the backup preserves the original recipes array');

  const afterParsed = JSON.parse(readFileSync(kitchenFile, 'utf8'));
  assert.deepEqual(afterParsed.recipes, [], 'kitchen.json recipes array is emptied after migration');

  // Re-running boot migration must be a no-op (idempotent) — nothing left to migrate, and no duplication.
  const second = repo.runBootMigrationIfNeeded();
  assert.equal(second.migrated, false);
  assert.equal(repo.count(), 1, 'still exactly one recipe — the second run did not duplicate it');
});

test('boot migration MERGES fallback-era JSON recipes into an already-populated sqlite (the sqlite-flap case)', () => {
  const { dir } = freshEnv();
  const kitchenFile = join(dir, 'kitchen.json');

  // Boot A: sqlite works — one recipe already lives in the db (previously migrated).
  repo.insertRecipe(recipe('migrated-1', { title: 'Already In Sqlite' }));
  assert.equal(repo.count(), 1);

  // Boot B (simulated): the native sqlite module failed to load → the app ran in fallback
  // JSON mode and the user saved a NEW recipe into kitchen.json. Reproduce the on-disk end
  // state directly, then drop only the JSON cache so the store re-reads the file. The
  // sqlite handle stays live — this is boot C, where the native module loads again.
  writeFileSync(
    kitchenFile,
    JSON.stringify({
      recipes: [recipe('fallback-1', { title: 'Saved During Fallback' })],
      seededAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  );
  resetKitchenJsonCache();

  // Boot C: BOTH stores have rows. The migration must MERGE (INSERT OR REPLACE), never
  // skip-then-strip — skipping here would lose fallback-1 to the .bak forever (F1).
  const result = repo.runBootMigrationIfNeeded();
  assert.equal(result.migrated, true);
  assert.equal(repo.count(), 2, 'both the previously-migrated and the fallback-era recipe are in sqlite');
  assert.equal(repo.getFull('fallback-1')!.title, 'Saved During Fallback', 'the fallback-era recipe is served');
  assert.equal(repo.getFull('migrated-1')!.title, 'Already In Sqlite', 'the earlier recipe is untouched');
  assert.ok(
    repo.search({ q: 'fallback' }).items.some((r) => r.id === 'fallback-1'),
    'the merged recipe is FTS-indexed too',
  );
  const afterParsed = JSON.parse(readFileSync(kitchenFile, 'utf8'));
  assert.deepEqual(afterParsed.recipes, [], 'kitchen.json recipes array is emptied after the merge');
});

test('boot migration is a no-op once kitchen.json already has an empty recipes array (already migrated / already seeded+emptied)', () => {
  const { dir } = freshEnv();
  // seededAt already set so the store's own first-boot seeding (50 SEED_RECIPES) doesn't
  // kick in — this is the state right after a previous successful migration, or a store that
  // was seeded and later emptied. Either way, nothing left for THIS run to migrate.
  writeFileSync(
    join(dir, 'kitchen.json'),
    JSON.stringify({ recipes: [], seededAt: '2026-01-01T00:00:00.000Z' }),
    'utf8',
  );
  const result = repo.runBootMigrationIfNeeded();
  assert.equal(result.migrated, false);
  assert.equal(repo.count(), 0);
});

test('a genuinely fresh install (no kitchen.json at all) seeds 50 recipes, and migration picks them up', () => {
  freshEnv();
  const result = repo.runBootMigrationIfNeeded();
  assert.equal(result.migrated, true);
  assert.equal(result.count, 50, 'the store seeds SEED_RECIPES on first load; migration moves all of them into sqlite');
  assert.equal(repo.count(), 50);
});

// ---- Photo enrichment + local cache repo helpers (docs/47 §3b, hardened docs/48 §4b) --------

test('photoCoverage: counts CACHED (local) vs. LINKED (remote, not yet cached) separately', () => {
  freshEnv();
  repo.insertRecipe(recipe('r1', { photo: '/recipes/r1.jpg' })); // bundled seed — durable/local
  repo.insertRecipe(recipe('r2', { photo: '/api/kitchen/photos/r2' })); // our own cache route — durable/local
  repo.insertRecipe(recipe('r3', { photo: 'https://images.example.com/hotlink.jpg' })); // remote — linked, not cached
  repo.insertRecipe(recipe('r4', { photo: null }));
  assert.deepEqual(repo.photoCoverage(), { total: 4, cached: 2, linked: 1 });
});

test('nextPhotoWorkItem: priority 1 — skips photo-present recipes, returns photo-null ones in stable (title) order', () => {
  freshEnv();
  repo.insertRecipe(recipe('r1', { title: 'Zebra dish', photo: null }));
  repo.insertRecipe(recipe('r2', { title: 'Apple dish', photo: '/recipes/r2.jpg' }));
  repo.insertRecipe(recipe('r3', { title: 'Mango dish', photo: null }));

  const now = Date.now();
  const item = repo.nextPhotoWorkItem(now, 30 * 24 * 60 * 60 * 1000);
  assert.equal(item?.mode, 'search');
  assert.equal(item?.recipe.id, 'r3', 'title-sorted: Mango before Zebra, and Apple (has a photo) is skipped');
});

test('nextPhotoWorkItem: a recently-tried no-hit is skipped, an old one is retried', () => {
  freshEnv();
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  repo.insertRecipe(recipe('recent', { photo: null, photoTriedAt: new Date(now - 1000).toISOString() }));
  repo.insertRecipe(recipe('old', { photo: null, photoTriedAt: new Date(now - thirtyDays - 1000).toISOString() }));

  const item = repo.nextPhotoWorkItem(now, thirtyDays);
  assert.equal(item?.mode, 'search');
  assert.equal(item?.recipe.id, 'old');
});

test('nextPhotoWorkItem: priority 2 — a provider-hotlinked photo is offered for cache-only backfill once no photo-null recipes remain', () => {
  freshEnv();
  repo.insertRecipe(
    recipe('r1', { photo: 'https://images.example.com/hotlink.jpg', photoCredit: { name: 'Ana', url: 'https://x.test', provider: 'openverse' } }),
  );
  const item = repo.nextPhotoWorkItem(Date.now(), 30 * 24 * 60 * 60 * 1000);
  assert.equal(item?.mode, 'cache-only');
  assert.equal(item?.recipe.id, 'r1');
});

test('nextPhotoWorkItem: priority 3 — an og:image URL-import photo is offered LAST, behind provider-hotlinked ones', () => {
  freshEnv();
  repo.insertRecipe(recipe('imported', { title: 'Apple dish', photo: 'https://cdn.example.com/og.jpg', source: 'url', sourceUrl: 'https://x.test' }));
  repo.insertRecipe(
    recipe('hotlinked', {
      title: 'Zebra dish',
      photo: 'https://images.example.com/hotlink.jpg',
      photoCredit: { name: 'Ana', url: 'https://x.test', provider: 'openverse' },
    }),
  );
  const item = repo.nextPhotoWorkItem(Date.now(), 30 * 24 * 60 * 60 * 1000);
  assert.equal(item?.recipe.id, 'hotlinked', 'priority 2 (credited hotlink) is offered before priority 3 (bare og:image import)');
});

test('nextPhotoWorkItem: a manually-entered remote photo (no credit, source != url) never enters the backfill queue', () => {
  freshEnv();
  repo.insertRecipe(recipe('manual', { source: 'manual', photo: 'https://cdn.example.com/manual.jpg' }));
  assert.equal(repo.nextPhotoWorkItem(Date.now(), 30 * 24 * 60 * 60 * 1000), null);
});

test('nextPhotoWorkItem: skipCacheOnlyIds excludes cache-only items (both buckets) but never search-mode ones', () => {
  freshEnv();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  repo.insertRecipe(
    recipe('hotlinked', {
      title: 'Apple dish',
      photo: 'https://images.example.com/dead.jpg',
      photoCredit: { name: 'Ana', url: 'https://x.test', provider: 'openverse' },
    }),
  );
  repo.insertRecipe(recipe('imported', { title: 'Mango dish', photo: 'https://cdn.example.com/og.jpg', source: 'url', sourceUrl: 'https://x.test' }));

  const skip = new Set(['hotlinked']);
  const item = repo.nextPhotoWorkItem(Date.now(), thirtyDays, skip);
  assert.equal(item?.recipe.id, 'imported', 'the skipped priority-2 item is passed over; priority 3 proceeds');

  skip.add('imported');
  assert.equal(repo.nextPhotoWorkItem(Date.now(), thirtyDays, skip), null, 'both cache-only items skipped → nothing to do');

  // A photo-null (search-mode) recipe is NEVER filtered by the skip set — its give-up
  // mechanism is photoTriedAt, owned by photo-enrich.ts.
  repo.insertRecipe(recipe('needs-search', { title: 'Zebra dish', photo: null }));
  skip.add('needs-search');
  const searchItem = repo.nextPhotoWorkItem(Date.now(), thirtyDays, skip);
  assert.equal(searchItem?.mode, 'search');
  assert.equal(searchItem?.recipe.id, 'needs-search');
});

test('nextPhotoWorkItem: null when every recipe is cached, or in its cool-off, or otherwise not queue-eligible', () => {
  freshEnv();
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  repo.insertRecipe(recipe('r1', { photo: '/recipes/r1.jpg' }));
  repo.insertRecipe(recipe('r2', { photo: null, photoTriedAt: new Date(now - 1000).toISOString() }));
  assert.equal(repo.nextPhotoWorkItem(now, thirtyDays), null);
});

test('setRecipePhoto: stores the LOCAL route + credit (incl. an optional license), clears any stale tried marker', () => {
  freshEnv();
  repo.insertRecipe(recipe('r1', { photo: null, photoTriedAt: '2026-01-01T00:00:00.000Z' }));
  repo.setRecipePhoto('r1', '/api/kitchen/photos/r1', { name: 'Someone', url: 'https://commons.wikimedia.org/wiki/File:X.jpg', provider: 'commons', license: 'CC BY-SA 4.0' });
  const full = repo.getFull('r1');
  assert.equal(full?.photo, '/api/kitchen/photos/r1');
  assert.deepEqual(full?.photoCredit, { name: 'Someone', url: 'https://commons.wikimedia.org/wiki/File:X.jpg', provider: 'commons', license: 'CC BY-SA 4.0' });
  assert.equal(full?.photoTriedAt, null);
});

test('setRecipePhotoLocal: flips an existing hotlink to its cached local route, keeping whatever credit it already had', () => {
  freshEnv();
  repo.insertRecipe(
    recipe('r1', { photo: 'https://images.example.com/hotlink.jpg', photoCredit: { name: 'Ana', url: 'https://x.test', provider: 'openverse' } }),
  );
  repo.setRecipePhotoLocal('r1', '/api/kitchen/photos/r1');
  const full = repo.getFull('r1');
  assert.equal(full?.photo, '/api/kitchen/photos/r1');
  assert.deepEqual(full?.photoCredit, { name: 'Ana', url: 'https://x.test', provider: 'openverse' }, 'credit is untouched by a backfill cache flip');
});

test('markPhotoTried records the timestamp without touching the photo field', () => {
  freshEnv();
  repo.insertRecipe(recipe('r1', { photo: null }));
  repo.markPhotoTried('r1', '2026-03-01T00:00:00.000Z');
  const full = repo.getFull('r1');
  assert.equal(full?.photo, null);
  assert.equal(full?.photoTriedAt, '2026-03-01T00:00:00.000Z');
});

// ---- Schema v2/v3 migration idempotence (docs/47 + docs/48 §4b cross-cutting) ----------------

test('schema v2 (photo_credit_json / photo_tried_at) migration is idempotent — reopening the same db file is a no-op, not a crash', () => {
  const { dir } = freshEnv();
  repo.insertRecipe(recipe('r1', { photo: null }));
  repo.setRecipePhoto('r1', '/api/kitchen/photos/r1', { name: 'Ana', url: 'https://x.test', provider: 'openverse' });

  // Simulate a restart: close the handle and reopen against the SAME file — migrate() runs
  // again on the existing (already-migrated) file. Must not throw "duplicate column name" and
  // must preserve the data written before the "restart".
  repo._resetForTests();
  process.env.RECIPES_DB_FILE = join(dir, 'recipes.db');
  process.env.KITCHEN_FILE = join(dir, 'kitchen.json');

  const full = repo.getFull('r1');
  assert.equal(full?.photo, '/api/kitchen/photos/r1');
  assert.deepEqual(full?.photoCredit, { name: 'Ana', url: 'https://x.test', provider: 'openverse' });
});

test('schema v3 (photo_cached): reopening an already-v3 db file is idempotent, and photoCoverage still reflects reality', () => {
  const { dir } = freshEnv();
  repo.insertRecipe(recipe('r1', { photo: '/recipes/r1.jpg' }));
  repo.insertRecipe(recipe('r2', { photo: 'https://images.example.com/hotlink.jpg' }));

  repo._resetForTests();
  process.env.RECIPES_DB_FILE = join(dir, 'recipes.db');
  process.env.KITCHEN_FILE = join(dir, 'kitchen.json');

  assert.deepEqual(repo.photoCoverage(), { total: 2, cached: 1, linked: 1 });
});
