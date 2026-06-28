// Whole-house energy history — durable tiered store (spec docs/31).
//
// Mirrors breaker-metering.ts: a raw 5-minute recorder + hourly/daily rollups +
// per-tier retention, all on the SAME fail-soft SQLite handle (db/sqlite.ts).
// Where breaker-metering meters per-breaker Tuya power, this records the SAME
// whole-house live snapshot that feeds history5m.record() — solar/home/battery
// charge+discharge/grid import+export (kW) and Sonnen/Tesla/combined SoC (%).
//
// ADDITIVE + READ-ONLY: it touches no control/armed/battery code path. It reads
// the live sample handed to record() and writes only its own energy_* tables.
// FAIL-SOFT: every entry point is try/caught and gates on db(); a fault logs once
// and degrades (the DayChart still falls back to history5m's JSON) — it can NEVER
// throw into the armed control loop that shares this process.
//
// Tiers (spec docs/31):
//   energy_5m      raw 5-min samples (running avg in-bucket)   retain 90 days
//   energy_hourly  kWh-integrated per power series + SoC stats  retain 3 years
//   energy_daily   daily kWh totals + SoC stats                 retain forever

import { db, getMeta, setMeta, type MeteringDb } from '../db/sqlite';
import { HISTORY_SERIES, type HistorySample, madridDateKey } from '../history5m';

// ---- Series mapping ---------------------------------------------------------
// HISTORY_SERIES order: solarKw, homeKw, chargeKw, dischargeKw, gridImportKw,
// gridExportKw, sonnenSoc, teslaSoc, combinedSoc.

const POWER_SERIES = ['solarKw', 'homeKw', 'chargeKw', 'dischargeKw', 'gridImportKw', 'gridExportKw'] as const;
const SOC_SERIES = ['sonnenSoc', 'teslaSoc', 'combinedSoc'] as const;

// energy_5m column per HISTORY_SERIES key.
const COL_5M: Record<(typeof HISTORY_SERIES)[number], string> = {
  solarKw: 'solar_kw',
  homeKw: 'home_kw',
  chargeKw: 'charge_kw',
  dischargeKw: 'discharge_kw',
  gridImportKw: 'grid_import_kw',
  gridExportKw: 'grid_export_kw',
  sonnenSoc: 'sonnen_soc',
  teslaSoc: 'tesla_soc',
  combinedSoc: 'combined_soc',
};

// Power kWh column (hourly/daily) per power series key.
const KWH_COL: Record<(typeof POWER_SERIES)[number], string> = {
  solarKw: 'solar_kwh',
  homeKw: 'home_kwh',
  chargeKw: 'charge_kwh',
  dischargeKw: 'discharge_kwh',
  gridImportKw: 'grid_import_kwh',
  gridExportKw: 'grid_export_kwh',
};

// SoC stat column prefix per SoC series key.
const SOC_PREFIX: Record<(typeof SOC_SERIES)[number], string> = {
  sonnenSoc: 'sonnen_soc',
  teslaSoc: 'tesla_soc',
  combinedSoc: 'combined_soc',
};

// ---- Tunables ---------------------------------------------------------------

const FIVE_MIN_SEC = 300;
const HOUR_SEC = 3600;
const ROLLUP_MS = 5 * 60 * 1000; // reconcile rollups every 5 min (cheap, idempotent)

// Retention (spec docs/31): 5m 90d, hourly 3y, daily forever.
const RAW_RETENTION_SEC = 90 * 24 * 3600;
const HOURLY_RETENTION_SEC = 3 * 365 * 24 * 3600;

const TZ = 'Europe/Madrid';

// ---- Recorder (energy_5m) ---------------------------------------------------

/** 5-minute-aligned unix seconds for `nowMs`. */
function bucket5mTs(nowMs: number): number {
  return Math.floor(nowMs / (FIVE_MIN_SEC * 1000)) * FIVE_MIN_SEC;
}

/**
 * Record one live snapshot into its 5-minute energy_5m bucket (running average
 * per series, matching the JSON recorder). Idempotent within a bucket. Fail-soft:
 * a null DB or any error no-ops — history5m's JSON remains the source of truth.
 */
