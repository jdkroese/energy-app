// Recipe library repository (docs/46 §2a/§2b) — the ONE seam between routes/kitchen.ts and
// recipe storage. Two backends, same public API:
//   - PRIMARY: SQLite (recipes-db.ts) + FTS5 search, for libraries at scale (~2,000+ recipes).
//   - FALLBACK: the original kitchen.json `recipes` array (kitchen/store.ts), used verbatim
//     when the native sqlite module can't load — the app must work exactly as it did pre-P2.
//
// Boot migration (idempotent, fail-safe): on first boot after this ships, if kitchen.json
// still has recipes AND sqlite is available, copy them into SQLite, back up kitchen.json to
// kitchen.json.pre-sqlite.bak, then empty the JSON `recipes` array (everything else in
// kitchen.json — plans/household/staples/etc — is untouched). On ANY error during migration,
// the JSON array is left exactly as found and this module falls back to JSON mode — recipes
// keep working, just without FTS/pagination at scale, and it's logged loudly so it's visible
// in the mini's logs.
//
// "Slim" vs "full": everywhere EXCEPT single-recipe detail (cook mode / quick-view), only
// RecipeSlim (Recipe minus `steps`, the bulky cook-instruction text) is needed — the planner
// engine, search results, and AI-prompt retrieval all work off ingredients/tags/nutrition, not
// steps. getFull(id) fetches the one full recipe (with steps) on demand.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { closeRecipesDb, db, type RecipesDb } from './recipes-db';
import * as kitchenStore from './store';
import { isFishRecipe, isVeggieRecipe, vegRichness } from './engine';
import type { Cuisine, Recipe, RecipeSlim } from './types';

// ---- Row <-> Recipe mapping --------------------------------------------------------------

interface Row {
  id: string;
  title: string;
  cuisine: string;
  photo: string | null;
  source: string;
  source_url: string | null;
  servings_base: number;
  prep_min: number;
  cook_min: number;
  tags_json: string;
  kid_score: number | null;
  season_json: string | null;
  nutrition_json: string | null;
  tools_json: string;
  ingredients_json: string;
  steps_json: string;
  last_cooked_at: string | null;
  ratings_json: string | null;
  created_at: string;
  updated_at: string;
  photo_credit_json: string | null;
  photo_tried_at: string | null;
}

