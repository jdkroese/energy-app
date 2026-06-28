// One-time history backfill (spec docs/31 §2) — seeds the durable energy_* store
// from (a) the existing 30-day history-5m.json and (b) Tesla calendar_history.
//
// Runs ASYNC on boot, AFTER startEnergyHistory(), and NEVER blocks startup or the
// control loop. Every step is try/caught and gates on db(); a failure logs and
// the feature degrades (live recording + the Tesla live-read fallback still work).
//
// Idempotency:
//   • JSON import is guarded by a cb_meta cursor flag → runs once ever.
//   • Tesla backfill upserts by bucket and is re-runnable: hourly/daily upserts
//     only touch rows already sourced 'tesla-backfill' (never clobber 'live'), so
//     repeated boots don't double-count.

import * as tesla from '../connectors/tesla';
import { db, getMeta, setMeta, type MeteringDb } from '../db/sqlite';
import { rawBuckets, madridDateKey, HISTORY_SERIES } from '../history5m';
import {
  upsertRaw5m,
  upsertHourlyBackfill,
  upsertDailyBackfill,
  rollupEnergyHistory,
  type BackfillEnergyKwh,
} from './energy-history';
import {
  rowSolar,
  rowHome,
  rowImport,
  rowExport,
  type EnergyRow,
} from '../routes/history';

const HOUR_SEC = 3600;
const IMPORT_FLAG = 'energy_json_imported';
const TESLA_FLAG = 'energy_tesla_backfilled_at';

// ---- (a) Import the existing history-5m.json into energy_5m (once) -----------

function importJsonOnce(handle: MeteringDb): void {
  if (getMeta(IMPORT_FLAG) === '1') return; // already imported
  try {
    const buckets = rawBuckets();
    if (buckets.length === 0) {
      setMeta(IMPORT_FLAG, '1');
      return;
    }
    const tx = handle.transaction((list: ReturnType<typeof rawBuckets>) => {
      for (const b of list) {
        // Map null power → 0 (power series), keep SoC nulls.
        const values = {} as Record<(typeof HISTORY_SERIES)[number], number | null>;
        for (const k of HISTORY_SERIES) {
          const v = b.values[k];
          const isSoc = k === 'sonnenSoc' || k === 'teslaSoc' || k === 'combinedSoc';
          values[k] = v == null ? (isSoc ? null : 0) : v;
        }
        upsertRaw5m(handle, b.ts, values, b.samples);
      }
    });
    tx(buckets);
    setMeta(IMPORT_FLAG, '1');
    console.log(`[energy-backfill] imported ${buckets.length} 5m buckets from history-5m.json`);
  } catch (e) {
    console.error('[energy-backfill] JSON import failed:', (e as Error).message);
  }
}

// ---- (b) Tesla calendar_history backfill ------------------------------------

/** Parse a Tesla sample timestamp to ms (mirrors routes/history.toDate). */
function tsToMs(ts: string | number | undefined): number | null {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number' || /^\d+$/.test(String(ts).trim())) {
    const n = Number(ts);
    return n < 1e12 ? n * 1000 : n;
  }
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function emptyKwh(): BackfillEnergyKwh {
  return { solarKwh: 0, homeKwh: 0, gridImportKwh: 0, gridExportKwh: 0, chargeKwh: 0, dischargeKwh: 0 };
}

/** Add one Tesla row's energy (Wh) into a kWh accumulator. */
function addRow(acc: BackfillEnergyKwh, r: EnergyRow): void {
  acc.solarKwh += rowSolar(r) / 1000;
  acc.homeKwh += rowHome(r) / 1000;
  acc.gridImportKwh += rowImport(r) / 1000;
  acc.gridExportKwh += rowExport(r) / 1000;
  // calendar_history battery flows: charge ≈ battery_energy_imported_from_solar
  // (+ from grid if present); discharge ≈ consumer_energy_imported_from_battery.
  acc.chargeKwh += (r.battery_energy_imported_from_solar ?? 0) / 1000;
  acc.dischargeKwh += (r.consumer_energy_imported_from_battery ?? 0) / 1000;
}

