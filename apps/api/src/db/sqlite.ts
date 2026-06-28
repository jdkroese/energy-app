// SQLite handle + schema migrations for the circuit-breaker metering store.
//
// Backs the per-breaker usage time-series (spec docs/28 §2/§3). One embedded
// better-sqlite3 database at `.data/metering.db` (the same git-ignored data dir
// as state.json), WAL mode, owned by this single API process.
//
// FAIL-SOFT IS THE WHOLE POINT: the API process also runs the armed battery-
// control loop, so a metering failure must NEVER take it down. `better-sqlite3`
// is a native module that may be missing/unbuildable on a given host, and the DB
// file could fail to open or migrate. Every entry point here is wrapped so that:
//   • a load/open/migrate failure logs once and DISABLES metering (db() → null),
//   • nothing throws at import time,
//   • callers gate on isMeteringEnabled() / a null db() and no-op cleanly.
//
// Path resolution mirrors store.ts / voltage-history.ts:
//   METERING_DB_FILE env override, else co-located with STATE_FILE, else
//   production → /opt/energy/metering.db, else <repoRoot>/.data/metering.db.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

// A require() that works in BOTH the production esbuild CJS bundle AND the tsx/ESM
// dev runner. better-sqlite3 is CJS + native, so it must be loaded via require, not
// dynamic import (we need it synchronously).
//
// In the esbuild CJS bundle a real `require` global exists (and `import.meta.url`
// is undefined → createRequire would throw at load), so prefer the ambient
// require there. Under tsx/ESM there's no `require` global, so fall back to
// createRequire(import.meta.url). Resolved lazily inside loadNativeDb() so nothing
// throws at import time even if both paths somehow fail.
function getNativeRequire(): NodeRequire {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis as any;
  if (typeof g.require === 'function') return g.require as NodeRequire;
  // ESM: import.meta.url is defined here; createRequire needs an absolute path/URL.
  const url = (import.meta as ImportMeta | undefined)?.url;
  if (url) return createRequire(url);
  // Last resort in a CJS context without a global require: derive from __filename.
  if (typeof __filename !== 'undefined') return createRequire(__filename);
  throw new Error('no require available to load native better-sqlite3');
}

// `better-sqlite3` is a native dependency. Require it lazily inside a try/catch so
// a missing/unbuildable binary on the runtime host disables metering gracefully
// instead of crashing the API at import. Typed loosely — we only use a small slice.
type Statement = {
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};
export type MeteringDb = {
  prepare: (sql: string) => Statement;
  exec: (sql: string) => unknown;
  pragma: (s: string) => unknown;
  transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
  close: () => void;
};

const SCHEMA_VERSION = 2;

let initTried = false;
let disabledReason: string | null = null;

/** Resolve the metering DB file path (same data dir as state.json). */
function dbPath(): string {
  if (process.env.METERING_DB_FILE) return process.env.METERING_DB_FILE;
  if (process.env.STATE_FILE) return resolve(dirname(process.env.STATE_FILE), 'metering.db');
  if (process.env.NODE_ENV === 'production') return '/opt/energy/metering.db';
  const repoRoot =
    typeof __dirname !== 'undefined'
      ? resolve(__dirname, '..', '..', '..')
      : resolve(process.cwd(), '..', '..');
  return resolve(repoRoot, '.data', 'metering.db');
}

/**
 * Create the schema (idempotent) + bump the version row.
 *  - cb_* tables: circuit-breaker metering (spec docs/28 §3).
 *  - energy_* tables: whole-house energy history (spec docs/31) — the same one
 *    DB / one handle / one fail-soft path. v2 adds these; all CREATE … IF NOT
 *    EXISTS so re-running on an existing v1 store just adds the new tables.
 *
 * energy_* series mirror HISTORY_SERIES (history5m.ts): power kW
 * (solar/home/charge/discharge/gridImport/gridExport) + SoC %
 * (sonnen/tesla/combined). Hourly/daily integrate kW→kWh and aggregate SoC.
 */
