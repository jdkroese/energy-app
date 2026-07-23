// Circuit-breaker usage metering — the sampler + rollups + retention + the
// per-breaker EnergySource resolver. Spec: docs/28 (§4 collector, §5 consumption,
// §6 rollups/retention).
//
// ADDITIVE + READ-ONLY: this NEVER writes a Tuya device and touches no control
// authority. It reads the fleet (one getDevices() per tick) and writes only its
// own SQLite store. Every tick is wrapped so a failure logs and continues — a
// metering fault can never crash the armed battery-control loop in this process.
//
// Cadence: every meteringIntervalSec (env METERING_INTERVAL_SEC, default 60),
// aligned to nothing in particular (the diff math is miss-tolerant). Per metered
// configured breaker we compute the interval's energy_wh (counter-diff preferred,
// power-integration fallback) and insert one cb_raw row inside a single prepared
// transaction. Offline/missing status → SKIP (gap, never write 0).

import * as tuya from '../connectors/tuya';
import type { TuyaDevice, TuyaSpec } from '../connectors/tuya';
import * as store from '../store';
import { TZ } from '../tariff';
import { db, isMeteringEnabled, getMeta, setMeta, type MeteringDb } from '../db/sqlite';

// ---- Tunables ---------------------------------------------------------------

const INTERVAL_SEC = (() => {
  const n = Number(process.env.METERING_INTERVAL_SEC);
  return Number.isFinite(n) && n >= 10 ? Math.floor(n) : 60;
})();
const TICK_MS = INTERVAL_SEC * 1000;
const ROLLUP_MS = 5 * 60 * 1000; // reconcile rollups every 5 min (cheap, idempotent)

// Retention (spec §6): raw 30d, hourly 3y, daily forever.
const RAW_RETENTION_SEC = 30 * 24 * 3600;
const HOURLY_RETENTION_SEC = 3 * 365 * 24 * 3600;

// Breaker categories that carry electrical metering DPs (spec §9).
const BREAKER_CATEGORIES = new Set(['dlq', 'tdq', 'zndb']);

// Electrical DP codes.
const POWER_DP = 'cur_power';
const VOLTAGE_DP = 'cur_voltage';
const CURRENT_DP = 'cur_current';

// Candidate cumulative forward-energy counter DPs, in preference order. `add_ele`
// is the common one on these breakers (spec §9). The exact semantics/scale is the
// one hardware unknown — see ENERGY_COUNTER_SCALE below.
const ENERGY_COUNTER_DPS = ['add_ele', 'forward_energy_total', 'total_forward_energy', 'energy_forward', 'total_energy'];

/**
 * Scale to convert a raw forward-energy counter value → Wh. The Tuya `add_ele`
 * counter is commonly ×0.01 kWh per unit (so raw × 10 = Wh) on these breakers,
 * but the scale varies by firmware (×0.001 kWh is also seen) and this CANNOT be
 * validated without live hardware (spec §9). This single constant centralises the
 * assumption so it is trivially adjustable post-deploy. We ALSO persist the raw
 * scaled counter snapshot (energy_total_wh) every tick, so if this turns out wrong
 * consumption can be recomputed from stored counters with no data loss.
 *
 * Default: 0.01 kWh/unit → 10 Wh/unit.
 */
