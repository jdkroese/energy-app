# 31 — Energy history retention upgrade (30 days → 3 years, tiered SQLite)

**Owner ask (2026-06-28):** the 5-minute energy history is 30-day rolling — too short. Need **3-year
retention**. Defaults chosen by orchestrator (owner dismissed the option popups → proceed sensibly):
**backfill from Tesla now + Datadis later; keep 5-min for 90 days, hourly for 3 years, daily forever.**

Single responsive React app + Node/TS API. Follow CLAUDE.md (web AND mobile; Power design system;
typecheck + build before merge). **Standing git rule:** own worktree, own branch off origin/main,
PR only, NEVER push to main. This is **additive + read-only** (no battery/control/armed path) → a
normal deploy preserves armed state. **Fail-soft is mandatory** — the API runs the armed battery
loop; a history/DB failure must log + degrade, never crash a tick.

## Reuse — the infra already exists (do NOT rebuild)

The breaker-metering system (PR #92, `docs/28`) already solved tiered 3-year retention:
- `apps/api/src/db/sqlite.ts` — fail-soft `better-sqlite3` handle (WAL, `synchronous=NORMAL`),
  `migrate()` with `SCHEMA_VERSION`, `db()`→null when unavailable, `isMeteringEnabled()`, cb_meta
  cursor helpers. The native dep is already vendored into `dist` by `apps/api/build.mjs`.
- `apps/api/src/control/breaker-metering.ts` — the sampler + **raw/hourly/daily rollups + Madrid-local
  day buckets + retention prune** pattern to mirror.
- `apps/api/src/history5m.ts` — the current JSON 5-min recorder (30-day) + the Madrid time helpers
  `madridDateKey()` / `madridBucketIndex()` (export-reuse these, don't duplicate).
- `apps/api/src/routes/history.ts` — Reports cost calc; today pulls Tesla `calendar_history` LIVE per
  request and splits import to bands by `bandHourWeights()` — a weekly-average APPROXIMATION.

## Key synergy (design around it)

**Hourly buckets are hour-aligned, and so are the P1/P2/P3 bands** (Europe/Madrid). So an hourly
grid-import history yields **EXACT per-band consumption** via `bandForHour(hour, weekday)` per row —
no weighting approximation. This one store is the backbone for BOTH this 3-year ask AND the invoice
feature's "real per-band history" need (`docs/30`). Datadis (invoice Phase 2) later writes
authoritative grid-import-per-hour into the SAME hourly store, refining it.

## Storage design — extend the SQLite store (same `metering.db`, same handle)

Bump `SCHEMA_VERSION` → 2; add tables in `migrate()` (idempotent `CREATE TABLE IF NOT EXISTS`).
One DB, one handle, one fail-soft path. Series mirror `HISTORY_SERIES` (solar/home/charge/discharge/
gridImport/gridExport kW + sonnen/tesla/combined SoC).

- `energy_5m` (raw): `ts INTEGER PK`, per-series REAL (kW for power, % for SoC). Retention **90 days**.
- `energy_hourly`: `bucket_ts INTEGER PK` (hour start, Madrid-aligned epoch). Store **energy kWh**
  integrated per power series (solar/home/charge/discharge/gridImport/gridExport) + SoC avg/min/max +
  `samples`. Retention **3 years**. (Per-band is computed on read via `bandForHour`, NOT stored.)
- `energy_daily`: `day TEXT PK` (Madrid YYYY-MM-DD). Daily kWh totals per series + SoC avg/min/max +
  `samples`. Retention **forever**.
- Add a `source` notion where it matters (e.g. grid import may come from `live`, `tesla-backfill`,
  or `datadis`) so Datadis can later supersede backfilled estimates — a `meta`/cursor row or a
  per-row `src` column on hourly; keep it simple.

## Scope of THIS change

### 1. Recorder + rollups  `apps/api/src/control/energy-history.ts` (new, mirrors breaker-metering.ts)
- On each live sample (same call site that feeds `history5m.record()` today), upsert into `energy_5m`
  (running average within the 5-min bucket, like the JSON recorder does).
- Hourly + daily rollups from the tier below (reconcile-cursor in cb_meta, like the breaker rollups):
  integrate kW→kWh over the bucket, SoC avg/min/max, `samples`. Idempotent upserts keyed by bucket.
- Retention prune per tier (5m>90d, hourly>3y, daily never). Prune on rollup, not on read.
- **Fail-soft:** every entry point try/caught; gate on `db()`/`isMeteringEnabled()`; never throw.
- **Keep `history5m.ts` JSON as the fallback** for the DayChart when SQLite is disabled (so the day
  view never goes blank). Dual-write during transition is fine, or read-through with JSON fallback.

### 2. One-time migration + Tesla backfill  `apps/api/src/control/energy-backfill.ts`
- Import the existing `.data/history-5m.json` (up to 30 days) into `energy_5m` once (cursor flag in
  cb_meta so it runs once). Then roll those up.
- **Tesla backfill:** on boot, if hourly/daily history is empty or starts later than Tesla has data,
  pull `tesla.getCalendarHistory('energy', period)` for `year`/`month`/`week` and seed
  `energy_hourly`/`energy_daily` (solar, home, gridImport, gridExport, battery charge/discharge)
  from the `EnergyRow` fields already mapped in `routes/history.ts` (`rowImport`/`rowExport`/
  `rowSolar`/`rowHome`). Idempotent (upsert by bucket); tag `source='tesla-backfill'`. Tesla holds
  data back toward install. **Caveats to log:** Tesla aggregates are coarser the further back (year
  ≈ every 2h), and SoC history isn't in calendar_history — backfilled rows carry energy, SoC null.
  Run backfill in the background, never blocking startup or the control loop.
- (Datadis grid-import-per-band backfill = invoice Phase 2, deferred until NIF verification; it will
  write into `energy_hourly` and supersede `tesla-backfill` grid import where present.)

### 3. Reads — serve Reports/charts from the durable store  `apps/api/src/routes/history.ts`
- Range → tier: `day`/`hour` → `energy_5m`; `week`/`month` → `energy_hourly`; `year` (+ multi-year)
  → `energy_daily`. Read from SQLite instead of a live Tesla call per request (faster; works offline;
  3 years deep). Fall back to the existing live Tesla path if the store is unavailable/empty.
- **Replace the `bandHourWeights()` approximation with EXACT per-band**: sum hourly grid-import kWh
  grouped by `bandForHour(hourOf(bucket), weekdayOf(bucket))`. Keep the weighting approximation only
  as a labelled fallback when reading from a tier without hour resolution. Update the code comment +
  any UI "estimated/approximation" caption where it's now exact.
- Keep `series`/`totals`/`byBand`/`byLoad` response shape stable so the web side keeps working.

### 4. Wiring + API
- Start the energy-history recorder/rollup + kick the one-time migration & Tesla backfill from the
  same place `history5m`/metering are started in `apps/api/src/index.ts` (guarded, fail-soft, after
  the control loop is up). Backfill runs async.
- Optional `GET /api/history/range?from=&to=&res=` for arbitrary windows (reads the right tier) —
  only if cheap; otherwise leave the existing range param.

### 5. Web (web AND mobile — Power design system)
- The existing Reports ranges (day/week/month/year) must now read 3 years deep off the durable store
  — verify year (and beyond) renders with backfilled data. If a simple **multi-year / "all" selector**
  or year-stepper is low-effort on the existing Reports range control, add it; otherwise note it as a
  follow-up (don't over-build the picker this round). Per-band now EXACT — drop the "approximation"
  caption where applicable. Verify BOTH viewports (≥768px and <768px).

## Acceptance
- `pnpm --filter @energy/api typecheck` + `pnpm --filter @energy/web typecheck && build` clean.
- New tables created via migration (schema v2); existing 30-day JSON history imported once; recorder
  writes 5m + rolls up hourly/daily; retention prunes per tier.
- Tesla backfill seeds historical hourly/daily (spot-check a past month returns non-empty, plausible
  totals); idempotent across restarts (no double-count).
- Reports week/month/year read from the store and return EXACT per-band grid import (hour-bucketed),
  not the weighting approximation; day view still renders (5m, with JSON fallback if SQLite off).
- **Fail-soft proven:** with SQLite disabled (simulate `db()`→null), the API still boots, the control
  loop runs, and the DayChart falls back to JSON — nothing throws.
- Zero changes to control/coordinator/guardrail/armed code paths.

## Out of scope
- Datadis (invoice Phase 2) — deferred to NIF verification; will write grid-import-per-band here.
- Per-breaker metering — already shipped (PR #92); untouched.
- A full custom date-range analytics UI — minimal range support only this round.
- No control/battery logic changes anywhere.

## Coordination note (concurrent agents)
The invoice Phase 1 agent (branch `invoice-tracking`, `docs/30`) is in flight. Overlap is low — it
uses a JSON invoices store + a Reports SUB-TAB + `routes/invoices.ts`; this work touches
`db/sqlite.ts`, `history5m.ts`, a new `energy-history.ts`/`energy-backfill.ts`, and `routes/history.ts`
(the cost calc — invoice agent should NOT touch that). The shared-risk file is the Reports screen.
Whoever merges second rebases on origin/main. Do NOT commit the other session's files.