function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowToFull(row: Row): Recipe {
  return {
    id: row.id,
    title: row.title,
    photo: row.photo,
    source: row.source as Recipe['source'],
    ...(row.source_url ? { sourceUrl: row.source_url } : {}),
    servingsBase: row.servings_base,
    prepMin: row.prep_min,
    cookMin: row.cook_min,
    tags: safeParse(row.tags_json, [] as string[]),
    cuisine: row.cuisine as Cuisine,
    ...(row.kid_score != null ? { kidScore: row.kid_score } : {}),
    ...(row.season_json ? { season: safeParse(row.season_json, undefined) } : {}),
    ...(row.nutrition_json ? { nutrition: safeParse(row.nutrition_json, undefined) } : {}),
    tools: safeParse(row.tools_json, [] as string[]),
    ingredients: safeParse(row.ingredients_json, []),
    steps: safeParse(row.steps_json, []),
    lastCookedAt: row.last_cooked_at ?? null,
    ...(row.ratings_json ? { ratings: safeParse(row.ratings_json, undefined) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.photo_credit_json ? { photoCredit: safeParse(row.photo_credit_json, undefined) } : {}),
    photoTriedAt: row.photo_tried_at ?? null,
  };
}

function rowToSlim(row: Row): RecipeSlim {
  const { steps: _steps, ...rest } = rowToFull(row);
  return rest;
}

/** Flattened ES+EN searchable ingredient text for the FTS row. */
function ingredientSearchText(r: Pick<Recipe, 'ingredients'>): string {
  return r.ingredients.map((i) => `${i.name} ${i.es}`).join(' ');
}

function toRow(r: Recipe): Row {
  return {
    id: r.id,
    title: r.title,
    cuisine: r.cuisine,
    photo: r.photo ?? null,
    source: r.source,
    source_url: r.sourceUrl ?? null,
    servings_base: r.servingsBase,
    prep_min: r.prepMin,
    cook_min: r.cookMin,
    tags_json: JSON.stringify(r.tags ?? []),
    kid_score: r.kidScore ?? null,
    season_json: r.season && r.season.length ? JSON.stringify(r.season) : null,
    nutrition_json: r.nutrition ? JSON.stringify(r.nutrition) : null,
    tools_json: JSON.stringify(r.tools ?? []),
    ingredients_json: JSON.stringify(r.ingredients ?? []),
    steps_json: JSON.stringify(r.steps ?? []),
    last_cooked_at: r.lastCookedAt ?? null,
    ratings_json: r.ratings ? JSON.stringify(r.ratings) : null,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    photo_credit_json: r.photoCredit ? JSON.stringify(r.photoCredit) : null,
    photo_tried_at: r.photoTriedAt ?? null,
  };
}

const COLUMNS = [
  'id', 'title', 'cuisine', 'photo', 'source', 'source_url', 'servings_base', 'prep_min', 'cook_min',
  'tags_json', 'kid_score', 'season_json', 'nutrition_json', 'tools_json', 'ingredients_json', 'steps_json',
  'last_cooked_at', 'ratings_json', 'created_at', 'updated_at', 'is_fish', 'is_veggie', 'veg_rich',
  'photo_credit_json', 'photo_tried_at',
] as const;

// ---- Low-level SQLite CRUD (callers already gate on isRecipesDbEnabled()) -----------------

function ftsUpsert(handle: RecipesDb, r: Recipe): void {
  handle.prepare('DELETE FROM recipes_fts WHERE id = ?').run(r.id);
  handle
    .prepare('INSERT INTO recipes_fts (id, title, tags, ingredients) VALUES (?, ?, ?, ?)')
    .run(r.id, r.title, (r.tags ?? []).join(' '), ingredientSearchText(r));
}

function dbInsertOrReplace(handle: RecipesDb, r: Recipe): void {
  const row = toRow(r);
  const fish = isFishRecipe(r) ? 1 : 0;
  const veggie = isVeggieRecipe(r) ? 1 : 0;
  const rich = vegRichness(r);
  const placeholders = COLUMNS.map(() => '?').join(', ');
  handle
    .prepare(`INSERT OR REPLACE INTO recipes (${COLUMNS.join(', ')}) VALUES (${placeholders})`)
    .run(
      row.id, row.title, row.cuisine, row.photo, row.source, row.source_url, row.servings_base, row.prep_min,
      row.cook_min, row.tags_json, row.kid_score, row.season_json, row.nutrition_json, row.tools_json,
      row.ingredients_json, row.steps_json, row.last_cooked_at, row.ratings_json, row.created_at, row.updated_at,
      fish, veggie, rich, row.photo_credit_json, row.photo_tried_at,
    );
  ftsUpsert(handle, r);
}

function dbDelete(handle: RecipesDb, id: string): void {
  handle.prepare('DELETE FROM recipes WHERE id = ?').run(id);
  handle.prepare('DELETE FROM recipes_fts WHERE id = ?').run(id);
}

function dbGetFull(handle: RecipesDb, id: string): Recipe | null {
  const row = handle.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToFull(row) : null;
}

function dbAllRows(handle: RecipesDb): Row[] {
  return handle.prepare('SELECT * FROM recipes').all() as Row[];
}

function dbCount(handle: RecipesDb): number {
  const row = handle.prepare('SELECT COUNT(*) AS n FROM recipes').get() as { n: number };
  return row.n;
}

// ---- In-memory slim index cache (refreshed on writes; cheap even at several thousand rows) ----

let slimCache: RecipeSlim[] | null = null;

function invalidateSlimCache(): void {
  slimCache = null;
}

function rebuildSlimCacheFromDb(handle: RecipesDb): RecipeSlim[] {
  return dbAllRows(handle).map(rowToSlim);
}

// ---- JSON-fallback helpers (sqlite unavailable — operate directly on kitchen.json) --------

function jsonAll(): Recipe[] {
  return kitchenStore.get().recipes;
}

function jsonToSlim(r: Recipe): RecipeSlim {
  const { steps: _steps, ...rest } = r;
  return rest;
}

// ---- Public repository API -----------------------------------------------------------------

/** Full in-memory slim index — the planner/engine/search-fallback source of truth. */
export function listAllSlim(): RecipeSlim[] {
  const handle = db();
  if (handle) {
    if (!slimCache) slimCache = rebuildSlimCacheFromDb(handle);
    return slimCache;
  }
  return jsonAll().map(jsonToSlim);
}

export function count(): number {
  const handle = db();
  if (handle) return dbCount(handle);
  return jsonAll().length;
}

export function exists(id: string): boolean {
  const handle = db();
  if (handle) return handle.prepare('SELECT 1 FROM recipes WHERE id = ?').get(id) != null;
  return jsonAll().some((r) => r.id === id);
}

/** Full recipe (with steps) by id — cook mode / quick-view. */
export function getFull(id: string): Recipe | null {
  const handle = db();
  if (handle) return dbGetFull(handle, id);
  return jsonAll().find((r) => r.id === id) ?? null;
}

export function insertRecipe(recipe: Recipe): void {
  const handle = db();
  if (handle) {
    dbInsertOrReplace(handle, recipe);
    invalidateSlimCache();
    return;
  }
  kitchenStore.update((d) => {
    d.recipes.push(recipe);
  });
}

export function updateRecipe(recipe: Recipe): void {
  const handle = db();
  if (handle) {
    dbInsertOrReplace(handle, recipe);
    invalidateSlimCache();
    return;
  }
  kitchenStore.update((d) => {
    const idx = d.recipes.findIndex((r) => r.id === recipe.id);
    if (idx >= 0) d.recipes[idx] = recipe;
    else d.recipes.push(recipe);
  });
}

export function deleteRecipe(id: string): void {
  const handle = db();
  if (handle) {
    dbDelete(handle, id);
    invalidateSlimCache();
    return;
  }
  kitchenStore.update((d) => {
    d.recipes = d.recipes.filter((r) => r.id !== id);
  });
}

/** Bulk insert (migration + the AI bulk-generation pipeline). Same fallback split as insertRecipe. */
export function bulkInsert(recipes: Recipe[]): void {
  if (!recipes.length) return;
  const handle = db();
  if (handle) {
    const txn = handle.transaction((rows: Recipe[]) => {
      for (const r of rows) dbInsertOrReplace(handle, r);
    });
    txn(recipes);
    invalidateSlimCache();
    return;
  }
  kitchenStore.update((d) => {
    const existing = new Set(d.recipes.map((r) => r.id));
    for (const r of recipes) {
      if (existing.has(r.id)) continue;
      d.recipes.push(r);
      existing.add(r.id);
    }
  });
}

/** Existing titles for a cuisine — cheap dedupe source for the bulk generator. */
export function titlesByCuisine(cuisine: Cuisine): string[] {
  return listAllSlim()
    .filter((r) => r.cuisine === cuisine)
    .map((r) => r.title);
}

export function countByCuisine(): Record<Cuisine, number> {
  const out: Record<Cuisine, number> = { spanish: 0, dutch: 0, japanese: 0, italian: 0, global: 0 };
  for (const r of listAllSlim()) out[r.cuisine] = (out[r.cuisine] ?? 0) + 1;
  return out;
}

// ---- Photo enrichment (docs/47 §3b) ---------------------------------------------------------
// Works identically over sqlite or the JSON fallback — everything here reads/writes through
// listAllSlim()/getFull()/updateRecipe(), same as the rest of this module.

export interface PhotoCoverage {
  total: number;
  withPhoto: number;
}

/** Library card "Photos 812 / 2,047" stat. */
export function photoCoverage(): PhotoCoverage {
  const all = listAllSlim();
  return { total: all.length, withPhoto: all.filter((r) => Boolean(r.photo)).length };
}

/**
 * The next recipe the enrichment coordinator should try — ANY source, photo-null, skipping
 * ones tried in the last `retryAfterMs` (a definitive no-hit isn't retried forever). Stable
 * order (by title) so a restart mid-enrichment resumes predictably rather than jumping
 * around. The photo-null query IS the queue (docs/47 cross-cutting note) — no separate job
 * state to persist or resume.
 */
export function nextPhotoEnrichmentCandidate(now: number, retryAfterMs: number): RecipeSlim | null {
  const all = [...listAllSlim()].sort((a, b) => a.title.localeCompare(b.title));
  for (const r of all) {
    if (r.photo) continue;
    if (r.photoTriedAt) {
      const triedAt = Date.parse(r.photoTriedAt);
      if (Number.isFinite(triedAt) && now - triedAt < retryAfterMs) continue;
    }
    return r;
  }
  return null;
}

/** Store a fetched photo + its attribution, and clear any stale "tried, no hit" marker. */
export function setRecipePhoto(
  id: string,
  photo: string,
  credit: { name: string; url: string; provider: 'openverse' | 'pexels' },
): void {
  const full = getFull(id);
  if (!full) return;
  updateRecipe({ ...full, photo, photoCredit: credit, photoTriedAt: null, updatedAt: new Date().toISOString() });
}

/** Mark a definitive no-hit so the next tick moves on to a different candidate instead of
 *  re-querying the same recipe every 20s forever — re-tried after 30 days (docs/47 §3b). */
export function markPhotoTried(id: string, whenIso: string): void {
  const full = getFull(id);
  if (!full) return;
  updateRecipe({ ...full, photoTriedAt: whenIso });
}

// ---- Search / pagination (docs/46 §2b) -----------------------------------------------------

export interface SearchOpts {
  q?: string;
  cuisine?: Cuisine;
  tag?: string;
  maxMin?: number;
  fish?: boolean;
  veggie?: boolean;
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  items: RecipeSlim[];
  total: number;
  page: number;
  pageSize: number;
}

/** Tokenize a free-text query into safe FTS5 prefix terms ("chick" → `chick*`). */
function ftsQuery(q: string): string | null {
  const terms = q
    .toLowerCase()
    .split(/[^a-z0-9ñáéíóúü]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
    .slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
}

function matchesFilters(r: RecipeSlim, opts: SearchOpts): boolean {
  if (opts.cuisine && r.cuisine !== opts.cuisine) return false;
  if (opts.tag && !r.tags.some((t) => t.toLowerCase() === opts.tag!.toLowerCase())) return false;
  if (opts.maxMin != null && r.prepMin + r.cookMin > opts.maxMin) return false;
  if (opts.fish && !isFishRecipe(r)) return false;
  if (opts.veggie && !isVeggieRecipe(r)) return false;
  return true;
}

function matchesQueryJs(r: RecipeSlim, q: string): boolean {
  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return true;
  const hay = `${r.title} ${r.tags.join(' ')} ${r.cuisine} ${r.ingredients.map((i) => `${i.name} ${i.es}`).join(' ')}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/**
 * Paginated + filtered + (when `q`) FTS-ranked search over the slim index. Works identically
 * whether sqlite is enabled (FTS5 + SQL WHERE) or in JSON-fallback mode (in-memory filter +
 * substring match) — same shape either way, so routes/kitchen.ts and the AI-prompt retrieval
 * helper below don't need to know which backend is live.
 */
export function search(opts: SearchOpts): SearchResult {
  const page = Math.max(1, Math.round(opts.page ?? 1));
  const pageSize = Math.max(1, Math.min(200, Math.round(opts.pageSize ?? 50)));
  const handle = db();

  if (handle && opts.q && opts.q.trim()) {
    // FTS path: rank by bm25, then apply the structured filters in JS (cuisine/tag/maxMin/
    // fish/veggie are cheap booleans over a handful of ids — not worth a second SQL round trip
    // given FTS5 already narrowed the candidate set).
    const match = ftsQuery(opts.q);
    if (match) {
      try {
        const rows = handle
          .prepare(
            `SELECT r.* FROM recipes r JOIN recipes_fts f ON f.id = r.id
             WHERE recipes_fts MATCH ? ORDER BY bm25(recipes_fts) LIMIT 1000`,
          )
          .all(match) as Row[];
        const all = rows.map(rowToSlim).filter((r) => matchesFilters(r, opts));
        const total = all.length;
        const items = all.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
        return { items, total, page, pageSize };
      } catch (e) {
        console.error('[recipes-repo] FTS query failed, falling back to JS filter:', (e as Error).message);
      }
    }
  }

  // No query (browse/filter-only), or FTS unavailable/failed, or JSON-fallback mode: filter the
  // slim index in JS. Sort: query relevance (if any) is already handled above; otherwise stable
  // by title for predictable "browse all" paging.
  const all = listAllSlim().filter(
    (r) => matchesFilters(r, opts) && (!opts.q || !opts.q.trim() || matchesQueryJs(r, opts.q)),
  );
  all.sort((a, b) => a.title.localeCompare(b.title));
  const total = all.length;
  const items = all.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  return { items, total, page, pageSize };
}

/**
 * Retrieval-capped slim pool for AI prompts (docs/46 §2b): AI prompt paths must NEVER embed
 * the full library. Scores every slim recipe by simple keyword overlap with `query` (title +
 * tags + cuisine + ingredient names — the same idiom /plan/ask already used), returns the top
 * `limit` (default 120). Falls back to the first `limit` recipes (stable by title) when the
 * query has no usable words, so the prompt still gets a bounded, sane pool.
 */
export function promptPool(query: string, limit = 120): RecipeSlim[] {
  const all = listAllSlim();
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (!words.length) {
    return [...all].sort((a, b) => a.title.localeCompare(b.title)).slice(0, limit);
  }
  const scored = all.map((r) => {
    const hay = `${r.title} ${r.tags.join(' ')} ${r.cuisine} ${r.ingredients.map((i) => `${i.name} ${i.es}`).join(' ')}`.toLowerCase();
    const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score || a.r.title.localeCompare(b.r.title));
  return scored.slice(0, limit).map((x) => x.r);
}

// ---- Boot migration (docs/46 §2a) -----------------------------------------------------------

export interface MigrationResult {
  migrated: boolean;
  count: number;
  reason?: string;
}

/**
 * Idempotent, fail-safe boot migration: if kitchen.json still has recipes AND sqlite is
 * available, MERGE them into SQLite (INSERT OR REPLACE — unconditional even when the db
 * already has rows, so recipes saved during a sqlite-down fallback-JSON boot are picked up
 * on the next sqlite boot instead of being stripped unseen), back up kitchen.json →
 * kitchen.json.pre-sqlite.bak, then empty the JSON `recipes` array. Safe to call every
 * boot — a no-op once the JSON array is empty. On ANY error, the JSON array is left
 * untouched and this returns migrated:false with a reason — recipes keep working off JSON
 * (this module's fallback path) and the failure is logged loudly by the caller.
 */
export function runBootMigrationIfNeeded(): MigrationResult {
  const handle = db();
  if (!handle) return { migrated: false, count: 0, reason: recipesDbUnavailableReason() };

  const jsonRecipes = jsonAll();
  if (!jsonRecipes.length) return { migrated: false, count: 0, reason: 'kitchen.json has no recipes to migrate' };

  try {
    // ALWAYS run the insert txn, even when sqlite already holds recipes — MERGE semantics.
    // Why unconditional: sqlite can FLAP across boots (native module loads on boot A,
    // fails on boot B, loads again on boot C). During a fallback-JSON boot, new recipes are
    // saved into kitchen.json; on the next sqlite boot BOTH stores have rows. Skipping the
    // txn "because the db already has recipes" would strip those fallback-era recipes from
    // the JSON without ever copying them in — data loss (only the .bak would have them).
    // dbInsertOrReplace is INSERT OR REPLACE, so re-running over already-migrated ids is an
    // idempotent replace and new ids are simply added — unconditional is strictly safe.
    const txn = handle.transaction((rows: Recipe[]) => {
      for (const r of rows) dbInsertOrReplace(handle, r);
    });
    txn(jsonRecipes);
    invalidateSlimCache();

    // Back up kitchen.json BEFORE stripping — belt and braces so the raw recipes are always
    // recoverable even if the strip+persist step below fails partway.
    backupKitchenJson();

    kitchenStore.update((d) => {
      d.recipes = [];
    });

    console.log(`[recipes-repo] migrated ${jsonRecipes.length} recipe(s) from kitchen.json into sqlite`);
    return { migrated: true, count: jsonRecipes.length };
  } catch (e) {
    const reason = (e as Error).message;
    console.error(
      '[recipes-repo] BOOT MIGRATION FAILED — kitchen.json recipes left in place, falling back to JSON mode:',
      reason,
    );
    return { migrated: false, count: 0, reason };
  }
}

function recipesDbUnavailableReason(): string {
  return 'sqlite unavailable for recipes — see recipes-db.ts log line above';
}

function backupKitchenJson(): void {
  const f = kitchenStore.kitchenFilePath();
  if (!existsSync(f)) return; // nothing persisted yet (fresh install) — nothing to back up
  const bak = `${f}.pre-sqlite.bak`;
  const raw = readFileSync(f, 'utf8');
  writeFileSync(bak, raw, 'utf8');
}

/** Test-only: drop every in-memory/handle cache so a fresh RECIPES_DB_FILE/KITCHEN_FILE
 *  env pair is picked up cleanly by the next call. */
export function _resetForTests(): void {
  closeRecipesDb();
  kitchenStore._resetCacheForTests();
  invalidateSlimCache();
}
