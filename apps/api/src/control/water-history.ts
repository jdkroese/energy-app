// Water-meter history — durable tiered store (docs/51). Mirrors inverter-history.ts's
// shape, but the SOURCE here is the Contazara meter's own hourly reads (not a local
// 5-minute sampler) — the meter is hourly-read/~daily-upload, not a live feed, so
// there is no raw/5m tier: water_hourly IS the finest tier we have.
//
// ADDITIVE + READ-ONLY-TO-THE-CONTROL-LOOP + FAIL-SOFT: shares the same fail-soft
// SQLite handle as db/sqlite.ts. A null DB or any error logs once and no-ops — this can
// NEVER throw into the armed battery/irrigation control loop that shares this process.
//
// Responsibilities:
//   • poll the Contazara connector on a cadence (ContazaraConfig.pollHours) and upsert
//     hourly + daily rows,
//   • run a ONE-TIME resumable backfill (24 months daily + 90 days hourly) the first
//     time the integration connects successfully,
//   • serve the tiered read used by GET /api/water/history,
//   • trigger the attribution + detector passes after each successful poll (new data
//     only — no point re-running them between polls).

import { db, getMeta, setMeta, type MeteringDb } from '../db/sqlite';
import * as contazara from '../connectors/contazara';
import { contazaraConfig, type ContazaraConfig } from '../runtime-config';
import { madridDateKey } from '../history5m';

const HOUR_SEC = 3600;
const BACKFILL_DAILY_MONTHS = 24;
const BACKFILL_HOURLY_DAYS = 90;
const BACKFILL_STEP_DELAY_MS = 400; // rate-polite — sequential, small delay between calls
const POLL_CHECK_MS = 15 * 60_000; // how often we check "is it time to poll yet"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Writes (upserts) --------------------------------------------------------

export interface HourlyRow {
  bucketTs: number;
  litres: number;
  indexVol: number | null;
}
export interface DailyRow {
  day: string;
  litres: number;
  indexVol: number | null;
}

/** Upsert hourly rows (authoritative — always overwrites). Fail-soft. */
export function recordWaterHourly(points: HourlyRow[], source = 'contazara'): void {
  const handle = db();
  if (!handle || points.length === 0) return;
  try {
    const up = handle.prepare(
      `INSERT INTO water_hourly (bucket_ts, litres, index_vol, source)
         VALUES (@bucket_ts, @litres, @index_vol, @source)
       ON CONFLICT(bucket_ts) DO UPDATE SET
         litres = excluded.litres, index_vol = excluded.index_vol, source = excluded.source`,
    );
    const tx = handle.transaction((batch: HourlyRow[]) => {
      for (const r of batch) up.run({ bucket_ts: r.bucketTs, litres: r.litres, index_vol: r.indexVol, source });
    });
    tx(points);
  } catch (e) {
    console.error('[water-history] hourly record failed:', (e as Error).message);
  }
}

/** Upsert daily rows FROM THE API (authoritative — always overwrites a local fallback). Fail-soft. */
export function recordWaterDaily(points: DailyRow[]): void {
  const handle = db();
  if (!handle || points.length === 0) return;
  try {
    const up = handle.prepare(
      `INSERT INTO water_daily (day, litres, index_vol)
         VALUES (@day, @litres, @index_vol)
       ON CONFLICT(day) DO UPDATE SET litres = excluded.litres, index_vol = excluded.index_vol`,
    );
    const tx = handle.transaction((batch: DailyRow[]) => {
      for (const r of batch) up.run({ day: r.day, litres: r.litres, index_vol: r.indexVol });
    });
    tx(points);
  } catch (e) {
    console.error('[water-history] daily record failed:', (e as Error).message);
  }
}

/** Fill any water_daily gap from locally-stored hourly rows, for COMPLETED days only, and
 *  NEVER overwriting an existing (API-sourced) row — a defensive fallback for a day the
 *  daily endpoint missed but the hourly endpoint covered. */