function migrate(handle: MeteringDb): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS cb_meta (k TEXT PRIMARY KEY, v TEXT);

    CREATE TABLE IF NOT EXISTS cb_raw (
      breaker_id      TEXT    NOT NULL,
      ts              INTEGER NOT NULL,
      power_w         REAL,
      voltage_v       REAL,
      current_a       REAL,
      energy_wh       REAL,
      energy_total_wh REAL,
      PRIMARY KEY (breaker_id, ts)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS cb_hourly (
      breaker_id    TEXT    NOT NULL,
      bucket_ts     INTEGER NOT NULL,
      energy_wh     REAL    NOT NULL,
      power_avg_w   REAL,
      power_max_w   REAL,
      voltage_avg_v REAL,
      voltage_min_v REAL,
      voltage_max_v REAL,
      samples       INTEGER NOT NULL,
      PRIMARY KEY (breaker_id, bucket_ts)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS cb_daily (
      breaker_id    TEXT    NOT NULL,
      day           TEXT    NOT NULL,
      energy_wh     REAL    NOT NULL,
      power_avg_w   REAL,
      power_max_w   REAL,
      voltage_avg_v REAL,
      voltage_min_v REAL,
      voltage_max_v REAL,
      samples       INTEGER NOT NULL,
      PRIMARY KEY (breaker_id, day)
    );

    -- ---- Whole-house energy history (spec docs/31) -------------------------
    -- Raw 5-minute samples: kW for power series, % for SoC. Retention 90 days.
    CREATE TABLE IF NOT EXISTS energy_5m (
      ts              INTEGER PRIMARY KEY,   -- unix seconds, 5-min aligned
      solar_kw        REAL,
      home_kw         REAL,
      charge_kw       REAL,
      discharge_kw    REAL,
      grid_import_kw  REAL,
      grid_export_kw  REAL,
      sonnen_soc      REAL,
      tesla_soc       REAL,
      combined_soc    REAL,
      samples         INTEGER NOT NULL
    ) WITHOUT ROWID;

    -- Hourly: power series integrated to kWh over the bucket; SoC avg/min/max.
    -- bucket_ts = hour start (unix seconds). Retention 3 years.
    -- src marks provenance: 'live' (rolled from 5m) or 'tesla-backfill'.
    CREATE TABLE IF NOT EXISTS energy_hourly (
      bucket_ts        INTEGER PRIMARY KEY,
      solar_kwh        REAL,
      home_kwh         REAL,
      charge_kwh       REAL,
      discharge_kwh    REAL,
      grid_import_kwh  REAL,
      grid_export_kwh  REAL,
      sonnen_soc_avg   REAL,
      sonnen_soc_min   REAL,
      sonnen_soc_max   REAL,
      tesla_soc_avg    REAL,
      tesla_soc_min    REAL,
      tesla_soc_max    REAL,
      combined_soc_avg REAL,
      combined_soc_min REAL,
      combined_soc_max REAL,
      samples          INTEGER NOT NULL,
      src              TEXT
    ) WITHOUT ROWID;

    -- Daily: kWh totals per series + SoC avg/min/max. day = Madrid YYYY-MM-DD.
    -- Retention forever.
    CREATE TABLE IF NOT EXISTS energy_daily (
      day              TEXT PRIMARY KEY,
      solar_kwh        REAL,
      home_kwh         REAL,
      charge_kwh       REAL,
      discharge_kwh    REAL,
      grid_import_kwh  REAL,
      grid_export_kwh  REAL,
      sonnen_soc_avg   REAL,
      sonnen_soc_min   REAL,
      sonnen_soc_max   REAL,
      tesla_soc_avg    REAL,
      tesla_soc_min    REAL,
      tesla_soc_max    REAL,
      combined_soc_avg REAL,
      combined_soc_min REAL,
      combined_soc_max REAL,
      samples          INTEGER NOT NULL,
      src              TEXT
    );
  `);
  handle
    .prepare(`INSERT INTO cb_meta (k, v) VALUES ('schema_version', ?)
              ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
    .run(String(SCHEMA_VERSION));
}

/**
 * Open (once) and return the metering DB handle, or null when metering is
 * disabled (native module missing, open/migrate failed). Memoized — a failure is
 * logged once and sticks (db() returns null thereafter) so callers stay quiet.
 */
export function db(): MeteringDb | null {
  if (initTried) return db_;
  initTried = true;
  try {
    // Lazy native require — a missing/unbuildable binary lands here, not at import.
    const Database = getNativeRequire()('better-sqlite3') as new (path: string) => MeteringDb;
    const f = dbPath();
    const dir = dirname(f);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const handle = new Database(f);
    handle.pragma('journal_mode = WAL');
    handle.pragma('synchronous = NORMAL');
    migrate(handle);
    db_ = handle;
    console.log(`[metering] sqlite opened at ${f} (schema v${SCHEMA_VERSION})`);
  } catch (e) {
    disabledReason = (e as Error).message;
    db_ = null;
    console.error('[metering] DISABLED — sqlite init failed:', disabledReason);
  }
  return db_;
}
let db_: MeteringDb | null = null;

/** Whether the metering store is healthy and usable. */
export function isMeteringEnabled(): boolean {
  return db() !== null;
}

/** Why metering is disabled (for diagnostics), or null when enabled. */
export function meteringDisabledReason(): string | null {
  db(); // ensure init attempted
  return disabledReason;
}

// ---- cb_meta cursor helpers (rollup reconcile cursors live here) ------------

/** Read a cb_meta value, or null when absent / DB unavailable. */
export function getMeta(key: string): string | null {
  const h = db();
  if (!h) return null;
  try {
    const row = h.prepare('SELECT v FROM cb_meta WHERE k = ?').get(key) as { v?: string } | undefined;
    return row?.v ?? null;
  } catch {
    return null;
  }
}

/** Upsert a cb_meta value. No-op when the DB is unavailable. */
export function setMeta(key: string, value: string): void {
  const h = db();
  if (!h) return;
  try {
    h.prepare(`INSERT INTO cb_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(key, value);
  } catch {
    /* fail-soft */
  }
}

/** Close the handle (tests / shutdown). Safe to call when never opened. */
export function closeMeteringDb(): void {
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
