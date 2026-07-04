// One-time solar-history double-count correction (monitoring/data ONLY).
//
// WHY: old /api/live code stored `solarKw = sungrow + tesla`, but the Tesla
// gateway total ALREADY includes the Sungrow (Array A) production. So every
// pre-fix `solarKw` sample double-counts the Sungrow contribution. The fix went
// live at CUTOFF_ISO; rows at/after that instant are already correct.
//
// The correction subtracts the GROUND-TRUTH Sungrow contribution — taken from the
// SEPARATE, un-contaminated per-inverter history (inverter_5m / inverter_hourly /
// inverter_daily) at the SAME tier + SAME bucket — from the contaminated `solarKw`
// field of the whole-house energy history (energy_5m / energy_hourly / energy_daily)
// AND the history-5m.json day chart. All OTHER fields (home/grid/charge/SoC) were
// correct and are NEVER touched.
//
// SAFETY: this module is DATA-ONLY. It touches no control/armed/battery path.
//   • DRY RUN (computeCorrection) writes nothing — pure read + arithmetic.
//   • APPLY backs up every original solar value FIRST (energy_solar_backup table +
//     a JSON-file copy), corrects inside a single transaction, then sets a
//     persistent one-time marker so a second apply no-ops. Any error rolls the
//     transaction back and reports — it can never corrupt the DB.
//
// Correction math per bucket:  corrected = max(0, stored − sungrowContribution)
//   sungrowContribution = Σ inverters of the per-inverter value at the SAME tier +
//   SAME bucket ts (kW for the 5-min tier; kWh for hourly/daily). A bucket with no
//   inverter history → contribution 0 → row unchanged (handles the intermittent
//   contamination correctly).
//
// Clamp caveat: some pre-fix rows were also hit by the 18 kW site clamp; their true
// pre-clamp value can't be reconstructed. We still apply stored−sungrow (best
// effort) but COUNT them separately as "clamped (approximate)".