export function recordEnergySample(sample: HistorySample): void {
  const handle = db();
  if (!handle) return;
  try {
    const ts = bucket5mTs(Date.now());
    const prev = handle.prepare('SELECT * FROM energy_5m WHERE ts = ?').get(ts) as
      | (Record<string, number | null> & { samples: number })
      | undefined;
    const n = prev?.samples ?? 0;
    const next: Record<string, number> = { ts, samples: n + 1 };
    for (const k of HISTORY_SERIES) {
      const col = COL_5M[k];
      const prior = prev ? prev[col] : null;
      const base = typeof prior === 'number' ? prior : 0;
      next[col] = (base * n + sample[k]) / (n + 1);
    }
    handle
      .prepare(
        `INSERT INTO energy_5m
           (ts, solar_kw, home_kw, charge_kw, discharge_kw, grid_import_kw, grid_export_kw,
            sonnen_soc, tesla_soc, combined_soc, samples)
         VALUES
           (@ts, @solar_kw, @home_kw, @charge_kw, @discharge_kw, @grid_import_kw, @grid_export_kw,
            @sonnen_soc, @tesla_soc, @combined_soc, @samples)
         ON CONFLICT(ts) DO UPDATE SET
           solar_kw = excluded.solar_kw, home_kw = excluded.home_kw,
           charge_kw = excluded.charge_kw, discharge_kw = excluded.discharge_kw,
           grid_import_kw = excluded.grid_import_kw, grid_export_kw = excluded.grid_export_kw,
           sonnen_soc = excluded.sonnen_soc, tesla_soc = excluded.tesla_soc,
           combined_soc = excluded.combined_soc, samples = excluded.samples`,
      )
      .run(next);
  } catch (e) {
    console.error('[energy-history] 5m record failed:', (e as Error).message);
  }
}

// ---- Backfill write helpers (energy-backfill.ts) ----------------------------

/**
 * Upsert a raw 5m row at an EXPLICIT bucket ts (for the one-time JSON import).
 * Unlike recordEnergySample it does not running-average — it sets the bucket to
 * the imported values directly (the JSON already holds the day's averaged value).
 * Idempotent by ts. Caller must pass a 5-min-aligned ts. Fail-soft.
 */
export function upsertRaw5m(
  handle: MeteringDb,
  ts: number,
  values: Record<(typeof HISTORY_SERIES)[number], number | null>,
  samples: number,
): void {
  handle
    .prepare(
      `INSERT INTO energy_5m
         (ts, solar_kw, home_kw, charge_kw, discharge_kw, grid_import_kw, grid_export_kw,
          sonnen_soc, tesla_soc, combined_soc, samples)
       VALUES
         (@ts, @solar_kw, @home_kw, @charge_kw, @discharge_kw, @grid_import_kw, @grid_export_kw,
          @sonnen_soc, @tesla_soc, @combined_soc, @samples)
       ON CONFLICT(ts) DO NOTHING`,
    )
    .run({
      ts,
      solar_kw: values.solarKw,
      home_kw: values.homeKw,
      charge_kw: values.chargeKw,
      discharge_kw: values.dischargeKw,
      grid_import_kw: values.gridImportKw,
      grid_export_kw: values.gridExportKw,
      sonnen_soc: values.sonnenSoc,
      tesla_soc: values.teslaSoc,
      combined_soc: values.combinedSoc,
      samples: Math.max(1, samples),
    });
}

/** Power-series kWh values for a backfilled hourly/daily bucket (SoC null). */
export interface BackfillEnergyKwh {
  solarKwh: number;
  homeKwh: number;
  gridImportKwh: number;
  gridExportKwh: number;
  chargeKwh: number;
  dischargeKwh: number;
}

/**
 * Upsert a backfilled hourly bucket (src='tesla-backfill'). SoC columns stay null
 * (calendar_history has no SoC). Idempotent by bucket_ts — but it does NOT
 * overwrite a row already sourced from 'live' (live rollups are authoritative).
 */