function rollupDailyFromHourlyGaps(handle: MeteringDb, nowSec: number): void {
  try {
    const today = madridDateKey(new Date(nowSec * 1000));
    const rows = handle.prepare(`SELECT bucket_ts, litres FROM water_hourly`).all() as Array<{
      bucket_ts: number;
      litres: number | null;
    }>;
    if (rows.length === 0) return;
    const perDay = new Map<string, number>();
    for (const r of rows) {
      const day = madridDateKey(new Date(r.bucket_ts * 1000));
      if (day >= today) continue; // only completed days
      perDay.set(day, (perDay.get(day) ?? 0) + (r.litres ?? 0));
    }
    if (perDay.size === 0) return;
    const ins = handle.prepare(
      `INSERT INTO water_daily (day, litres, index_vol) VALUES (@day, @litres, NULL)
       ON CONFLICT(day) DO NOTHING`,
    );
    const tx = handle.transaction((entries: Array<[string, number]>) => {
      for (const [day, litres] of entries) ins.run({ day, litres: Math.round(litres * 100) / 100 });
    });
    tx([...perDay.entries()]);
  } catch (e) {
    console.error('[water-history] daily-from-hourly rollup failed:', (e as Error).message);
  }
}

function prune(handle: MeteringDb, nowSec: number): void {
  try {
    handle.prepare('DELETE FROM water_hourly WHERE bucket_ts < ?').run(nowSec - 3 * 365 * 24 * 3600); // 3y
    handle.prepare('DELETE FROM water_attribution WHERE bucket_ts < ?').run(nowSec - 3 * 365 * 24 * 3600);
    // water_daily kept forever (matches the design brief); water_zone_flow is a live
    // running-average table (no time-based prune).
  } catch (e) {
    console.error('[water-history] prune failed:', (e as Error).message);
  }
}

// ---- Attribution + zone-flow accessors (used by control/water-attribution.ts) ------

export interface AttributionRow {
  bucketTs: number;
  irrigationL: number;
  householdL: number;
  unexplainedL: number;
  zones: string[];
}

export function writeWaterAttribution(rows: AttributionRow[]): void {
  const handle = db();
  if (!handle || rows.length === 0) return;
  try {
    const up = handle.prepare(
      `INSERT INTO water_attribution (bucket_ts, irrigation_l, household_l, unexplained_l, zones)
         VALUES (@bucket_ts, @irrigation_l, @household_l, @unexplained_l, @zones)
       ON CONFLICT(bucket_ts) DO UPDATE SET
         irrigation_l = excluded.irrigation_l, household_l = excluded.household_l,
         unexplained_l = excluded.unexplained_l, zones = excluded.zones`,
    );
    const tx = handle.transaction((batch: AttributionRow[]) => {
      for (const r of batch) {
        up.run({
          bucket_ts: r.bucketTs,
          irrigation_l: r.irrigationL,
          household_l: r.householdL,
          unexplained_l: r.unexplainedL,
          zones: JSON.stringify(r.zones),
        });
      }
    });
    tx(rows);
  } catch (e) {
    console.error('[water-history] attribution write failed:', (e as Error).message);
  }
}

export function readWaterAttribution(fromSec: number, toSec: number): AttributionRow[] {
  const handle = db();
  if (!handle) return [];
  try {
    const rows = handle
      .prepare(
        `SELECT bucket_ts, irrigation_l, household_l, unexplained_l, zones
           FROM water_attribution WHERE bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts ASC`,
      )
      .all(fromSec, toSec) as Array<{
      bucket_ts: number;
      irrigation_l: number | null;
      household_l: number | null;
      unexplained_l: number | null;
      zones: string | null;
    }>;
    return rows.map((r) => ({
      bucketTs: r.bucket_ts,
      irrigationL: r.irrigation_l ?? 0,
      householdL: r.household_l ?? 0,
      unexplainedL: r.unexplained_l ?? 0,
      zones: safeJsonArray(r.zones),
    }));
  } catch (e) {
    console.error('[water-history] attribution read failed:', (e as Error).message);
    return [];
  }
}

function safeJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface ZoneFlowRow {
  zoneId: string;
  lpm: number;
  samples: number;
  updatedTs: number;
}

export function readZoneFlow(): Record<string, ZoneFlowRow> {
  const handle = db();
  if (!handle) return {};
  try {
    const rows = handle.prepare(`SELECT zone_id, lpm, samples, updated_ts FROM water_zone_flow`).all() as Array<{
      zone_id: string;
      lpm: number | null;
      samples: number;
      updated_ts: number | null;
    }>;
    const out: Record<string, ZoneFlowRow> = {};
    for (const r of rows) out[r.zone_id] = { zoneId: r.zone_id, lpm: r.lpm ?? 0, samples: r.samples, updatedTs: r.updated_ts ?? 0 };
    return out;
  } catch (e) {
    console.error('[water-history] zone-flow read failed:', (e as Error).message);
    return {};
  }
}