const ENERGY_COUNTER_WH_PER_UNIT = (() => {
  const n = Number(process.env.METERING_COUNTER_WH_PER_UNIT);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

// Guardrail for counter-diff plausibility: a single interval can't plausibly
// exceed a large breaker rating run flat-out for the interval. 100 A @ 250 V =
// 25 kW → 25000 * (interval_h) Wh, with generous headroom (×2).
const MAX_PLAUSIBLE_W = 25_000 * 2;

// ---- EnergySource resolver (spec §5) ----------------------------------------

type EnergySource =
  | { kind: 'counter'; dp: string }
  | { kind: 'power' }
  | { kind: 'none' };

const sourceCache = new Map<string, EnergySource>();

function statusNum(d: TuyaDevice, code: string): number | null {
  const item = d.status.find((s) => s.code === code);
  if (!item) return null;
  const n = typeof item.value === 'number' ? item.value : Number(item.value);
  return Number.isFinite(n) ? n : null;
}

function hasDp(d: TuyaDevice, code: string): boolean {
  return d.status.some((s) => s.code === code);
}

/**
 * Resolve a breaker's energy source once and cache it (spec §5):
 *   1. a cumulative forward-energy counter DP if present (preferred), else
 *   2. cur_power → power-integration fallback, else
 *   3. 'none' (non-metering breaker → not logged at all).
 */
function resolveSource(d: TuyaDevice): EnergySource {
  const cached = sourceCache.get(d.id);
  if (cached) return cached;
  let src: EnergySource;
  const counterDp = ENERGY_COUNTER_DPS.find((dp) => statusNum(d, dp) !== null);
  if (counterDp) src = { kind: 'counter', dp: counterDp };
  else if (hasDp(d, POWER_DP)) src = { kind: 'power' };
  else src = { kind: 'none' };
  sourceCache.set(d.id, src);
  return src;
}

// ---- Scaling (reuse tuya-generic's spec-scale path conceptually) ------------
// Voltage / current / power use the same deci-unit heuristics as tuya-voltage so
// the logged values match what the Live KPI shows.

function toVolts(raw: number | null): number | null {
  if (raw === null) return null;
  return Math.round((raw > 1000 ? raw / 10 : raw) * 10) / 10;
}
function toWatts(raw: number | null): number | null {
  if (raw === null) return null;
  return Math.round((raw > 100000 ? raw / 10 : raw) * 10) / 10;
}
function toAmps(raw: number | null): number | null {
  if (raw === null) return null;
  return Math.round((raw / 1000) * 100) / 100; // mA → A
}

/** Scaled cumulative counter snapshot in Wh (the spec-scale path). */
function counterToWh(rawUnits: number): number {
  return rawUnits * ENERGY_COUNTER_WH_PER_UNIT;
}

// ---- Per-breaker counter tracking -------------------------------------------
// Last seen cumulative counter (Wh) + the ts of the last raw sample, so a missed
// poll just widens the next diff (miss-tolerant). In-memory only; on boot the
// first tick re-establishes a baseline from the DB's last raw row if present.

interface BreakerState {
  lastCounterWh: number | null;
  lastSampleTs: number | null; // unix seconds
}
const breakerState = new Map<string, BreakerState>();

function seedStateFromDb(handle: MeteringDb): void {
  try {
    const rows = handle
      .prepare(
        `SELECT breaker_id, ts, energy_total_wh FROM cb_raw
         WHERE ts = (SELECT MAX(ts) FROM cb_raw r2 WHERE r2.breaker_id = cb_raw.breaker_id)`,
      )
      .all() as Array<{ breaker_id: string; ts: number; energy_total_wh: number | null }>;
    for (const r of rows) {
      breakerState.set(r.breaker_id, {
        lastCounterWh: typeof r.energy_total_wh === 'number' ? r.energy_total_wh : null,
        lastSampleTs: r.ts,
      });
    }
  } catch {
    /* fail-soft — start cold */
  }
}

// ---- Sampler ----------------------------------------------------------------

/** Minute-aligned unix seconds for `now`. */
function minuteTs(nowMs: number): number {
  return Math.floor(nowMs / 60000) * 60;
}

interface RawRow {
  breaker_id: string;
  ts: number;
  power_w: number | null;
  voltage_v: number | null;
  current_a: number | null;
  energy_wh: number | null;
  energy_total_wh: number | null;
}

/** Compute the cb_raw row for one metered breaker, or null to SKIP (gap). */
function computeRow(d: TuyaDevice, ts: number): RawRow | null {
  if (!d.online) return null; // offline → gap, never 0
  const src = resolveSource(d);
  if (src.kind === 'none') return null; // non-metering → not logged

  const powerW = toWatts(statusNum(d, POWER_DP));
  const voltageV = toVolts(statusNum(d, VOLTAGE_DP));
  const currentA = toAmps(statusNum(d, CURRENT_DP));

  const st = breakerState.get(d.id) ?? { lastCounterWh: null, lastSampleTs: null };
  const dtSec = st.lastSampleTs != null ? ts - st.lastSampleTs : null;

  let energyWh: number | null = null;
  let counterWh: number | null = null;

  if (src.kind === 'counter') {
    const rawUnits = statusNum(d, src.dp);
    if (rawUnits === null) {
      // Counter momentarily missing — skip this tick (gap), keep prior baseline.
      return null;
    }
    counterWh = counterToWh(rawUnits);
    if (st.lastCounterWh != null) {
      const delta = counterWh - st.lastCounterWh;
      const implausible =
        delta < 0 || // counter reset / rollover
        (dtSec != null && dtSec > 0 && delta > (MAX_PLAUSIBLE_W * dtSec) / 3600);
      if (implausible) {
        // Reset/rollover or implausible jump → power-integration fallback for THIS
        // interval (spec §5 guard); the new counter becomes the next baseline.
        energyWh = powerIntegration(powerW, dtSec);
      } else {
        energyWh = delta;
      }
    } else {
      // First sample for this breaker — no diff yet; attribute nothing (baseline).
      energyWh = 0;
    }
  } else {
    // Power-integration source.
    energyWh = powerIntegration(powerW, dtSec);
  }

  // Update in-memory tracking for the next diff.
  breakerState.set(d.id, { lastCounterWh: counterWh ?? st.lastCounterWh, lastSampleTs: ts });

  return {
    breaker_id: d.id,
    ts,
    power_w: powerW,
    voltage_v: voltageV,
    current_a: currentA,
    energy_wh: energyWh != null ? Math.round(energyWh * 1000) / 1000 : null,
    energy_total_wh: counterWh != null ? Math.round(counterWh * 1000) / 1000 : null,
  };
}

/** energy_wh ≈ power_w × Δt_hours, or null when either input is missing. */
function powerIntegration(powerW: number | null, dtSec: number | null): number | null {
  if (powerW == null || dtSec == null || dtSec <= 0) return null;
  return Math.max(0, powerW) * (dtSec / 3600);
}

/** The set of configured breaker ids → device, from the live fleet. */
function configuredBreakers(all: TuyaDevice[]): TuyaDevice[] {
  const configured = store.get().deviceOnboarding.configured;
  return all.filter((d) => configured[d.id] && BREAKER_CATEGORIES.has(d.category));
}

async function sampleTick(): Promise<void> {
  const handle = db();
  if (!handle) return; // metering disabled — no-op
  if (!tuya.isConfigured()) return; // nothing to sample
  let all: TuyaDevice[];
  try {
    all = await tuya.getDevices();
  } catch {
    return; // fleet read failed — skip this tick (gap)
  }
  const breakers = configuredBreakers(all);
  if (breakers.length === 0) return;

  const ts = minuteTs(Date.now());
  const rows: RawRow[] = [];
  for (const d of breakers) {
    try {
      const row = computeRow(d, ts);
      if (row) rows.push(row);
    } catch {
      /* per-breaker fault — skip just this breaker */
    }
  }
  if (rows.length === 0) return;

  try {
    const insert = handle.prepare(
      `INSERT INTO cb_raw (breaker_id, ts, power_w, voltage_v, current_a, energy_wh, energy_total_wh)
       VALUES (@breaker_id, @ts, @power_w, @voltage_v, @current_a, @energy_wh, @energy_total_wh)
       ON CONFLICT(breaker_id, ts) DO UPDATE SET
         power_w = excluded.power_w, voltage_v = excluded.voltage_v,
         current_a = excluded.current_a, energy_wh = excluded.energy_wh,
         energy_total_wh = excluded.energy_total_wh`,
    );
    const tx = handle.transaction((batch: RawRow[]) => {
      for (const r of batch) insert.run(r);
    });
    tx(rows);
  } catch (e) {
    console.error('[metering] sample insert failed:', (e as Error).message);
  }
}

// ---- Rollups (spec §6, idempotent upserts) ----------------------------------

const HOUR_SEC = 3600;

/** Local Europe/Madrid YYYY-MM-DD for a unix-seconds instant. */
function localDay(unixSec: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unixSec * 1000));
}