export function upsertHourlyBackfill(handle: MeteringDb, bucketTs: number, e: BackfillEnergyKwh): void {
  handle
    .prepare(
      `INSERT INTO energy_hourly
         (bucket_ts, solar_kwh, home_kwh, charge_kwh, discharge_kwh, grid_import_kwh, grid_export_kwh,
          sonnen_soc_avg, sonnen_soc_min, sonnen_soc_max,
          tesla_soc_avg, tesla_soc_min, tesla_soc_max,
          combined_soc_avg, combined_soc_min, combined_soc_max, samples, src)
       VALUES
         (@bucket_ts, @solar_kwh, @home_kwh, @charge_kwh, @discharge_kwh, @grid_import_kwh, @grid_export_kwh,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 'tesla-backfill')
       ON CONFLICT(bucket_ts) DO UPDATE SET
         solar_kwh = excluded.solar_kwh, home_kwh = excluded.home_kwh,
         charge_kwh = excluded.charge_kwh, discharge_kwh = excluded.discharge_kwh,
         grid_import_kwh = excluded.grid_import_kwh, grid_export_kwh = excluded.grid_export_kwh,
         src = 'tesla-backfill'
       WHERE energy_hourly.src = 'tesla-backfill'`,
    )
    .run({
      bucket_ts: bucketTs,
      solar_kwh: r3(e.solarKwh),
      home_kwh: r3(e.homeKwh),
      charge_kwh: r3(e.chargeKwh),
      discharge_kwh: r3(e.dischargeKwh),
      grid_import_kwh: r3(e.gridImportKwh),
      grid_export_kwh: r3(e.gridExportKwh),
    });
}

/**
 * Upsert a backfilled daily bucket (src='tesla-backfill'), for coarse year-range
 * Tesla data that we keep at daily resolution. SoC null. Does NOT overwrite a
 * 'live' day. Idempotent by day.
 */
export function upsertDailyBackfill(handle: MeteringDb, day: string, e: BackfillEnergyKwh): void {
  handle
    .prepare(
      `INSERT INTO energy_daily
         (day, solar_kwh, home_kwh, charge_kwh, discharge_kwh, grid_import_kwh, grid_export_kwh,
          sonnen_soc_avg, sonnen_soc_min, sonnen_soc_max,
          tesla_soc_avg, tesla_soc_min, tesla_soc_max,
          combined_soc_avg, combined_soc_min, combined_soc_max, samples, src)
       VALUES
         (@day, @solar_kwh, @home_kwh, @charge_kwh, @discharge_kwh, @grid_import_kwh, @grid_export_kwh,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 'tesla-backfill')
       ON CONFLICT(day) DO UPDATE SET
         solar_kwh = excluded.solar_kwh, home_kwh = excluded.home_kwh,
         charge_kwh = excluded.charge_kwh, discharge_kwh = excluded.discharge_kwh,
         grid_import_kwh = excluded.grid_import_kwh, grid_export_kwh = excluded.grid_export_kwh,
         src = 'tesla-backfill'
       WHERE energy_daily.src = 'tesla-backfill'`,
    )
    .run({
      day,
      solar_kwh: r3(e.solarKwh),
      home_kwh: r3(e.homeKwh),
      charge_kwh: r3(e.chargeKwh),
      discharge_kwh: r3(e.dischargeKwh),
      grid_import_kwh: r3(e.gridImportKwh),
      grid_export_kwh: r3(e.gridExportKwh),
    });
}

// ---- Hourly rollup (energy_5m → energy_hourly) ------------------------------
// kW→kWh: each completed 5-min bucket holds an average kW; its energy is
// avg_kW × (5/60) h. The hour's kWh is the sum of its 5-min buckets' energy.

const PER_5M_H = FIVE_MIN_SEC / 3600; // 5 min in hours

interface HourlyAgg {
  bucket_ts: number;
  samples: number;
  solar_kwh: number; home_kwh: number; charge_kwh: number;
  discharge_kwh: number; grid_import_kwh: number; grid_export_kwh: number;
  sonnen_soc_avg: number | null; sonnen_soc_min: number | null; sonnen_soc_max: number | null;
  tesla_soc_avg: number | null; tesla_soc_min: number | null; tesla_soc_max: number | null;
  combined_soc_avg: number | null; combined_soc_min: number | null; combined_soc_max: number | null;
}