import { existsSync, copyFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { db, getMeta, setMeta, type MeteringDb } from '../db/sqlite';
import { SITE_SOLAR_CEILING_KW } from '../routes/live';
import {
  HISTORY_SERIES,
  madridDateKey,
  BUCKETS_PER_DAY,
} from '../history5m';

// ---- Constants --------------------------------------------------------------

/**
 * The exact UTC instant the double-count fix went live. Rows with a bucket ts
 * STRICTLY BEFORE this are contaminated and eligible; rows at/after are already
 * correct and are NEVER touched. Keep as a fixed constant (not "now").
 */
export const CUTOFF_ISO = '2026-07-04T10:50:00Z';
export const CUTOFF_MS = Date.parse(CUTOFF_ISO);
export const CUTOFF_SEC = Math.floor(CUTOFF_MS / 1000);

/** Persistent one-time marker (cb_meta) — set once APPLY succeeds. */
export const MARKER_KEY = 'solar_history_corrected_at';

/** Backup table for the original solar values (one row per corrected cell). */
const BACKUP_TABLE = 'energy_solar_backup';

/**
 * A row is treated as clamp-affected (approximate) when its stored solar sits at
 * (or within epsilon of) the 18 kW site ceiling — the true pre-clamp value can't
 * be reconstructed. For the kWh tiers a full clamped hour would be 18 kWh; we use
 * the same ceiling as a conservative "at the ceiling" flag (a real hour rarely
 * reaches it, so a false positive is harmless — it only changes the COUNT label).
 */
const CLAMP_EPSILON = 0.05;

// ---- Pure correction primitives (unit-tested) -------------------------------

/**
 * Corrected solar for one bucket: max(0, stored − sungrow). Pure. `stored` and
 * `sungrow` must be in the SAME unit (kW for 5m, kWh for hourly/daily). A null/
 * non-finite stored value is treated as 0 (nothing to correct).
 */
export function correctedSolar(stored: number | null | undefined, sungrow: number): number {
  const s = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
  const g = Number.isFinite(sungrow) ? sungrow : 0;
  return Math.max(0, s - g);
}

/** Is this bucket ts (unix seconds) eligible — strictly before the cutoff? */
export function isEligibleTs(tsSec: number): boolean {
  return Number.isFinite(tsSec) && tsSec < CUTOFF_SEC;
}

/** Is a stored solar value at/above the site clamp ceiling (→ approximate)? */
export function isClampAffected(stored: number | null | undefined, ceiling = SITE_SOLAR_CEILING_KW): boolean {
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= ceiling - CLAMP_EPSILON;
}

/**
 * Decide the correction for one bucket. Returns whether it CHANGES the value, the
 * corrected value, and whether it was clamp-affected. A bucket that is not eligible
 * (at/after cutoff) or has zero Sungrow contribution does not change.
 */
export interface BucketDecision {
  eligible: boolean;
  changed: boolean;
  before: number;
  after: number;
  sungrow: number;
  clamped: boolean;
}

export function decideBucket(
  tsSec: number,
  stored: number | null | undefined,
  sungrow: number,
): BucketDecision {
  const before = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
  const eligible = isEligibleTs(tsSec);
  if (!eligible) {
    return { eligible: false, changed: false, before, after: before, sungrow, clamped: false };
  }
  const after = correctedSolar(stored, sungrow);
  const changed = Math.abs(after - before) > 1e-9;
  return { eligible: true, changed, before, after, sungrow, clamped: isClampAffected(stored) };
}

// ---- Summary shapes ---------------------------------------------------------

export interface TierSummary {
  tier: 'json' | '5m' | 'hourly' | 'daily';
  /** kW (json/5m) or kWh (hourly/daily) — labels the totals' unit. */
  unit: 'kW' | 'kWh';
  rowsExamined: number;
  rowsEligible: number;
  rowsChanged: number;
  clampedApprox: number;
  /** Σ solar over the tier BEFORE / AFTER (kW-sum for 5m/json, kWh for hourly/daily). */
  totalBefore: number;
  totalAfter: number;
  samples: Array<{ ts: number; iso: string; before: number; after: number; sungrow: number; clamped: boolean }>;
}

export interface CorrectionSummary {
  cutoffIso: string;
  alreadyApplied: boolean;
  appliedAt: string | null;
  applied: boolean;
  storeAvailable: boolean;
  tiers: TierSummary[];
  /** Set only when an APPLY failed and rolled back — the marker stays unset. */
  error?: string;
}

// ---- Sungrow contribution lookups (per tier) --------------------------------

/** Map of 5-min bucket ts → Σ inverter ac_kw at that ts (contribution in kW). */
function sungrow5mByTs(handle: MeteringDb): Map<number, number> {
  const rows = handle
    .prepare(`SELECT ts, SUM(COALESCE(ac_kw, 0)) AS kw FROM inverter_5m WHERE ts < ? GROUP BY ts`)
    .all(CUTOFF_SEC) as Array<{ ts: number; kw: number }>;
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.ts, r.kw);
  return m;
}

/** Map of hour bucket_ts → Σ inverter ac_kwh at that hour (contribution in kWh). */
function sungrowHourlyByTs(handle: MeteringDb): Map<number, number> {
  const rows = handle
    .prepare(`SELECT bucket_ts, SUM(COALESCE(ac_kwh, 0)) AS kwh FROM inverter_hourly WHERE bucket_ts < ? GROUP BY bucket_ts`)
    .all(CUTOFF_SEC) as Array<{ bucket_ts: number; kwh: number }>;
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.bucket_ts, r.kwh);
  return m;
}

/** Map of Madrid day → Σ inverter ac_kwh for that day (contribution in kWh). */
function sungrowDailyByDay(handle: MeteringDb): Map<string, number> {
  const rows = handle
    .prepare(`SELECT day, SUM(COALESCE(ac_kwh, 0)) AS kwh FROM inverter_daily GROUP BY day`)
    .all() as Array<{ day: string; kwh: number }>;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.day, r.kwh);
  return m;
}

// ---- history-5m.json helpers ------------------------------------------------

import { dirname, resolve } from 'node:path';

/** Resolve the history-5m.json path (mirrors history5m.ts historyPath()). */
export function history5mPath(): string {
  if (process.env.HISTORY_5M_FILE) return process.env.HISTORY_5M_FILE;
  if (process.env.STATE_FILE) return resolve(dirname(process.env.STATE_FILE), 'history-5m.json');
  if (process.env.NODE_ENV === 'production') return '/opt/energy/history-5m.json';
  const repoRoot =
    typeof __dirname !== 'undefined'
      ? resolve(__dirname, '..', '..', '..')
      : resolve(process.cwd(), '..', '..');
  return resolve(repoRoot, '.data', 'history-5m.json');
}