/**
 * Roll completed hours of cb_raw → cb_hourly. Only COMPLETED hours (strictly
 * before the current hour) are rolled, from the saved cursor forward, so the
 * active hour keeps accumulating. Idempotent upsert; cursor persisted in cb_meta.
 */
function rollupHourly(handle: MeteringDb, nowSec: number): void {
  const curHourStart = Math.floor(nowSec / HOUR_SEC) * HOUR_SEC;
  const cursor = Number(getMeta('hourly_cursor') ?? 0); // last completed hour rolled (bucket_ts)
  const fromExclusive = Number.isFinite(cursor) ? cursor : 0;

  const upsert = handle.prepare(
    `INSERT INTO cb_hourly (breaker_id, bucket_ts, energy_wh, power_avg_w, power_max_w,
                            voltage_avg_v, voltage_min_v, voltage_max_v, samples)
     VALUES (@breaker_id, @bucket_ts, @energy_wh, @power_avg_w, @power_max_w,
             @voltage_avg_v, @voltage_min_v, @voltage_max_v, @samples)
     ON CONFLICT(breaker_id, bucket_ts) DO UPDATE SET
       energy_wh = excluded.energy_wh, power_avg_w = excluded.power_avg_w,
       power_max_w = excluded.power_max_w, voltage_avg_v = excluded.voltage_avg_v,
       voltage_min_v = excluded.voltage_min_v, voltage_max_v = excluded.voltage_max_v,
       samples = excluded.samples`,
  );

  const rows = handle
    .prepare(
      `SELECT breaker_id,
              (ts / ${HOUR_SEC}) * ${HOUR_SEC} AS bucket_ts,
              SUM(COALESCE(energy_wh, 0))      AS energy_wh,
              AVG(power_w)                     AS power_avg_w,
              MAX(power_w)                     AS power_max_w,
              AVG(voltage_v)                   AS voltage_avg_v,
              MIN(voltage_v)                   AS voltage_min_v,
              MAX(voltage_v)                   AS voltage_max_v,
              COUNT(*)                         AS samples
         FROM cb_raw
        WHERE ts >= ? AND ts < ?
        GROUP BY breaker_id, bucket_ts`,
    )
    .all(fromExclusive, curHourStart) as Array<RawHourly>;

  if (rows.length === 0) {
    if (curHourStart > fromExclusive) setMeta('hourly_cursor', String(curHourStart));
    return;
  }
  const tx = handle.transaction((batch: RawHourly[]) => {
    for (const r of batch) upsert.run(roundHourly(r));
  });
  tx(rows);
  setMeta('hourly_cursor', String(curHourStart));
}