function hourlyUpsert(handle: MeteringDb) {
  return handle.prepare(
    `INSERT INTO energy_hourly
       (bucket_ts, solar_kwh, home_kwh, charge_kwh, discharge_kwh, grid_import_kwh, grid_export_kwh,
        sonnen_soc_avg, sonnen_soc_min, sonnen_soc_max,
        tesla_soc_avg, tesla_soc_min, tesla_soc_max,
        combined_soc_avg, combined_soc_min, combined_soc_max, samples, src)
     VALUES
       (@bucket_ts, @solar_kwh, @home_kwh, @charge_kwh, @discharge_kwh, @grid_import_kwh, @grid_export_kwh,
        @sonnen_soc_avg, @sonnen_soc_min, @sonnen_soc_max,
        @tesla_soc_avg, @tesla_soc_min, @tesla_soc_max,
        @combined_soc_avg, @combined_soc_min, @combined_soc_max, @samples, 'live')
     ON CONFLICT(bucket_ts) DO UPDATE SET
       solar_kwh = excluded.solar_kwh, home_kwh = excluded.home_kwh,
       charge_kwh = excluded.charge_kwh, discharge_kwh = excluded.discharge_kwh,
       grid_import_kwh = excluded.grid_import_kwh, grid_export_kwh = excluded.grid_export_kwh,
       sonnen_soc_avg = excluded.sonnen_soc_avg, sonnen_soc_min = excluded.sonnen_soc_min,
       sonnen_soc_max = excluded.sonnen_soc_max,
       tesla_soc_avg = excluded.tesla_soc_avg, tesla_soc_min = excluded.tesla_soc_min,
       tesla_soc_max = excluded.tesla_soc_max,
       combined_soc_avg = excluded.combined_soc_avg, combined_soc_min = excluded.combined_soc_min,
       combined_soc_max = excluded.combined_soc_max,
       samples = excluded.samples, src = 'live'`,
  );
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function r2(n: number | null): number | null {
  return n == null ? null : Math.round(n * 100) / 100;
}

/**
 * Roll completed hours of energy_5m → energy_hourly. Only hours strictly before
 * the current hour are rolled (the active hour keeps accumulating), from the
 * saved cursor forward. Idempotent upsert; cursor persisted in cb_meta.
 */
function rollupHourly(handle: MeteringDb, nowSec: number): void {
  const curHourStart = Math.floor(nowSec / HOUR_SEC) * HOUR_SEC;
  const cursor = Number(getMeta('energy_hourly_cursor') ?? 0);
  const fromExclusive = Number.isFinite(cursor) ? cursor : 0;

  // Aggregate each completed hour from its 5-min buckets. SUM(power)*PER_5M_H
  // integrates kW→kWh; AVG/MIN/MAX over SoC. samples = Σ raw samples.
  const rows = handle
    .prepare(
      `SELECT (ts / ${HOUR_SEC}) * ${HOUR_SEC}     AS bucket_ts,
              SUM(COALESCE(solar_kw, 0))           AS solar_sum,
              SUM(COALESCE(home_kw, 0))            AS home_sum,
              SUM(COALESCE(charge_kw, 0))          AS charge_sum,
              SUM(COALESCE(discharge_kw, 0))       AS discharge_sum,
              SUM(COALESCE(grid_import_kw, 0))     AS grid_import_sum,
              SUM(COALESCE(grid_export_kw, 0))     AS grid_export_sum,
              AVG(sonnen_soc)                      AS sonnen_soc_avg,
              MIN(sonnen_soc)                      AS sonnen_soc_min,
              MAX(sonnen_soc)                      AS sonnen_soc_max,
              AVG(tesla_soc)                       AS tesla_soc_avg,
              MIN(tesla_soc)                       AS tesla_soc_min,
              MAX(tesla_soc)                       AS tesla_soc_max,
              AVG(combined_soc)                    AS combined_soc_avg,
              MIN(combined_soc)                    AS combined_soc_min,
              MAX(combined_soc)                    AS combined_soc_max,
              COUNT(*)                             AS samples
         FROM energy_5m
        WHERE ts >= ? AND ts < ?
        GROUP BY bucket_ts`,
    )
    .all(fromExclusive, curHourStart) as Array<{
    bucket_ts: number;
    solar_sum: number; home_sum: number; charge_sum: number;
    discharge_sum: number; grid_import_sum: number; grid_export_sum: number;
    sonnen_soc_avg: number | null; sonnen_soc_min: number | null; sonnen_soc_max: number | null;
    tesla_soc_avg: number | null; tesla_soc_min: number | null; tesla_soc_max: number | null;
    combined_soc_avg: number | null; combined_soc_min: number | null; combined_soc_max: number | null;
    samples: number;
  }>;

  if (rows.length === 0) {
    if (curHourStart > fromExclusive) setMeta('energy_hourly_cursor', String(curHourStart));
    return;
  }

  const upsert = hourlyUpsert(handle);
  const tx = handle.transaction((batch: typeof rows) => {
    for (const r of batch) {
      const agg: HourlyAgg = {
        bucket_ts: r.bucket_ts,
        samples: r.samples,
        solar_kwh: r3(r.solar_sum * PER_5M_H),
        home_kwh: r3(r.home_sum * PER_5M_H),
        charge_kwh: r3(r.charge_sum * PER_5M_H),
        discharge_kwh: r3(r.discharge_sum * PER_5M_H),
        grid_import_kwh: r3(r.grid_import_sum * PER_5M_H),
        grid_export_kwh: r3(r.grid_export_sum * PER_5M_H),
        sonnen_soc_avg: r2(r.sonnen_soc_avg), sonnen_soc_min: r2(r.sonnen_soc_min), sonnen_soc_max: r2(r.sonnen_soc_max),
        tesla_soc_avg: r2(r.tesla_soc_avg), tesla_soc_min: r2(r.tesla_soc_min), tesla_soc_max: r2(r.tesla_soc_max),
        combined_soc_avg: r2(r.combined_soc_avg), combined_soc_min: r2(r.combined_soc_min), combined_soc_max: r2(r.combined_soc_max),
      };
      upsert.run(agg);
    }
  });
  tx(rows);
  setMeta('energy_hourly_cursor', String(curHourStart));
}

// ---- Daily rollup (energy_hourly → energy_daily) ----------------------------

/** Local Europe/Madrid YYYY-MM-DD for a unix-seconds instant. */
function localDay(unixSec: number): string {
  return madridDateKey(new Date(unixSec * 1000));
}

interface DailyAcc {
  day: string;
  samples: number;
  kwh: Record<string, number>; // KWH_COL value → summed kWh
  // SoC weighted-avg accumulators + min/max per SoC series.
  socSum: Record<string, number>;
  socCount: Record<string, number>;
  socMin: Record<string, number | null>;
  socMax: Record<string, number | null>;
}

/**
 * Roll completed LOCAL days of energy_hourly → energy_daily. Rebuilds each day
 * fully from its hourly buckets (idempotent), for days strictly before today
 * (local). kWh = Σ hourly kWh; SoC avg = sample-weighted mean of hourly avgs;
 * min/max = extremes of hourly min/max. Re-rolls all completed days each pass so
 * late hourly fills (incl. Tesla backfill) are absorbed.
 */
function rollupDaily(handle: MeteringDb, nowSec: number): void {
  const today = localDay(nowSec);
  const allHourly = handle
    .prepare(
      `SELECT bucket_ts, solar_kwh, home_kwh, charge_kwh, discharge_kwh,
              grid_import_kwh, grid_export_kwh,
              sonnen_soc_avg, sonnen_soc_min, sonnen_soc_max,
              tesla_soc_avg, tesla_soc_min, tesla_soc_max,
              combined_soc_avg, combined_soc_min, combined_soc_max, samples, src
         FROM energy_hourly`,
    )
    .all() as Array<Record<string, number | null | string> & { bucket_ts: number; samples: number }>;
  if (allHourly.length === 0) return;

  const accs = new Map<string, DailyAcc>();
  // Track whether a day has any tesla-backfill source rows → tag day src.
  const daySrc = new Map<string, Set<string>>();
  for (const h of allHourly) {
    const day = localDay(h.bucket_ts);
    if (day >= today) continue; // only completed days
    let a = accs.get(day);
    if (!a) {
      a = {
        day, samples: 0,
        kwh: { solar_kwh: 0, home_kwh: 0, charge_kwh: 0, discharge_kwh: 0, grid_import_kwh: 0, grid_export_kwh: 0 },
        socSum: {}, socCount: {}, socMin: {}, socMax: {},
      };
      accs.set(day, a);
    }
    for (const col of Object.values(KWH_COL)) {
      const v = h[col];
      if (typeof v === 'number') a.kwh[col] += v;
    }
    const samples = h.samples ?? 0;
    a.samples += samples;
    for (const k of SOC_SERIES) {
      const pfx = SOC_PREFIX[k];
      const avg = h[`${pfx}_avg`];
      const mn = h[`${pfx}_min`];
      const mx = h[`${pfx}_max`];
      if (typeof avg === 'number') {
        const w = samples > 0 ? samples : 1;
        a.socSum[pfx] = (a.socSum[pfx] ?? 0) + avg * w;
        a.socCount[pfx] = (a.socCount[pfx] ?? 0) + w;
      }
      if (typeof mn === 'number') a.socMin[pfx] = a.socMin[pfx] == null ? mn : Math.min(a.socMin[pfx] as number, mn);
      if (typeof mx === 'number') a.socMax[pfx] = a.socMax[pfx] == null ? mx : Math.max(a.socMax[pfx] as number, mx);
    }
    const src = typeof h.src === 'string' ? h.src : 'live';
    if (!daySrc.has(day)) daySrc.set(day, new Set());
    daySrc.get(day)!.add(src);
  }
  if (accs.size === 0) return;

  const upsert = handle.prepare(
    `INSERT INTO energy_daily
       (day, solar_kwh, home_kwh, charge_kwh, discharge_kwh, grid_import_kwh, grid_export_kwh,
        sonnen_soc_avg, sonnen_soc_min, sonnen_soc_max,
        tesla_soc_avg, tesla_soc_min, tesla_soc_max,
        combined_soc_avg, combined_soc_min, combined_soc_max, samples, src)
     VALUES
       (@day, @solar_kwh, @home_kwh, @charge_kwh, @discharge_kwh, @grid_import_kwh, @grid_export_kwh,
        @sonnen_soc_avg, @sonnen_soc_min, @sonnen_soc_max,
        @tesla_soc_avg, @tesla_soc_min, @tesla_soc_max,
        @combined_soc_avg, @combined_soc_min, @combined_soc_max, @samples, @src)
     ON CONFLICT(day) DO UPDATE SET
       solar_kwh = excluded.solar_kwh, home_kwh = excluded.home_kwh,
       charge_kwh = excluded.charge_kwh, discharge_kwh = excluded.discharge_kwh,
       grid_import_kwh = excluded.grid_import_kwh, grid_export_kwh = excluded.grid_export_kwh,
       sonnen_soc_avg = excluded.sonnen_soc_avg, sonnen_soc_min = excluded.sonnen_soc_min,
       sonnen_soc_max = excluded.sonnen_soc_max,
       tesla_soc_avg = excluded.tesla_soc_avg, tesla_soc_min = excluded.tesla_soc_min,
       tesla_soc_max = excluded.tesla_soc_max,
       combined_soc_avg = excluded.combined_soc_avg, combined_soc_min = excluded.combined_soc_min,
       combined_soc_max = excluded.combined_soc_max,
       samples = excluded.samples, src = excluded.src`,
  );

  const tx = handle.transaction((list: DailyAcc[]) => {
    for (const a of list) {
      const socOut = (k: (typeof SOC_SERIES)[number]) => {
        const pfx = SOC_PREFIX[k];
        const cnt = a.socCount[pfx] ?? 0;
        return {
          [`${pfx}_avg`]: cnt > 0 ? r2(a.socSum[pfx] / cnt) : null,
          [`${pfx}_min`]: r2(a.socMin[pfx] ?? null),
          [`${pfx}_max`]: r2(a.socMax[pfx] ?? null),
        };
      };
      const srcs = daySrc.get(a.day) ?? new Set<string>();
      // A day is 'live' if any live hourly present; else carries the backfill tag.
      const src = srcs.has('live') ? 'live' : srcs.has('tesla-backfill') ? 'tesla-backfill' : 'live';
      upsert.run({
        day: a.day,
        solar_kwh: r3(a.kwh.solar_kwh), home_kwh: r3(a.kwh.home_kwh),
        charge_kwh: r3(a.kwh.charge_kwh), discharge_kwh: r3(a.kwh.discharge_kwh),
        grid_import_kwh: r3(a.kwh.grid_import_kwh), grid_export_kwh: r3(a.kwh.grid_export_kwh),
        ...socOut('sonnenSoc'),
        ...socOut('teslaSoc'),
        ...socOut('combinedSoc'),
        samples: a.samples,
        src,
      });
    }
  });
  tx([...accs.values()]);
}

// ---- Retention prune --------------------------------------------------------

/** Delete energy_5m > 90d and energy_hourly > 3y (spec docs/31). Daily forever. */
function prune(handle: MeteringDb, nowSec: number): void {
  try {
    handle.prepare('DELETE FROM energy_5m WHERE ts < ?').run(nowSec - RAW_RETENTION_SEC);
    handle.prepare('DELETE FROM energy_hourly WHERE bucket_ts < ?').run(nowSec - HOURLY_RETENTION_SEC);
  } catch (e) {
    console.error('[energy-history] prune failed:', (e as Error).message);
  }
}

/** Run hourly + daily rollups + retention once (boot-reconcile + scheduled). */
export function rollupEnergyHistory(): void {
  const handle = db();
  if (!handle) return;
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    rollupHourly(handle, nowSec);
  } catch (e) {
    console.error('[energy-history] hourly rollup failed:', (e as Error).message);
  }
  try {
    rollupDaily(handle, nowSec);
  } catch (e) {
    console.error('[energy-history] daily rollup failed:', (e as Error).message);
  }
  prune(handle, nowSec);
}