interface JsonDay {
  date: string;
  series: Record<string, (number | null)[]>;
  seen: number[];
}
interface JsonFile {
  v: 1;
  days: Record<string, JsonDay>;
}

/**
 * Unix-seconds start of bucket `idx` (0..287) on Madrid day `dateKey`. Copy of
 * history5m's private madridBucketStartTs (DST-aware probe) so we can key JSON
 * buckets to the same instant the inverter_5m tier uses.
 */
export function madridBucketStartTs(dateKey: string, idx: number): number | null {
  const baseMs = Date.parse(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(baseMs)) return null;
  const hh = Math.floor(idx / 12);
  const mm = (idx % 12) * 5;
  for (const offH of [2, 1, 0]) {
    const cand = baseMs + (hh - offH) * 3600_000 + mm * 60_000;
    const d = new Date(cand);
    if (madridDateKey(d) === dateKey && madridBucketIndexUtc(d) === idx) return Math.floor(cand / 1000);
  }
  return Math.floor((baseMs + (hh - 1) * 3600_000 + mm * 60_000) / 1000);
}

function madridBucketIndexUtc(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const idx = hh * 12 + Math.floor(mm / 5);
  return Math.max(0, Math.min(BUCKETS_PER_DAY - 1, idx));
}

function readJsonFile(path: string): JsonFile | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<JsonFile>;
    if (!raw || typeof raw !== 'object' || !raw.days) return null;
    return { v: 1, days: raw.days as Record<string, JsonDay> };
  } catch {
    return null;
  }
}

// ---- Backup table -----------------------------------------------------------