export function writeZoneFlow(rows: ZoneFlowRow[]): void {
  const handle = db();
  if (!handle || rows.length === 0) return;
  try {
    const up = handle.prepare(
      `INSERT INTO water_zone_flow (zone_id, lpm, samples, updated_ts)
         VALUES (@zone_id, @lpm, @samples, @updated_ts)
       ON CONFLICT(zone_id) DO UPDATE SET lpm = excluded.lpm, samples = excluded.samples, updated_ts = excluded.updated_ts`,
    );
    const tx = handle.transaction((batch: ZoneFlowRow[]) => {
      for (const r of batch) up.run({ zone_id: r.zoneId, lpm: r.lpm, samples: r.samples, updated_ts: r.updatedTs });
    });
    tx(rows);
  } catch (e) {
    console.error('[water-history] zone-flow write failed:', (e as Error).message);
  }
}

// ---- Reads (serve GET /api/water + /api/water/history) ----------------------

export type WaterRange = 'day' | 'week' | 'month' | 'year';

export interface WaterHourlyBucket {
  bucketTs: number;
  litres: number;
  indexVol: number | null;
}

/** Raw hourly rows in [fromSec, toSec]. Fail-soft (→ []). */
export function readHourly(fromSec: number, toSec: number): WaterHourlyBucket[] {
  const handle = db();
  if (!handle) return [];
  try {
    const rows = handle
      .prepare(`SELECT bucket_ts, litres, index_vol FROM water_hourly WHERE bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts ASC`)
      .all(fromSec, toSec) as Array<{ bucket_ts: number; litres: number | null; index_vol: number | null }>;
    return rows.map((r) => ({ bucketTs: r.bucket_ts, litres: r.litres ?? 0, indexVol: r.index_vol }));
  } catch (e) {
    console.error('[water-history] hourly read failed:', (e as Error).message);
    return [];
  }
}

export interface WaterDailyBucket {
  day: string;
  litres: number;
  indexVol: number | null;
}

/** Raw daily rows for [fromDay, toDay] (Madrid YYYY-MM-DD, inclusive). Fail-soft (→ []). */
export function readDaily(fromDay: string, toDay: string): WaterDailyBucket[] {
  const handle = db();
  if (!handle) return [];
  try {
    const rows = handle
      .prepare(`SELECT day, litres, index_vol FROM water_daily WHERE day >= ? AND day <= ? ORDER BY day ASC`)
      .all(fromDay, toDay) as Array<{ day: string; litres: number | null; index_vol: number | null }>;
    return rows.map((r) => ({ day: r.day, litres: r.litres ?? 0, indexVol: r.index_vol }));
  } catch (e) {
    console.error('[water-history] daily read failed:', (e as Error).message);
    return [];
  }
}

/** The most recent hourly bucket_ts we hold, or null. Fail-soft. */
export function latestHourlyTs(): number | null {
  const handle = db();
  if (!handle) return null;
  try {
    const row = handle.prepare(`SELECT MAX(bucket_ts) AS t FROM water_hourly`).get() as { t: number | null } | undefined;
    return row?.t ?? null;
  } catch {
    return null;
  }
}

// ---- Poll status (connector health, for GET /api/water "connected"/"lastError") ----

export interface PollStatus {
  ok: boolean;
  ts: string | null;
  error: string | null;
}

export function lastPollStatus(): PollStatus {
  const ok = getMeta('water_last_poll_ok') === '1';
  const ts = getMeta('water_last_poll_ts');
  const error = getMeta('water_last_poll_error');
  return { ok, ts, error };
}

function recordPollOutcome(ok: boolean, error: string | null): void {
  setMeta('water_last_poll_ok', ok ? '1' : '0');
  setMeta('water_last_poll_ts', new Date().toISOString());
  setMeta('water_last_poll_error', error ?? '');
}

// ---- Poll (recent hourly/daily + kick attribution/detectors) ----------------

/** Attribution/detector hooks, injected by control/water-attribution.ts + water-detectors.ts
 *  at boot (avoids a require cycle: those modules read this one's tables). */
let onNewData: (() => void) | null = null;
export function setOnNewData(fn: () => void): void {
  onNewData = fn;
}

/** Fetch + persist the last few days of hourly + a recent window of daily. Best-effort;
 *  never throws (caller is the poll loop). Returns true on any successful read. */
