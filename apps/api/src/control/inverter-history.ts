// Per-inverter solar production history — durable tiered store (spec docs/36).
//
// Mirrors energy-history.ts but with an inverter_id dimension (the Sungrow dongle
// IP / SN). Records each inverter's 5-minute-average AC power (kW) + daily/total
// yield snapshots, then rolls power → kWh into hourly (3y) and daily (forever)
// tiers. Read side serves the Reports per-inverter chart.
//
// ADDITIVE + READ-ONLY + FAIL-SOFT: it touches no control/armed/battery path and
// shares the SAME fail-soft SQLite handle (db/sqlite.ts). A null DB or any error
// logs once and no-ops — it can NEVER throw into the armed control loop that shares
// this process. The sampler is driven from the /api/live path (recordInverterSamples).

import { db, getMeta, setMeta, type MeteringDb } from '../db/sqlite';
import { madridDateKey } from '../history5m';

const FIVE_MIN_SEC = 300;
const HOUR_SEC = 3600;
const ROLLUP_MS = 5 * 60 * 1000;
const PER_5M_H = FIVE_MIN_SEC / 3600; // 5 min in hours
const RAW_RETENTION_SEC = 90 * 24 * 3600;
const HOURLY_RETENTION_SEC = 3 * 365 * 24 * 3600;

/** One inverter's live sample for the 5-minute recorder. */
export interface InverterSample {
  /** Stable inverter id (dongle IP / SN). */
  id: string;
  /** Live AC power (kW) — 0 when reachable but idle. Skipped when unreachable. */
  acKw: number;
  /** Today's yield snapshot (kWh), or null. */
  dailyKwh: number | null;
  /** Lifetime yield snapshot (kWh), or null. */
  totalKwh: number | null;
}

function bucket5mTs(nowMs: number): number {
  return Math.floor(nowMs / (FIVE_MIN_SEC * 1000)) * FIVE_MIN_SEC;
}

/**
 * Record a batch of live inverter samples into their 5-minute inverter_5m buckets
 * (running average per inverter). Only REACHABLE inverters should be passed (an
 * unreachable one must not average a spurious 0 into its production). Idempotent
 * within a bucket. Fail-soft: a null DB or any error no-ops.
 */