async function fetchRows(period: 'week' | 'month' | 'year'): Promise<EnergyRow[]> {
  try {
    const raw = (await tesla.getCalendarHistory('energy', period)) as { time_series?: EnergyRow[] };
    return raw.time_series ?? [];
  } catch (e) {
    console.warn(`[energy-backfill] tesla ${period} fetch failed:`, (e as Error).message);
    return [];
  }
}

/** Backfill hourly buckets from a fine-grained period (week/month). */
function backfillHourly(handle: MeteringDb, rows: EnergyRow[]): number {
  const byHour = new Map<number, BackfillEnergyKwh>();
  for (const r of rows) {
    const ms = tsToMs(r.timestamp);
    if (ms == null) continue;
    const bucket = Math.floor(ms / 1000 / HOUR_SEC) * HOUR_SEC;
    let acc = byHour.get(bucket);
    if (!acc) {
      acc = emptyKwh();
      byHour.set(bucket, acc);
    }
    addRow(acc, r);
  }
  if (byHour.size === 0) return 0;
  const tx = handle.transaction((entries: Array<[number, BackfillEnergyKwh]>) => {
    for (const [bucket, acc] of entries) upsertHourlyBackfill(handle, bucket, acc);
  });
  tx([...byHour.entries()]);
  return byHour.size;
}

/** Backfill daily buckets from the coarse year period. */
function backfillDaily(handle: MeteringDb, rows: EnergyRow[]): number {
  const byDay = new Map<string, BackfillEnergyKwh>();
  for (const r of rows) {
    const ms = tsToMs(r.timestamp);
    if (ms == null) continue;
    const day = madridDateKey(new Date(ms));
    let acc = byDay.get(day);
    if (!acc) {
      acc = emptyKwh();
      byDay.set(day, acc);
    }
    addRow(acc, r);
  }
  if (byDay.size === 0) return 0;
  const tx = handle.transaction((entries: Array<[string, BackfillEnergyKwh]>) => {
    for (const [day, acc] of entries) upsertDailyBackfill(handle, day, acc);
  });
  tx([...byDay.entries()]);
  return byDay.size;
}

async function teslaBackfill(handle: MeteringDb): Promise<void> {
  // No explicit "configured" probe — fetchRows() catches an unauthenticated/failed
  // call and returns [], so an unconfigured Tesla simply backfills nothing.
  try {
    // week + month → hourly resolution (30-min / daily samples aggregate to hours).
    const [week, month, year] = await Promise.all([
      fetchRows('week'),
      fetchRows('month'),
      fetchRows('year'),
    ]);
    // month is the superset of week at the same granularity; combine then backfill
    // hourly once (Map upsert is idempotent regardless of overlap).
    const hourlyRows = [...month, ...week];
    const hours = backfillHourly(handle, hourlyRows);
    // year is coarse (~2h samples back toward install) → keep at DAILY resolution
    // so the year range renders deep. Days already covered by hourly 'live' are
    // untouched (upsert guards on src='tesla-backfill').
    const days = backfillDaily(handle, year);
    setMeta(TESLA_FLAG, new Date().toISOString());
    // Re-roll so the daily tier reflects the freshly-backfilled hourly rows.
    rollupEnergyHistory();
    const span = (rows: EnergyRow[]) => {
      const times = rows.map((r) => tsToMs(r.timestamp)).filter((m): m is number => m != null);
      if (times.length === 0) return 'none';
      return `${madridDateKey(new Date(Math.min(...times)))}…${madridDateKey(new Date(Math.max(...times)))}`;
    };
    console.log(
      `[energy-backfill] tesla: ${hours} hourly buckets (${span(hourlyRows)}), ` +
        `${days} daily buckets (${span(year)})`,
    );
  } catch (e) {
    console.error('[energy-backfill] tesla backfill failed:', (e as Error).message);
  }
}

// ---- Entry point ------------------------------------------------------------

/**
 * Run the one-time JSON import + Tesla backfill in the background. Safe to call on
 * every boot — both steps are idempotent. Never throws; never blocks. Fail-soft.
 */
export async function runEnergyBackfill(): Promise<void> {
  const handle = db();
  if (!handle) return;
  try {
    importJsonOnce(handle);
    rollupEnergyHistory(); // fold the imported 5m into hourly/daily first
  } catch (e) {
    console.error('[energy-backfill] import/rollup failed:', (e as Error).message);
  }
  await teslaBackfill(handle);
}