interface RawHourly {
  breaker_id: string;
  bucket_ts: number;
  energy_wh: number;
  power_avg_w: number | null;
  power_max_w: number | null;
  voltage_avg_v: number | null;
  voltage_min_v: number | null;
  voltage_max_v: number | null;
  samples: number;
}
function roundHourly(r: RawHourly): RawHourly {
  const rnd = (n: number | null, dp = 1) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);
  return {
    ...r,
    energy_wh: rnd(r.energy_wh, 3) as number,
    power_avg_w: rnd(r.power_avg_w),
    power_max_w: rnd(r.power_max_w),
    voltage_avg_v: rnd(r.voltage_avg_v),
    voltage_min_v: rnd(r.voltage_min_v),
    voltage_max_v: rnd(r.voltage_max_v),
  };
}

/**
 * Roll completed LOCAL days of cb_hourly → cb_daily. Rebuilds each day fully from
 * its hourly buckets (idempotent), but only for days strictly before today
 * (local). Cursor (last day rolled) in cb_meta — but we always also re-roll the
 * most recent completed day to absorb late hourly fills.
 */
function rollupDaily(handle: MeteringDb, nowSec: number): void {
  const today = localDay(nowSec);
  // Candidate completed days: distinct local days present in cb_hourly that are < today.
  const dayRows = handle
    .prepare(`SELECT DISTINCT bucket_ts FROM cb_hourly`)
    .all() as Array<{ bucket_ts: number }>;
  const days = new Set<string>();
  for (const { bucket_ts } of dayRows) {
    const day = localDay(bucket_ts);
    if (day < today) days.add(day);
  }
  if (days.size === 0) return;

  const upsert = handle.prepare(
    `INSERT INTO cb_daily (breaker_id, day, energy_wh, power_avg_w, power_max_w,
                           voltage_avg_v, voltage_min_v, voltage_max_v, samples)
     VALUES (@breaker_id, @day, @energy_wh, @power_avg_w, @power_max_w,
             @voltage_avg_v, @voltage_min_v, @voltage_max_v, @samples)
     ON CONFLICT(breaker_id, day) DO UPDATE SET
       energy_wh = excluded.energy_wh, power_avg_w = excluded.power_avg_w,
       power_max_w = excluded.power_max_w, voltage_avg_v = excluded.voltage_avg_v,
       voltage_min_v = excluded.voltage_min_v, voltage_max_v = excluded.voltage_max_v,
       samples = excluded.samples`,
  );

  // Aggregate hourly buckets per breaker for each completed local day. We bucket
  // in JS (local-day keying) since SQLite has no tz support.
  const allHourly = handle
    .prepare(
      `SELECT breaker_id, bucket_ts, energy_wh, power_avg_w, power_max_w,
              voltage_avg_v, voltage_min_v, voltage_max_v, samples
         FROM cb_hourly`,
    )
    .all() as Array<RawHourly & { bucket_ts: number }>;

  type Acc = {
    breaker_id: string;
    day: string;
    energy_wh: number;
    pSum: number;
    pCount: number;
    power_max_w: number | null;
    vSum: number;
    vCount: number;
    voltage_min_v: number | null;
    voltage_max_v: number | null;
    samples: number;
  };
  const accs = new Map<string, Acc>();
  for (const h of allHourly) {
    const day = localDay(h.bucket_ts);
    if (!days.has(day)) continue;
    const key = `${h.breaker_id} ${day}`;
    let a = accs.get(key);
    if (!a) {
      a = {
        breaker_id: h.breaker_id, day, energy_wh: 0, pSum: 0, pCount: 0, power_max_w: null,
        vSum: 0, vCount: 0, voltage_min_v: null, voltage_max_v: null, samples: 0,
      };
      accs.set(key, a);
    }
    a.energy_wh += h.energy_wh ?? 0;
    if (h.power_avg_w != null) { a.pSum += h.power_avg_w * h.samples; a.pCount += h.samples; }
    if (h.power_max_w != null) a.power_max_w = a.power_max_w == null ? h.power_max_w : Math.max(a.power_max_w, h.power_max_w);
    if (h.voltage_avg_v != null) { a.vSum += h.voltage_avg_v * h.samples; a.vCount += h.samples; }
    if (h.voltage_min_v != null) a.voltage_min_v = a.voltage_min_v == null ? h.voltage_min_v : Math.min(a.voltage_min_v, h.voltage_min_v);
    if (h.voltage_max_v != null) a.voltage_max_v = a.voltage_max_v == null ? h.voltage_max_v : Math.max(a.voltage_max_v, h.voltage_max_v);
    a.samples += h.samples;
  }
  if (accs.size === 0) return;

  const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
  const tx = handle.transaction((list: Acc[]) => {
    for (const a of list) {
      upsert.run({
        breaker_id: a.breaker_id,
        day: a.day,
        energy_wh: Math.round(a.energy_wh * 1000) / 1000,
        power_avg_w: a.pCount ? r1(a.pSum / a.pCount) : null,
        power_max_w: r1(a.power_max_w),
        voltage_avg_v: a.vCount ? r1(a.vSum / a.vCount) : null,
        voltage_min_v: r1(a.voltage_min_v),
        voltage_max_v: r1(a.voltage_max_v),
        samples: a.samples,
      });
    }
  });
  tx([...accs.values()]);
}