export function recordInverterSamples(samples: InverterSample[]): void {
  const handle = db();
  if (!handle) return;
  if (samples.length === 0) return;
  try {
    const ts = bucket5mTs(Date.now());
    const sel = handle.prepare('SELECT ac_kw, daily_kwh, total_kwh, samples FROM inverter_5m WHERE inverter_id = ? AND ts = ?');
    const up = handle.prepare(
      `INSERT INTO inverter_5m (inverter_id, ts, ac_kw, daily_kwh, total_kwh, samples)
         VALUES (@inverter_id, @ts, @ac_kw, @daily_kwh, @total_kwh, @samples)
       ON CONFLICT(inverter_id, ts) DO UPDATE SET
         ac_kw = excluded.ac_kw, daily_kwh = excluded.daily_kwh,
         total_kwh = excluded.total_kwh, samples = excluded.samples`,
    );
    const tx = handle.transaction((batch: InverterSample[]) => {
      for (const s of batch) {
        const prev = sel.get(s.id, ts) as
          | { ac_kw: number | null; daily_kwh: number | null; total_kwh: number | null; samples: number }
          | undefined;
        const n = prev?.samples ?? 0;
        const base = typeof prev?.ac_kw === 'number' ? prev.ac_kw : 0;
        up.run({
          inverter_id: s.id,
          ts,
          ac_kw: (base * n + s.acKw) / (n + 1),
          // Yield snapshots are last-write-wins (monotonic totals, not averaged).
          daily_kwh: s.dailyKwh ?? prev?.daily_kwh ?? null,
          total_kwh: s.totalKwh ?? prev?.total_kwh ?? null,
          samples: n + 1,
        });
      }
    });
    tx(samples);
  } catch (e) {
    console.error('[inverter-history] 5m record failed:', (e as Error).message);
  }
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Roll completed hours of inverter_5m → inverter_hourly (per inverter). */
function rollupHourly(handle: MeteringDb, nowSec: number): void {
  const curHourStart = Math.floor(nowSec / HOUR_SEC) * HOUR_SEC;
  const cursor = Number(getMeta('inverter_hourly_cursor') ?? 0);
  const fromExclusive = Number.isFinite(cursor) ? cursor : 0;

  const rows = handle
    .prepare(
      `SELECT inverter_id,
              (ts / ${HOUR_SEC}) * ${HOUR_SEC} AS bucket_ts,
              SUM(COALESCE(ac_kw, 0))          AS ac_sum,
              COUNT(*)                         AS samples
         FROM inverter_5m
        WHERE ts >= ? AND ts < ?
        GROUP BY inverter_id, bucket_ts`,
    )
    .all(fromExclusive, curHourStart) as Array<{
    inverter_id: string;
    bucket_ts: number;
    ac_sum: number;
    samples: number;
  }>;

  if (rows.length === 0) {
    if (curHourStart > fromExclusive) setMeta('inverter_hourly_cursor', String(curHourStart));
    return;
  }

  const up = handle.prepare(
    `INSERT INTO inverter_hourly (inverter_id, bucket_ts, ac_kwh, samples)
       VALUES (@inverter_id, @bucket_ts, @ac_kwh, @samples)
     ON CONFLICT(inverter_id, bucket_ts) DO UPDATE SET
       ac_kwh = excluded.ac_kwh, samples = excluded.samples`,
  );
  const tx = handle.transaction((batch: typeof rows) => {
    for (const r of batch) {
      up.run({ inverter_id: r.inverter_id, bucket_ts: r.bucket_ts, ac_kwh: r3(r.ac_sum * PER_5M_H), samples: r.samples });
    }
  });
  tx(rows);
  setMeta('inverter_hourly_cursor', String(curHourStart));
}

function localDay(unixSec: number): string {
  return madridDateKey(new Date(unixSec * 1000));
}

/** Roll completed local days of inverter_hourly → inverter_daily (per inverter). */
function rollupDaily(handle: MeteringDb, nowSec: number): void {
  const today = localDay(nowSec);
  const rows = handle
    .prepare(`SELECT inverter_id, bucket_ts, ac_kwh, samples FROM inverter_hourly`)
    .all() as Array<{ inverter_id: string; bucket_ts: number; ac_kwh: number | null; samples: number }>;
  if (rows.length === 0) return;

  const acc = new Map<string, { inverter_id: string; day: string; ac: number; samples: number }>();
  for (const r of rows) {
    const day = localDay(r.bucket_ts);
    if (day >= today) continue; // only completed days
    const key = `${r.inverter_id}\0${day}`;
    let a = acc.get(key);
    if (!a) {
      a = { inverter_id: r.inverter_id, day, ac: 0, samples: 0 };
      acc.set(key, a);
    }
    a.ac += r.ac_kwh ?? 0;
    a.samples += r.samples ?? 0;
  }
  if (acc.size === 0) return;

  const up = handle.prepare(
    `INSERT INTO inverter_daily (inverter_id, day, ac_kwh, samples)
       VALUES (@inverter_id, @day, @ac_kwh, @samples)
     ON CONFLICT(inverter_id, day) DO UPDATE SET
       ac_kwh = excluded.ac_kwh, samples = excluded.samples`,
  );
  const tx = handle.transaction((list: Array<{ inverter_id: string; day: string; ac: number; samples: number }>) => {
    for (const a of list) up.run({ inverter_id: a.inverter_id, day: a.day, ac_kwh: r3(a.ac), samples: a.samples });
  });
  tx([...acc.values()]);
}

function prune(handle: MeteringDb, nowSec: number): void {
  try {
    handle.prepare('DELETE FROM inverter_5m WHERE ts < ?').run(nowSec - RAW_RETENTION_SEC);
    handle.prepare('DELETE FROM inverter_hourly WHERE bucket_ts < ?').run(nowSec - HOURLY_RETENTION_SEC);
  } catch (e) {
    console.error('[inverter-history] prune failed:', (e as Error).message);
  }
}

/** Run hourly + daily rollups + retention once (boot-reconcile + scheduled). */
export function rollupInverterHistory(): void {
  const handle = db();
  if (!handle) return;
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    rollupHourly(handle, nowSec);
  } catch (e) {
    console.error('[inverter-history] hourly rollup failed:', (e as Error).message);
  }
  try {
    rollupDaily(handle, nowSec);
  } catch (e) {
    console.error('[inverter-history] daily rollup failed:', (e as Error).message);
  }
  prune(handle, nowSec);
}