// ---- Reads (serve Reports from the durable store) ---------------------------
// Range → tier: hour/day → energy_5m; week/month → energy_hourly; year →
// energy_daily (spec docs/31). Each read returns per-bucket energy in kWh plus
// the bucket's instant (ts) so the route can compute the EXACT tariff band from
// bandForHour(). The byBand window read always uses the HOURLY tier (hour-aligned
// = band-aligned) so per-band is exact even for the year range.

export type EnergyRange = 'hour' | 'day' | 'week' | 'month' | 'year';

/** One energy bucket read from the store: per-series kWh + the bucket instant. */
export interface EnergyBucket {
  ts: number; // unix seconds — bucket start (5m/hour) or local-noon (daily)
  tier: 'raw' | 'hourly' | 'daily';
  solarKwh: number;
  homeKwh: number;
  gridImportKwh: number;
  gridExportKwh: number;
  chargeKwh: number;
  dischargeKwh: number;
}

const WINDOW_SEC: Record<EnergyRange, number> = {
  hour: 60 * 60,
  day: 24 * 3600,
  week: 7 * 24 * 3600,
  month: 31 * 24 * 3600,
  year: 366 * 24 * 3600,
};

/** Tier used for the chart series of each range. */
function tierFor(range: EnergyRange): 'raw' | 'hourly' | 'daily' {
  if (range === 'hour' || range === 'day') return 'raw';
  if (range === 'week' || range === 'month') return 'hourly';
  return 'daily';
}