async function pollRecent(cfg: ContazaraConfig): Promise<boolean> {
  const token = await contazara.getToken(cfg);
  const info = await contazara.fetchSubscriberInfo(cfg, token);
  const meter = info?.meters.find((m) => m.serialNumber === cfg.serial) ?? info?.meters[0] ?? null;
  if (!meter) throw new Error('no meter matched the configured serial');

  let any = false;
  // Hourly: today + yesterday (covers the meter's upload lag + the night-slot window).
  const now = new Date();
  for (const daysAgo of [1, 0]) {
    const d = new Date(now.getTime() - daysAgo * 86_400_000);
    const dateStr = contazara.yyyymmdd(d);
    try {
      const hours = await contazara.fetchHourly(cfg, token, meter.serialNumber, dateStr);
      if (hours.length > 0) {
        recordWaterHourly(hours.map((h) => ({ bucketTs: h.epochSec, litres: h.litres, indexVol: h.indexVol })));
        any = true;
      }
    } catch (e) {
      console.error(`[water-history] hourly poll failed for ${dateStr}:`, (e as Error).message);
    }
    await sleep(BACKFILL_STEP_DELAY_MS);
  }

  // Daily: a rolling 35-day window (cheap single range call; corrects any prior estimate).
  try {
    const to = contazara.yyyymmdd(now);
    const from = contazara.yyyymmdd(new Date(now.getTime() - 35 * 86_400_000));
    const daily = await contazara.fetchDaily(cfg, token, meter.serialNumber, from, to);
    if (daily.length > 0) {
      recordWaterDaily(daily.map((d) => ({ day: d.day, litres: d.litres, indexVol: d.indexVol })));
      any = true;
    }
  } catch (e) {
    console.error('[water-history] daily poll failed:', (e as Error).message);
  }

  return any;
}

async function pollOnce(): Promise<void> {
  const cfg = contazaraConfig();
  if (!cfg) return;
  const handle = db();
  if (!handle) return;
  try {
    const ok = await pollRecent(cfg);
    recordPollOutcome(ok, ok ? null : 'poll completed but returned no data');
    const nowSec = Math.floor(Date.now() / 1000);
    rollupDailyFromHourlyGaps(handle, nowSec);
    prune(handle, nowSec);
    setMeta('water_last_poll_attempt_ts', String(Date.now()));
    if (onNewData) {
      try {
        onNewData();
      } catch (e) {
        console.error('[water-history] onNewData hook failed:', (e as Error).message);
      }
    }
    // Kick the one-time backfill (idempotent, resumable, never blocks) after a healthy poll.
    void runBackfillIfNeeded(cfg).catch((e) => console.error('[water-history] backfill failed:', (e as Error).message));
  } catch (e) {
    recordPollOutcome(false, (e as Error).message);
    console.error('[water-history] poll failed:', (e as Error).message);
  }
}

// ---- Backfill (one-time, resumable, rate-polite) -----------------------------

function monthsAgoYYYYMMDD(months: number, from: Date): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() - months);
  return contazara.yyyymmdd(d);
}

/**
 * On first successful connect, pull ~24 months of daily (a handful of range calls) and
 * ~90 days of hourly (one call per day, sequential + rate-polite). Resumable via cb_meta
 * cursors so a restart mid-backfill picks up where it left off. Never blocks boot or the
 * regular poll — kicked off in the background after a healthy poll.
 */
async function runBackfillIfNeeded(cfg: ContazaraConfig): Promise<void> {
  if (getMeta('water_backfill_daily_done') !== '1') {
    await backfillDaily(cfg);
  }
  await backfillHourly(cfg);
}

async function backfillDaily(cfg: ContazaraConfig): Promise<void> {
  const token = await contazara.getToken(cfg);
  const info = await contazara.fetchSubscriberInfo(cfg, token);
  const meter = info?.meters.find((m) => m.serialNumber === cfg.serial) ?? info?.meters[0] ?? null;
  if (!meter) return;
  const now = new Date();
  // Chunk into ~90-day windows (rate-polite + defensive against an undocumented range cap).
  const CHUNK_DAYS = 90;
  let cursor = new Date(monthsAgoYYYYMMDD(BACKFILL_DAILY_MONTHS, now).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'));
  const end = now;
  while (cursor.getTime() < end.getTime()) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + CHUNK_DAYS * 86_400_000, end.getTime()));
    try {
      const rows = await contazara.fetchDaily(cfg, token, meter.serialNumber, contazara.yyyymmdd(cursor), contazara.yyyymmdd(chunkEnd));
      if (rows.length > 0) recordWaterDaily(rows.map((d) => ({ day: d.day, litres: d.litres, indexVol: d.indexVol })));
    } catch (e) {
      console.error('[water-history] daily backfill chunk failed:', (e as Error).message);
      return; // stop; a later poll retries the whole backfill (daily_done stays unset)
    }
    cursor = new Date(chunkEnd.getTime() + 86_400_000);
    await sleep(BACKFILL_STEP_DELAY_MS);
  }
  setMeta('water_backfill_daily_done', '1');
  console.log('[water-history] daily backfill complete (24 months)');
}