// ---- Reads (serve the Reports per-inverter chart) --------------------------

export type InverterRange = 'hour' | 'day' | 'week' | 'month' | 'year';

const WINDOW_SEC: Record<InverterRange, number> = {
  hour: 60 * 60,
  day: 24 * 3600,
  week: 7 * 24 * 3600,
  month: 31 * 24 * 3600,
  year: 366 * 24 * 3600,
};

function tierFor(range: InverterRange): 'raw' | 'hourly' | 'daily' {
  if (range === 'hour' || range === 'day') return 'raw';
  if (range === 'week' || range === 'month') return 'hourly';
  return 'daily';
}

export interface InverterBucket {
  ts: number; // unix seconds — bucket start (5m/hour) or local-noon (daily)
  inverterId: string;
  acKwh: number;
}

export interface ReadWindow {
  fromSec: number;
  toSec: number;
}

function dayToTs(day: string): number {
  const ms = Date.parse(`${day}T12:00:00Z`);
  return Math.floor(ms / 1000);
}

function resolveWindow(range: InverterRange, win?: ReadWindow): ReadWindow {
  if (win) return win;
  const nowSec = Math.floor(Date.now() / 1000);
  return { fromSec: nowSec - WINDOW_SEC[range], toSec: nowSec };
}

/**
 * Read per-inverter production buckets for a range over `win` (or the trailing
 * window). Returns [] when the store is unavailable or holds no rows. Fail-soft.
 */
export function readInverterBuckets(range: InverterRange, win?: ReadWindow): InverterBucket[] {
  const handle = db();
  if (!handle) return [];
  const { fromSec, toSec } = resolveWindow(range, win);
  const tier = tierFor(range);
  try {
    if (tier === 'raw') {
      const rows = handle
        .prepare(`SELECT inverter_id, ts, ac_kw FROM inverter_5m WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`)
        .all(fromSec, toSec) as Array<{ inverter_id: string; ts: number; ac_kw: number | null }>;
      return rows.map((r) => ({ ts: r.ts, inverterId: r.inverter_id, acKwh: (r.ac_kw ?? 0) * PER_5M_H }));
    }
    if (tier === 'hourly') {
      const rows = handle
        .prepare(`SELECT inverter_id, bucket_ts, ac_kwh FROM inverter_hourly WHERE bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts ASC`)
        .all(fromSec, toSec) as Array<{ inverter_id: string; bucket_ts: number; ac_kwh: number | null }>;
      return rows.map((r) => ({ ts: r.bucket_ts, inverterId: r.inverter_id, acKwh: r.ac_kwh ?? 0 }));
    }
    const fromDay = madridDateKey(new Date(fromSec * 1000));
    const toDay = madridDateKey(new Date(toSec * 1000));
    const rows = handle
      .prepare(`SELECT inverter_id, day, ac_kwh FROM inverter_daily WHERE day >= ? AND day <= ? ORDER BY day ASC`)
      .all(fromDay, toDay) as Array<{ inverter_id: string; day: string; ac_kwh: number | null }>;
    return rows.map((r) => ({ ts: dayToTs(r.day), inverterId: r.inverter_id, acKwh: r.ac_kwh ?? 0 }));
  } catch (e) {
    console.error('[inverter-history] read failed:', (e as Error).message);
    return [];
  }
}

// ---- Lifecycle --------------------------------------------------------------

let rollupTimer: ReturnType<typeof setInterval> | null = null;

/** Start the per-inverter rollup/retention loop (the 5m recorder is call-site driven). */
export function startInverterHistory(): void {
  try {
    if (rollupTimer) return;
    const handle = db();
    if (!handle) {
      console.warn('[inverter-history] not started — store unavailable (history disabled, API unaffected)');
      return;
    }
    rollupInverterHistory(); // boot-reconcile
    rollupTimer = setInterval(() => rollupInverterHistory(), ROLLUP_MS);
    console.log('[inverter-history] started — rollups every 5min (5m/hourly/daily, 90d/3y/forever)');
  } catch (e) {
    console.error('[inverter-history] start failed (history disabled, API unaffected):', (e as Error).message);
  }
}