/** Parse a Madrid YYYY-MM-DD to a unix-seconds instant at local ~noon. */
function dayToTs(day: string): number {
  // Noon UTC of that calendar date is safely inside the Madrid day for band/label
  // purposes (daily rows aren't band-split anyway).
  const ms = Date.parse(`${day}T12:00:00Z`);
  return Math.floor(ms / 1000);
}

/** A read window: explicit [fromSec, toSec], or a trailing window for `range`. */
export interface ReadWindow {
  fromSec: number;
  toSec: number;
}

/** Resolve the [fromSec, toSec] for a range read — explicit window or trailing. */
function resolveWindow(range: EnergyRange, win?: ReadWindow): ReadWindow {
  if (win) return win;
  const nowSec = Math.floor(Date.now() / 1000);
  return { fromSec: nowSec - WINDOW_SEC[range], toSec: nowSec };
}

/**
 * Read the chart buckets for a range from the durable store over `win` (or the
 * trailing window for the range when omitted). Returns [] when the store is
 * unavailable or holds no rows for the window (caller then falls back to the live
 * Tesla path). Fail-soft.
 */
export function readEnergyBuckets(range: EnergyRange, win?: ReadWindow): EnergyBucket[] {
  const handle = db();
  if (!handle) return [];
  const { fromSec, toSec } = resolveWindow(range, win);
  const tier = tierFor(range);
  try {
    if (tier === 'raw') {
      const rows = handle
        .prepare(
          `SELECT ts, solar_kw, home_kw, charge_kw, discharge_kw, grid_import_kw, grid_export_kw
             FROM energy_5m WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`,
        )
        .all(fromSec, toSec) as Array<Record<string, number>>;
      // 5-min average kW → kWh over the 5-min bucket.
      return rows.map((r) => ({
        ts: r.ts,
        tier: 'raw' as const,
        solarKwh: (r.solar_kw ?? 0) * PER_5M_H,
        homeKwh: (r.home_kw ?? 0) * PER_5M_H,
        gridImportKwh: (r.grid_import_kw ?? 0) * PER_5M_H,
        gridExportKwh: (r.grid_export_kw ?? 0) * PER_5M_H,
        chargeKwh: (r.charge_kw ?? 0) * PER_5M_H,
        dischargeKwh: (r.discharge_kw ?? 0) * PER_5M_H,
      }));
    }
    if (tier === 'hourly') {
      const rows = handle
        .prepare(
          `SELECT bucket_ts, solar_kwh, home_kwh, charge_kwh, discharge_kwh, grid_import_kwh, grid_export_kwh
             FROM energy_hourly WHERE bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts ASC`,
        )
        .all(fromSec, toSec) as Array<Record<string, number>>;
      return rows.map((r) => ({
        ts: r.bucket_ts,
        tier: 'hourly' as const,
        solarKwh: r.solar_kwh ?? 0,
        homeKwh: r.home_kwh ?? 0,
        gridImportKwh: r.grid_import_kwh ?? 0,
        gridExportKwh: r.grid_export_kwh ?? 0,
        chargeKwh: r.charge_kwh ?? 0,
        dischargeKwh: r.discharge_kwh ?? 0,
      }));
    }
    // daily tier (year)
    const fromDay = madridDateKey(new Date(fromSec * 1000));
    const toDay = madridDateKey(new Date(toSec * 1000));
    const rows = handle
      .prepare(
        `SELECT day, solar_kwh, home_kwh, charge_kwh, discharge_kwh, grid_import_kwh, grid_export_kwh
           FROM energy_daily WHERE day >= ? AND day <= ? ORDER BY day ASC`,
      )
      .all(fromDay, toDay) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      ts: dayToTs(String(r.day)),
      tier: 'daily' as const,
      solarKwh: (r.solar_kwh as number) ?? 0,
      homeKwh: (r.home_kwh as number) ?? 0,
      gridImportKwh: (r.grid_import_kwh as number) ?? 0,
      gridExportKwh: (r.grid_export_kwh as number) ?? 0,
      chargeKwh: (r.charge_kwh as number) ?? 0,
      dischargeKwh: (r.discharge_kwh as number) ?? 0,
    }));
  } catch (e) {
    console.error('[energy-history] read failed:', (e as Error).message);
    return [];
  }
}

