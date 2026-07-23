// SQLite handle for the recipe library at scale (docs/46 §2a). A SEPARATE embedded
// better-sqlite3 database (.data/recipes.db) from both state.json and metering.db — recipes
// are a distinct, larger-volume concern (~2,000 rows w/ JSON columns + FTS5) and keeping
// them in their own file means a recipes-db problem can never touch metering/energy history
// or vice versa.
//
// FAIL-SOFT IS THE WHOLE POINT (mirrors db/sqlite.ts exactly): the API process also runs the
// armed battery-control loop, so ANY failure here (missing native binary, corrupt file, full
// disk) must never throw into a request path or the boot sequence. Every entry point is
// wrapped so that:
//   • a load/open/migrate failure logs ONCE and disables the sqlite path (db() → null),
//   • nothing throws at import time,
//   • callers (recipes-repo.ts) gate on isRecipesDbEnabled() and fall back to the JSON store
//     (kitchen/store.ts's `recipes` array) so the app behaves exactly as it did pre-P2.
//
// Path resolution mirrors db/sqlite.ts / store.ts: RECIPES_DB_FILE env override, else
// co-located with STATE_FILE, else production → /opt/energy/recipes.db, else
// <repoRoot>/.data/recipes.db.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

function getNativeRequire(): NodeRequire {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis as any;
  if (typeof g.require === 'function') return g.require as NodeRequire;
  const url = (import.meta as ImportMeta | undefined)?.url;
  if (url) return createRequire(url);
  if (typeof __filename !== 'undefined') return createRequire(__filename);
  throw new Error('no require available to load native better-sqlite3');
}

type Statement = {
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};
export type RecipesDb = {
  prepare: (sql: string) => Statement;
  exec: (sql: string) => unknown;
  pragma: (s: string) => unknown;
  transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
  close: () => void;
};

const SCHEMA_VERSION = 3;

let initTried = false;
let disabledReason: string | null = null;
let db_: RecipesDb | null = null;

function dbPath(): string {
  if (process.env.RECIPES_DB_FILE) return process.env.RECIPES_DB_FILE;
  if (process.env.STATE_FILE) return resolve(dirname(process.env.STATE_FILE), 'recipes.db');
  if (process.env.NODE_ENV === 'production') return '/opt/energy/recipes.db';
  const repoRoot =
    typeof __dirname !== 'undefined' ? resolve(__dirname, '..', '..', '..') : resolve(process.cwd(), '..', '..');
  return resolve(repoRoot, '.data', 'recipes.db');
}

/** True when `table` already has `column` — guards the additive ALTERs below so re-running
 *  migrate() on every boot (already the existing contract) stays idempotent instead of
 *  throwing "duplicate column name" on the second+ boot. */
function columnExists(handle: RecipesDb, table: string, column: string): boolean {
  const rows = handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function migrate(handle: RecipesDb): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS recipes_meta (k TEXT PRIMARY KEY, v TEXT);

    CREATE TABLE IF NOT EXISTS recipes (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      cuisine           TEXT NOT NULL,
      photo             TEXT,
      source            TEXT NOT NULL,
      source_url        TEXT,
      servings_base     INTEGER NOT NULL,
      prep_min          INTEGER NOT NULL,
      cook_min          INTEGER NOT NULL,
      tags_json         TEXT NOT NULL,
      kid_score         REAL,
      season_json       TEXT,
      nutrition_json    TEXT,
      tools_json        TEXT NOT NULL,
      ingredients_json  TEXT NOT NULL,
      steps_json        TEXT NOT NULL,
      last_cooked_at    TEXT,
      ratings_json      TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      is_fish           INTEGER NOT NULL DEFAULT 0,
      is_veggie         INTEGER NOT NULL DEFAULT 0,
      veg_rich          REAL NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_recipes_cuisine ON recipes(cuisine);
    CREATE INDEX IF NOT EXISTS idx_recipes_total_min ON recipes(prep_min, cook_min);
    CREATE INDEX IF NOT EXISTS idx_recipes_fish ON recipes(is_fish);
    CREATE INDEX IF NOT EXISTS idx_recipes_veggie ON recipes(is_veggie);

    -- FTS5 over title + tags + ingredient names (ES+EN) — kept in sync by recipes-repo.ts
    -- on every insert/update/delete (small volume, no triggers needed). Standalone table
    -- (not content-linked) so a row can be deleted/reinserted independent of the main table.
    CREATE VIRTUAL TABLE IF NOT EXISTS recipes_fts USING fts5(
      id UNINDEXED, title, tags, ingredients, tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  // Schema v2 (docs/47 §3b, photo enrichment) — additive columns only, guarded so this is
  // safe to run unconditionally on every boot regardless of which schema version the file
  // was created at.
  if (!columnExists(handle, 'recipes', 'photo_credit_json')) {
    handle.exec(`ALTER TABLE recipes ADD COLUMN photo_credit_json TEXT`);
  }
  if (!columnExists(handle, 'recipes', 'photo_tried_at')) {
    handle.exec(`ALTER TABLE recipes ADD COLUMN photo_tried_at TEXT`);
  }

  // Schema v3 (docs/48 §4b, local photo cache) — one additive column so "cached / total"
  // coverage and the backfill-queue priority are cheap + indexable, instead of a JS scan of
  // every recipe's `photo` string on every status poll. Guarded exactly like v2's ALTERs.
  // Recomputed from the CURRENT `photo` value on every insert/update (recipes-repo.ts's
  // toRow()) — this migration only needs to BACKFILL it once for rows written before this
  // column existed; every future write keeps it correct automatically.
  if (!columnExists(handle, 'recipes', 'photo_cached')) {
    handle.exec(`ALTER TABLE recipes ADD COLUMN photo_cached INTEGER NOT NULL DEFAULT 0`);
    handle.exec(`UPDATE recipes SET photo_cached = CASE WHEN photo LIKE '/%' THEN 1 ELSE 0 END`);
    handle.exec(`CREATE INDEX IF NOT EXISTS idx_recipes_photo_cached ON recipes(photo_cached)`);
  }

  handle
    .prepare(`INSERT INTO recipes_meta (k, v) VALUES ('schema_version', ?)
              ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
    .run(String(SCHEMA_VERSION));
}

/** Open (once) and return the recipes DB handle, or null when disabled. Memoized. */
export function db(): RecipesDb | null {
  if (initTried) return db_;
  initTried = true;
  try {
    const Database = getNativeRequire()('better-sqlite3') as new (path: string) => RecipesDb;
    const f = dbPath();
    const dir = dirname(f);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const handle = new Database(f);
    handle.pragma('journal_mode = WAL');
    handle.pragma('synchronous = NORMAL');
    migrate(handle);
    db_ = handle;
    console.log(`[recipes-db] sqlite opened at ${f} (schema v${SCHEMA_VERSION})`);
  } catch (e) {
    disabledReason = (e as Error).message;
    db_ = null;
    console.error('[recipes-db] DISABLED — sqlite init failed, falling back to kitchen.json for recipes:', disabledReason);
  }
  return db_;
}

export function isRecipesDbEnabled(): boolean {
  return db() !== null;
}

/** Close the handle (tests only). Safe to call when never opened. */
export function closeRecipesDb(): void {
  if (db_) {
    try {
      db_.close();
    } catch {
      /* ignore */
    }
  }
  db_ = null;
  initTried = false;
  disabledReason = null;
}