async function backfillHourly(cfg: ContazaraConfig): Promise<void> {
  const token = await contazara.getToken(cfg);
  const info = await contazara.fetchSubscriberInfo(cfg, token);
  const meter = info?.meters.find((m) => m.serialNumber === cfg.serial) ?? info?.meters[0] ?? null;
  if (!meter) return;
  const now = new Date();
  // Cursor = the oldest day already backfilled (YYYYMMDD); walk backwards from "yesterday"
  // toward BACKFILL_HOURLY_DAYS ago, one day at a time, so a restart resumes cleanly.
  const oldestTarget = new Date(now.getTime() - BACKFILL_HOURLY_DAYS * 86_400_000);
  let cursorStr = getMeta('water_backfill_hourly_cursor');
  let cursor = cursorStr ? new Date(cursorStr.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) : new Date(now.getTime() - 86_400_000);
  let stepsThisRun = 0;
  const MAX_STEPS_PER_RUN = 60; // spread a 90-day backfill over a few poll cycles, not one burst
  while (cursor.getTime() >= oldestTarget.getTime() && stepsThisRun < MAX_STEPS_PER_RUN) {
    const dateStr = contazara.yyyymmdd(cursor);
    try {
      const hours = await contazara.fetchHourly(cfg, token, meter.serialNumber, dateStr);
      if (hours.length > 0) {
        recordWaterHourly(
          hours.map((h) => ({ bucketTs: h.epochSec, litres: h.litres, indexVol: h.indexVol })),
          'contazara-backfill',
        );
      }
      setMeta('water_backfill_hourly_cursor', dateStr);
    } catch (e) {
      console.error(`[water-history] hourly backfill failed for ${dateStr}:`, (e as Error).message);
      return; // retry from this cursor on the next poll cycle
    }
    cursor = new Date(cursor.getTime() - 86_400_000);
    stepsThisRun += 1;
    await sleep(BACKFILL_STEP_DELAY_MS);
  }
  if (cursor.getTime() < oldestTarget.getTime()) {
    setMeta('water_backfill_hourly_done', '1');
    console.log('[water-history] hourly backfill complete (90 days)');
  }
}

// ---- Lifecycle ----------------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | null = null;

function shouldPollNow(pollHours: number): boolean {
  const lastAttempt = Number(getMeta('water_last_poll_attempt_ts') ?? 0);
  if (!Number.isFinite(lastAttempt) || lastAttempt <= 0) return true;
  return Date.now() - lastAttempt >= pollHours * 3600_000;
}

async function tick(): Promise<void> {
  const cfg = contazaraConfig();
  if (!cfg) return; // disabled/unconfigured — no-op
  if (!shouldPollNow(cfg.pollHours)) return;
  await pollOnce();
}

/** Start the water poll/backfill/prune loop. Guarded — never throws into boot. Gated:
 *  a no-op until the owner configures Contazara credentials (checked every tick). */
export function startWaterHistory(): void {
  try {
    if (pollTimer) return;
    const handle = db();
    if (!handle) {
      console.warn('[water-history] not started — store unavailable (water history disabled, API unaffected)');
      return;
    }
    // Boot-check shortly after start (never blocks boot); then check every POLL_CHECK_MS
    // whether it's time to actually poll (cadence = ContazaraConfig.pollHours).
    setTimeout(() => void tick(), 20_000);
    pollTimer = setInterval(() => void tick(), POLL_CHECK_MS);
    console.log('[water-history] started — polls per ContazaraConfig.pollHours (gated until configured)');
  } catch (e) {
    console.error('[water-history] start failed (water history disabled, API unaffected):', (e as Error).message);
  }
}

/** TEST ONLY: force an immediate poll regardless of cadence. */
export function pollNowForTest(): Promise<void> {
  return pollOnce();
}

/** TEST ONLY: run the hourly->daily gap-fill rollup directly (no-op if the DB is unavailable). */
export function rollupDailyFromHourlyGapsForTest(nowSec: number = Math.floor(Date.now() / 1000)): void {
  const handle = db();
  if (handle) rollupDailyFromHourlyGaps(handle, nowSec);
}