/**
 * Read hour-aligned grid-import buckets over the range window for EXACT per-band
 * grouping. Always the HOURLY tier (hour-aligned = P1/P2/P3 band-aligned). Returns
 * [{ ts, gridImportKwh }] or [] (fall back). For ranges narrower than an hour
 * (hour/day) the caller uses the raw buckets instead — they're already sub-hour
 * and bandForHour resolves each.
 */
export function readGridImportHourly(range: EnergyRange, win?: ReadWindow): Array<{ ts: number; gridImportKwh: number }> {
  const handle = db();
  if (!handle) return [];
  const { fromSec, toSec } = resolveWindow(range, win);
  try {
    const rows = handle
      .prepare(`SELECT bucket_ts, grid_import_kwh FROM energy_hourly WHERE bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts ASC`)
      .all(fromSec, toSec) as Array<{ bucket_ts: number; grid_import_kwh: number | null }>;
    return rows.map((r) => ({ ts: r.bucket_ts, gridImportKwh: r.grid_import_kwh ?? 0 }));
  } catch (e) {
    console.error('[energy-history] band read failed:', (e as Error).message);
    return [];
  }
}

// ---- Lifecycle --------------------------------------------------------------

let rollupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the energy-history rollup/retention loop. The 5m recorder is driven by
 * the live-sample call site (recordEnergySample), not a timer here. Guarded so an
 * init failure disables the feature and never throws into the boot path.
 */
export function startEnergyHistory(): void {
  try {
    if (rollupTimer) return;
    const handle = db();
    if (!handle) {
      console.warn('[energy-history] not started — store unavailable (history disabled, API unaffected)');
      return;
    }
    rollupEnergyHistory(); // boot-reconcile any missed rollups immediately
    rollupTimer = setInterval(() => rollupEnergyHistory(), ROLLUP_MS);
    console.log(`[energy-history] started — rollups every ${ROLLUP_MS / 60000}min (5m/hourly/daily, 90d/3y/forever)`);
  } catch (e) {
    console.error('[energy-history] start failed (history disabled, API unaffected):', (e as Error).message);
  }
}

export function stopEnergyHistory(): void {
  if (rollupTimer) {
    clearInterval(rollupTimer);
    rollupTimer = null;
  }
}

export { TZ as energyHistoryTz };