/** Delete raw > 30d and hourly > 3y (spec §6). cb_daily kept forever. */
function prune(handle: MeteringDb, nowSec: number): void {
  try {
    handle.prepare('DELETE FROM cb_raw WHERE ts < ?').run(nowSec - RAW_RETENTION_SEC);
    handle.prepare('DELETE FROM cb_hourly WHERE bucket_ts < ?').run(nowSec - HOURLY_RETENTION_SEC);
  } catch (e) {
    console.error('[metering] prune failed:', (e as Error).message);
  }
}

function rollupTick(): void {
  const handle = db();
  if (!handle) return;
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    rollupHourly(handle, nowSec);
  } catch (e) {
    console.error('[metering] hourly rollup failed:', (e as Error).message);
  }
  try {
    rollupDaily(handle, nowSec);
  } catch (e) {
    console.error('[metering] daily rollup failed:', (e as Error).message);
  }
  prune(handle, nowSec);
}

// ---- Lifecycle --------------------------------------------------------------

let sampleTimer: ReturnType<typeof setInterval> | null = null;
let rollupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start metering: open the DB (fail-soft), seed counter baselines from the last
 * stored raw row, then run the sampler + rollup/retention timers. Guarded so an
 * init failure disables metering and never throws into the boot path.
 */
export function startBreakerMetering(): void {
  try {
    if (sampleTimer) return;
    const handle = db();
    if (!handle || !isMeteringEnabled()) {
      console.warn('[metering] not started — store unavailable (metering disabled, API unaffected)');
      return;
    }
    seedStateFromDb(handle);
    // Boot-reconcile any missed rollups immediately, then schedule.
    rollupTick();
    sampleTimer = setInterval(() => void sampleTick().catch((e) => console.error('[metering] sample tick:', (e as Error).message)), TICK_MS);
    rollupTimer = setInterval(() => rollupTick(), ROLLUP_MS);
    // A first sample shortly after boot (lets the fleet cache warm).
    setTimeout(() => void sampleTick().catch(() => {}), 8_000);
    console.log(`[metering] started — sampling every ${INTERVAL_SEC}s, rollups every ${ROLLUP_MS / 60000}min`);
  } catch (e) {
    console.error('[metering] start failed (metering disabled, API unaffected):', (e as Error).message);
  }
}

// Exposed for the query routes / tests.
export { localDay as meteringLocalDay };