/** Create the backup table (idempotent). One row per corrected cell. */
function ensureBackupTable(handle: MeteringDb): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (
      tier       TEXT    NOT NULL,   -- '5m' | 'hourly' | 'daily'
      bucket_key TEXT    NOT NULL,   -- ts (5m/hourly) or day (daily), as text
      old_solar  REAL,               -- original stored solar (kW or kWh)
      new_solar  REAL,               -- corrected value written
      sungrow    REAL,               -- contribution subtracted
      clamped    INTEGER NOT NULL,   -- 1 if clamp-affected (approximate)
      backed_up_at TEXT NOT NULL,
      PRIMARY KEY (tier, bucket_key)
    );
  `);
}

// ---- Core: compute correction (DRY RUN, writes nothing) ---------------------

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

interface TierPlanRow {
  tier: '5m' | 'hourly' | 'daily';
  bucketKey: string; // ts or day, as text
  tsSec: number; // instant for the sample iso
  before: number;
  after: number;
  sungrow: number;
  clamped: boolean;
  changed: boolean;
}

/** Build the per-tier correction plan from the SQLite tiers (no writes). */
function planSqliteTiers(handle: MeteringDb): {
  rows: TierPlanRow[];
  summaries: { '5m': TierSummary; hourly: TierSummary; daily: TierSummary };
} {
  const sg5m = sungrow5mByTs(handle);
  const sgHourly = sungrowHourlyByTs(handle);
  const sgDaily = sungrowDailyByDay(handle);

  const rows: TierPlanRow[] = [];
  const mk = (tier: TierSummary['tier'], unit: TierSummary['unit']): TierSummary => ({
    tier,
    unit,
    rowsExamined: 0,
    rowsEligible: 0,
    rowsChanged: 0,
    clampedApprox: 0,
    totalBefore: 0,
    totalAfter: 0,
    samples: [],
  });
  const s5 = mk('5m', 'kW');
  const sH = mk('hourly', 'kWh');
  const sD = mk('daily', 'kWh');

  const pushSample = (sum: TierSummary, tsSec: number, d: BucketDecision) => {
    if (sum.samples.length < 5 && d.changed) {
      sum.samples.push({
        ts: tsSec,
        iso: new Date(tsSec * 1000).toISOString(),
        before: r3(d.before),
        after: r3(d.after),
        sungrow: r3(d.sungrow),
        clamped: d.clamped,
      });
    }
  };

  // 5m tier (kW). Only rows before the cutoff.
  const r5 = handle
    .prepare(`SELECT ts, solar_kw FROM energy_5m WHERE ts < ? ORDER BY ts ASC`)
    .all(CUTOFF_SEC) as Array<{ ts: number; solar_kw: number | null }>;
  for (const r of r5) {
    const sungrow = sg5m.get(r.ts) ?? 0;
    const d = decideBucket(r.ts, r.solar_kw, sungrow);
    s5.rowsExamined++;
    s5.totalBefore += d.before;
    s5.totalAfter += d.after;
    if (d.eligible) s5.rowsEligible++;
    if (d.changed) {
      s5.rowsChanged++;
      if (d.clamped) s5.clampedApprox++;
      rows.push({ tier: '5m', bucketKey: String(r.ts), tsSec: r.ts, before: d.before, after: d.after, sungrow: d.sungrow, clamped: d.clamped, changed: true });
    }
    pushSample(s5, r.ts, d);
  }

  // hourly tier (kWh).
  const rH = handle
    .prepare(`SELECT bucket_ts, solar_kwh FROM energy_hourly WHERE bucket_ts < ? ORDER BY bucket_ts ASC`)
    .all(CUTOFF_SEC) as Array<{ bucket_ts: number; solar_kwh: number | null }>;
  for (const r of rH) {
    const sungrow = sgHourly.get(r.bucket_ts) ?? 0;
    const d = decideBucket(r.bucket_ts, r.solar_kwh, sungrow);
    sH.rowsExamined++;
    sH.totalBefore += d.before;
    sH.totalAfter += d.after;
    if (d.eligible) sH.rowsEligible++;
    if (d.changed) {
      sH.rowsChanged++;
      if (d.clamped) sH.clampedApprox++;
      rows.push({ tier: 'hourly', bucketKey: String(r.bucket_ts), tsSec: r.bucket_ts, before: d.before, after: d.after, sungrow: d.sungrow, clamped: d.clamped, changed: true });
    }
    pushSample(sH, r.bucket_ts, d);
  }

  // daily tier (kWh). Keyed by Madrid day; eligible when the day is strictly
  // before the cutoff DAY (a day fully at/after the cutoff is already correct).
  const cutoffDay = madridDateKey(new Date(CUTOFF_MS));
  const rD = handle
    .prepare(`SELECT day, solar_kwh FROM energy_daily ORDER BY day ASC`)
    .all() as Array<{ day: string; solar_kwh: number | null }>;
  for (const r of rD) {
    // Represent the day instant as local ~noon (matches energy-history dayToTs)
    // purely for the sample iso; eligibility uses the day-string compare.
    const tsSec = Math.floor(Date.parse(`${r.day}T12:00:00Z`) / 1000);
    const dayEligible = r.day < cutoffDay;
    const sungrow = sgDaily.get(r.day) ?? 0;
    const before = typeof r.solar_kwh === 'number' && Number.isFinite(r.solar_kwh) ? r.solar_kwh : 0;
    const after = dayEligible ? correctedSolar(r.solar_kwh, sungrow) : before;
    const changed = dayEligible && Math.abs(after - before) > 1e-9;
    const clamped = dayEligible && isClampAffected(r.solar_kwh);
    sD.rowsExamined++;
    sD.totalBefore += before;
    sD.totalAfter += after;
    if (dayEligible) sD.rowsEligible++;
    if (changed) {
      sD.rowsChanged++;
      if (clamped) sD.clampedApprox++;
      rows.push({ tier: 'daily', bucketKey: r.day, tsSec, before, after, sungrow, clamped, changed: true });
      if (sD.samples.length < 5) {
        sD.samples.push({ ts: tsSec, iso: new Date(tsSec * 1000).toISOString(), before: r3(before), after: r3(after), sungrow: r3(sungrow), clamped });
      }
    }
  }

  for (const s of [s5, sH, sD]) {
    s.totalBefore = r3(s.totalBefore);
    s.totalAfter = r3(s.totalAfter);
  }
  return { rows, summaries: { '5m': s5, hourly: sH, daily: sD } };
}

/**
 * Plan the history-5m.json correction (no writes). Returns the tier summary + the
 * mutated file object (so APPLY can persist the SAME object it summarised). The
 * SQLite inverter_5m tier is the Sungrow source (kW) — same instant keying.
 */
function planJson(handle: MeteringDb | null): { summary: TierSummary; mutated: JsonFile | null; path: string } {
  const path = history5mPath();
  const summary: TierSummary = {
    tier: 'json',
    unit: 'kW',
    rowsExamined: 0,
    rowsEligible: 0,
    rowsChanged: 0,
    clampedApprox: 0,
    totalBefore: 0,
    totalAfter: 0,
    samples: [],
  };
  const parsed = readJsonFile(path);
  if (!parsed) return { summary, mutated: null, path };
  const sg5m = handle ? sungrow5mByTs(handle) : new Map<number, number>();

  const mutated: JsonFile = { v: 1, days: {} };
  for (const [dayKey, day] of Object.entries(parsed.days)) {
    const solar = Array.isArray(day.series?.solarKw) ? [...day.series.solarKw] : null;
    const seen = Array.isArray(day.seen) ? day.seen : [];
    // Deep-copy the day so we can mutate solar without touching the source object.
    const outDay: JsonDay = {
      date: day.date ?? dayKey,
      series: {},
      seen: [...seen],
    };
    for (const k of Object.keys(day.series ?? {})) outDay.series[k] = [...(day.series[k] ?? [])];

    if (solar) {
      for (let i = 0; i < solar.length; i++) {
        if ((seen[i] ?? 0) <= 0) continue; // only seen buckets hold a real value
        const tsSec = madridBucketStartTs(dayKey, i);
        if (tsSec == null) continue;
        const stored = solar[i];
        const before = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
        summary.rowsExamined++;
        summary.totalBefore += before;
        if (!isEligibleTs(tsSec)) {
          summary.totalAfter += before;
          continue;
        }
        summary.rowsEligible++;
        const sungrow = sg5m.get(tsSec) ?? 0;
        const after = correctedSolar(stored, sungrow);
        summary.totalAfter += after;
        if (Math.abs(after - before) > 1e-9) {
          outDay.series.solarKw[i] = after;
          summary.rowsChanged++;
          const clamped = isClampAffected(stored);
          if (clamped) summary.clampedApprox++;
          if (summary.samples.length < 5) {
            summary.samples.push({ ts: tsSec, iso: new Date(tsSec * 1000).toISOString(), before: r3(before), after: r3(after), sungrow: r3(sungrow), clamped });
          }
        }
      }
    }
    mutated.days[dayKey] = outDay;
  }
  summary.totalBefore = r3(summary.totalBefore);
  summary.totalAfter = r3(summary.totalAfter);
  return { summary, mutated, path };
}

// ---- Public: DRY RUN --------------------------------------------------------

/**
 * Compute the correction summary WITHOUT writing anything. Pure read + arithmetic.
 * Safe to call repeatedly. Reports whether the marker says it was already applied.
 */
export function computeCorrection(): CorrectionSummary {
  const handle = db();
  const appliedAt = getMeta(MARKER_KEY);
  const alreadyApplied = appliedAt != null;
  if (!handle) {
    // Store unavailable: still try the JSON tier (its Sungrow source is empty → no
    // change), so the summary is coherent.
    const j = planJson(null);
    return {
      cutoffIso: CUTOFF_ISO,
      alreadyApplied,
      appliedAt,
      applied: false,
      storeAvailable: false,
      tiers: [j.summary, blankTier('5m', 'kW'), blankTier('hourly', 'kWh'), blankTier('daily', 'kWh')],
    };
  }
  const { summaries } = planSqliteTiers(handle);
  const j = planJson(handle);
  return {
    cutoffIso: CUTOFF_ISO,
    alreadyApplied,
    appliedAt,
    applied: false,
    storeAvailable: true,
    tiers: [j.summary, summaries['5m'], summaries.hourly, summaries.daily],
  };
}

function blankTier(tier: TierSummary['tier'], unit: TierSummary['unit']): TierSummary {
  return { tier, unit, rowsExamined: 0, rowsEligible: 0, rowsChanged: 0, clampedApprox: 0, totalBefore: 0, totalAfter: 0, samples: [] };
}

// ---- Public: APPLY (idempotent, backed-up, transactional) -------------------

/**
 * Apply the correction ONCE. If the marker says already-applied → no-op, return
 * the current (already-corrected) dry-run summary with alreadyApplied:true. Else:
 *   1. back up every original solar value (SQLite backup table + JSON file copy),
 *   2. apply all SQLite corrections in ONE transaction,
 *   3. persist the corrected history-5m.json (atomic tmp+rename),
 *   4. set the persistent one-time marker.
 * Any error rolls the SQLite transaction back and reports; the DB is never left
 * partially corrected (the marker is only set after everything succeeds).
 */
export function applyCorrection(): CorrectionSummary {
  const existing = getMeta(MARKER_KEY);
  if (existing != null) {
    // Already applied — return the current summary (now a no-op re-run).
    const s = computeCorrection();
    return { ...s, alreadyApplied: true, applied: false, appliedAt: existing };
  }

  const handle = db();
  if (!handle) {
    // No store → we can still correct the JSON file alone, but the marker lives in
    // cb_meta which needs the DB. Without the DB we cannot set the one-time marker
    // safely, so refuse rather than risk a non-idempotent JSON-only apply.
    const s = computeCorrection();
    return { ...s, applied: false, storeAvailable: false };
  }

  ensureBackupTable(handle);
  const { rows } = planSqliteTiers(handle);
  const json = planJson(handle);
  const nowIso = new Date().toISOString();

  const backupIns = handle.prepare(
    `INSERT INTO ${BACKUP_TABLE} (tier, bucket_key, old_solar, new_solar, sungrow, clamped, backed_up_at)
       VALUES (@tier, @bucket_key, @old_solar, @new_solar, @sungrow, @clamped, @backed_up_at)
     ON CONFLICT(tier, bucket_key) DO NOTHING`,
  );
  const up5m = handle.prepare(`UPDATE energy_5m SET solar_kw = ? WHERE ts = ?`);
  const upHourly = handle.prepare(`UPDATE energy_hourly SET solar_kwh = ? WHERE bucket_ts = ?`);
  const upDaily = handle.prepare(`UPDATE energy_daily SET solar_kwh = ? WHERE day = ?`);

  const tx = handle.transaction((plan: TierPlanRow[]) => {
    for (const p of plan) {
      backupIns.run({
        tier: p.tier,
        bucket_key: p.bucketKey,
        old_solar: r3(p.before),
        new_solar: r3(p.after),
        sungrow: r3(p.sungrow),
        clamped: p.clamped ? 1 : 0,
        backed_up_at: nowIso,
      });
      if (p.tier === '5m') up5m.run(r3(p.after), Number(p.bucketKey));
      else if (p.tier === 'hourly') upHourly.run(r3(p.after), Number(p.bucketKey));
      else upDaily.run(r3(p.after), p.bucketKey);
    }
  });

  try {
    tx(rows);
    // JSON: back up the original file (once), then write the corrected copy atomically.
    if (json.mutated) {
      writeJsonBackupAndCorrected(json.path, json.mutated);
    }
    // One-time marker LAST — only after all writes succeeded.
    setMeta(MARKER_KEY, nowIso);
  } catch (e) {
    // The SQLite tx auto-rolls back on throw; report and leave the marker UNSET so a
    // retry is possible. Fail-soft — never rethrow into a shared process.
    const summary = computeCorrection();
    return {
      ...summary,
      applied: false,
      appliedAt: null,
      alreadyApplied: false,
      storeAvailable: true,
      error: (e as Error).message,
    };
  }

  // Re-read the now-corrected state for the returned summary.
  const after = computeCorrection();
  return { ...after, applied: true, alreadyApplied: false, appliedAt: nowIso };
}

/** Back up history-5m.json (once) then write the corrected object atomically. */
function writeJsonBackupAndCorrected(path: string, mutated: JsonFile): void {
  const backupPath = `${path}.solar-correction-backup`;
  try {
    if (existsSync(path) && !existsSync(backupPath)) copyFileSync(path, backupPath);
  } catch (e) {
    // A failed backup must abort the JSON write (don't overwrite without a backup).
    throw new Error(`history-5m.json backup failed: ${(e as Error).message}`);
  }
  const tmp = `${path}.${process.pid}.correction.tmp`;
  writeFileSync(tmp, JSON.stringify(mutated), 'utf8');
  renameSync(tmp, path); // atomic replace on the same filesystem
}
