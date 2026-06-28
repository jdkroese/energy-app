// Solar geometry + a self-learning performance-ratio (PR) model for the roof.
//
// Two jobs:
//  1) Solar geometry — solar elevation θ for the site (lat/lon, day-of-year,
//     Madrid hour) and a Haurwitz clear-sky GHI reference. The brain plan uses
//     these to turn measured shortwave radiation into a 0–100 "sun intensity".
//  2) Learned PR — once a night (Madrid midnight) we ingest the day's MEASURED
//     solar production (history5m) against a modelled base (GHI/1000·kWp, PR=1)
//     and update a per-month learned PR so genKwh predictions track the real
//     roof (orientation, shading, soiling, inverter losses) over time.
//
// State is persisted to .data/solar-model.json with an atomic write (tmp +
// rename) mirroring history5m.ts so it never bloats the hot state.json.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config';
import { weatherCoords } from './runtime-config';
import * as history from './history5m';
import * as weather from './connectors/weather';

// ---- Constants -------------------------------------------------------------

/** Seeded / fallback performance ratio when we have no learned data yet. */
export const DEFAULT_PR = 0.82;
/** Days of measured data at which the learned PR is fully trusted. */
const FULL_CONFIDENCE_DAYS = 20;
const DEG = Math.PI / 180;
const TZ = 'Europe/Madrid';

// ---- Madrid time helpers ---------------------------------------------------

function madridHour(d: Date): number {
  return (
    Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d),
    ) % 24
  );
}

/** Madrid-local day-of-year (1..366) for a Date. */
export function madridDayOfYear(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = Number(parts.find((p) => p.type === 'year')?.value ?? '2000');
  const m = Number(parts.find((p) => p.type === 'month')?.value ?? '1');
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? '1');
  const start = Date.UTC(y, 0, 1);
  const cur = Date.UTC(y, m - 1, day);
  return Math.floor((cur - start) / 86400000) + 1;
}

/** Madrid-local month key "YYYY-MM" for a Date. */
export function madridMonthKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' })
    .format(d)
    .slice(0, 7);
}

/** Short month label for a "YYYY-MM" key (or current month if omitted). */
export function monthLabel(key: string): string {
  const m = Number(key.slice(5, 7));
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[(m - 1 + 12) % 12] ?? key;
}

// ---- Solar geometry --------------------------------------------------------

/**
 * Solar elevation angle (degrees, can be negative below the horizon) for the
 * site at a given Madrid local hour and day-of-year. Standard NOAA-style
 * declination + hour-angle approximation; good enough for an intensity gauge.
 */
export function solarElevationDeg(hourLocal: number, dayOfYear: number, lat: number): number {
  // Solar declination (deg).
  const decl = 23.45 * Math.sin(DEG * (360 * (284 + dayOfYear)) / 365);
  // Hour angle: 0 at solar noon (~13:00 Madrid in summer DST, ~12:00 winter).
  // We approximate solar noon at 13:00 local to keep it timezone-simple; the
  // intensity is a clamped ratio so small noon offsets wash out.
  const solarNoon = 13;
  const hourAngle = 15 * (hourLocal - solarNoon); // deg
  const sinElev =
    Math.sin(DEG * lat) * Math.sin(DEG * decl) +
    Math.cos(DEG * lat) * Math.cos(DEG * decl) * Math.cos(DEG * hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinElev))) / DEG;
}

/**
 * Haurwitz clear-sky GHI (W/m²) for a solar elevation angle.
 * GHIc = 1098·sinθ·exp(−0.059/sinθ), 0 when the sun is below the horizon.
 */
export function haurwitzGHI(elevationDeg: number): number {
  if (elevationDeg <= 0) return 0;
  const sinTheta = Math.sin(DEG * elevationDeg);
  if (sinTheta <= 0) return 0;
  return Math.max(0, 1098 * sinTheta * Math.exp(-0.059 / sinTheta));
}

/**
 * Compute sunrise and sunset for a location and date.
 * Returns minutes-since-local-midnight (system timezone, which is Europe/Madrid).
 * NOAA algorithm, accurate to ±2 minutes.
 */
export function sunriseSunsetMin(
  lat: number,
  lon: number,
  date: Date,
): { sunriseMin: number; sunsetMin: number } {
  const JD = date.getTime() / 86400000 + 2440587.5;
  const n = JD - 2451545.0;
  const L = ((280.46 + 0.9856474 * n) % 360 + 360) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360 + 360) % 360;
  const gR = g * DEG;
  const lam = (L + 1.915 * Math.sin(gR) + 0.02 * Math.sin(2 * gR)) * DEG;
  const eps = 23.439 * DEG;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lam));
  const RA = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  let eqT = L * DEG - RA;
  while (eqT > Math.PI) eqT -= 2 * Math.PI;
  while (eqT < -Math.PI) eqT += 2 * Math.PI;
  const eqTMin = (eqT * 180) / Math.PI / 15 * 60; // minutes
  const solarNoonUTC = 720 - lon * 4 - eqTMin;
  const latR = lat * DEG;
  const cosHA =
    (Math.sin(-0.833 * DEG) - Math.sin(latR) * Math.sin(decl)) /
    (Math.cos(latR) * Math.cos(decl));
  if (cosHA < -1) return { sunriseMin: 0, sunsetMin: 1440 };
  if (cosHA > 1) return { sunriseMin: 720, sunsetMin: 720 };
  const HA = (Math.acos(cosHA) * 180) / Math.PI * 4; // → minutes of arc-time
  const utcOffMin = -date.getTimezoneOffset();
  return {
    sunriseMin: Math.round(solarNoonUTC - HA + utcOffMin),
    sunsetMin: Math.round(solarNoonUTC + HA + utcOffMin),
  };
}

/**
 * 24-length hourly sun-intensity (%) for a day, from MEASURED shortwave radiation
 * vs the Haurwitz clear-sky reference. 0 below the horizon; clamped 0..100.
 */
export function sunIntensityForDay(actualShortwave: number[], date: Date, lat: number): number[] {
  const doy = madridDayOfYear(date);
  return Array.from({ length: 24 }, (_, h) => {
    const elev = solarElevationDeg(h, doy, lat);
    const ghiC = haurwitzGHI(elev);
    if (elev <= 0 || ghiC <= 0) return 0;
    const actual = actualShortwave[h] ?? 0;
    return Math.max(0, Math.min(100, Math.round((actual / ghiC) * 100)));
  });
}

// ---- Persisted learned-PR model -------------------------------------------

interface MonthRecord {
  /** Learned performance ratio for this month, clamped 0.5..0.95. */
  pr: number;
  /** Distinct days ingested for this month (drives confidence). */
  days: number;
}

interface ModelFile {
  v: 1;
  /** Per-month "YYYY-MM" → learned record. */
  months: Record<string, MonthRecord>;
  /** Day keys already ingested (so a re-run never double-counts). */
  ingested: string[];
}

let cache: ModelFile | null = null;
let path: string | null = null;

function modelPath(): string {
  if (process.env.SOLAR_MODEL_FILE) return process.env.SOLAR_MODEL_FILE;
  if (process.env.STATE_FILE) return resolve(dirname(process.env.STATE_FILE), 'solar-model.json');
  if (process.env.NODE_ENV === 'production') return '/opt/energy/solar-model.json';
  // __dirname exists in the CJS prod bundle (repoRoot = src/../../..); under tsx/ESM
  // dev it's undefined, so derive repoRoot from cwd (the dev server runs in apps/api).
  const repoRoot =
    typeof __dirname !== 'undefined'
      ? resolve(__dirname, '..', '..', '..')
      : resolve(process.cwd(), '..', '..');
  return resolve(repoRoot, '.data', 'solar-model.json');
}

function file(): string {
  if (!path) path = modelPath();
  return path;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function load(): ModelFile {
  if (cache) return cache;
  const f = file();
  let seeded = false;
  try {
    if (existsSync(f)) {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<ModelFile>;
      cache = hydrate(raw);
    } else {
      // First run, no persisted model: warm-start from the existing 30-day 5-min
      // history instead of a cold PR=0.82 with zero confidence.
      cache = { v: 1, months: {}, ingested: [] };
      seeded = backfillFromHistory(cache);
    }
  } catch (e) {
    console.error('[solar-model] load failed, starting empty:', (e as Error).message);
    cache = { v: 1, months: {}, ingested: [] };
  }
  // Persist the seeded model once so the backfill runs at first load, not every boot.
  if (seeded) persist(cache);
  return cache;
}

/**
 * One-time warm start: BACKFILL the learned model from the existing 30-day 5-min
 * history (history5m). For each retained day we derive the day's PR exactly as the
 * nightly ingest does (median actual/clear-sky base over daytime hours) and fold it
 * into its month, marking the day ingested so the nightly path never double-counts.
 * Returns true if it produced any data (so the caller persists). A house with no
 * history yields nothing and we fall back cleanly to the cold-start (PR=0.82, conf 0).
 */
function backfillFromHistory(state: ModelFile): boolean {
  let dayKeys: string[];
  try {
    dayKeys = history.availableDayKeys();
  } catch {
    return false;
  }
  if (dayKeys.length === 0) return false;

  let changed = false;
  for (const dateKey of dayKeys) {
    if (state.ingested.includes(dateKey)) continue;
    const dayPR = dayPRFromHistory(dateKey);
    state.ingested.push(dateKey); // mark seen either way so nightly won't re-touch it
    if (dayPR === null) continue; // no usable daytime production that day
    const monthKey = madridMonthKey(new Date(`${dateKey}T12:00:00`));
    applyDayPR(state, monthKey, dayPR);
    changed = true;
  }
  prune(state);
  if (changed) {
    const months = Object.keys(state.months).length;
    console.log(
      `[solar-model] backfilled ${dayKeys.length} history day(s) → ${months} month(s) seeded`,
    );
  }
  return changed;
}

function hydrate(raw: Partial<ModelFile>): ModelFile {
  const out: ModelFile = { v: 1, months: {}, ingested: [] };
  if (raw && typeof raw === 'object') {
    if (raw.months && typeof raw.months === 'object') {
      for (const [k, rec] of Object.entries(raw.months)) {
        const r = rec as Partial<MonthRecord>;
        if (typeof r?.pr === 'number' && Number.isFinite(r.pr)) {
          out.months[k] = {
            pr: clamp(r.pr, 0.5, 0.95),
            days: typeof r.days === 'number' && Number.isFinite(r.days) ? Math.max(0, Math.round(r.days)) : 0,
          };
        }
      }
    }
    if (Array.isArray(raw.ingested)) {
      out.ingested = raw.ingested.filter((x): x is string => typeof x === 'string');
    }
  }
  return out;
}

function persist(state: ModelFile): void {
  const f = file();
  try {
    const dir = dirname(f);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, f);
  } catch (e) {
    console.error('[solar-model] persist failed:', (e as Error).message);
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---- Public model API ------------------------------------------------------

/**
 * Effective performance ratio + confidence for a month key (defaults to the
 * current Madrid month). Blends the seed PR with the learned PR by confidence:
 *   confidence = min(1, days/20)
 *   PR_eff     = 0.82·(1−confidence) + learnedPR·confidence
 */
export function effectivePR(monthKey?: string): { prEff: number; confidence: number; days: number; month: string } {
  const key = monthKey ?? madridMonthKey(new Date());
  const rec = load().months[key];
  const days = rec?.days ?? 0;
  const confidence = Math.min(1, days / FULL_CONFIDENCE_DAYS);
  const learnedPR = rec?.pr ?? DEFAULT_PR;
  const prEff = DEFAULT_PR * (1 - confidence) + learnedPR * confidence;
  return { prEff: clamp(prEff, 0.5, 0.95), confidence, days, month: key };
}

/**
 * Compute a single day's measured performance ratio against the Haurwitz
 * clear-sky base, or null when the day has no usable daytime production.
 *
 * Aggregates measured solarKw (288 5-min buckets) → 24 hourly mean kW ≈ kWh/h,
 * then over DAYTIME hours takes the median of actual/(GHIc/1000·kWp) (PR=1 base).
 * Shared by the nightly ingest and the one-time history backfill so both seed
 * the learned PR identically.
 */
function dayPRFromHistory(dateKey: string): number | null {
  const series = history.getDay(dateKey);
  if (!series) return null;

  // Aggregate measured solarKw (288 5-min buckets) → 24 hourly mean kW ≈ kWh/h.
  const hourlyActualKwh = new Array<number>(24).fill(0);
  const hourlyCount = new Array<number>(24).fill(0);
  series.solarKw.forEach((kw, bucket) => {
    const hour = Math.floor(bucket / 12);
    if (hour < 24) {
      hourlyActualKwh[hour] += kw;
      hourlyCount[hour] += 1;
    }
  });
  for (let h = 0; h < 24; h++) {
    hourlyActualKwh[h] = hourlyCount[h] > 0 ? hourlyActualKwh[h] / hourlyCount[h] : 0;
  }

  // Modelled clear-sky-derived base: we don't store past radiation, so use the
  // Haurwitz clear-sky GHI as the modelled base. The ratio actual/base then
  // captures the combined roof+weather performance for that day; the per-month
  // median smooths weather out over many days into a stable PR.
  const date = new Date(`${dateKey}T12:00:00`);
  const doy = madridDayOfYear(date);
  const { lat } = weatherCoords();
  const kwp = config.site.solarKwp;

  const ratios: number[] = [];
  for (let h = 0; h < 24; h++) {
    const elev = solarElevationDeg(h, doy, lat);
    const ghiC = haurwitzGHI(elev);
    if (elev <= 5 || ghiC <= 50) continue; // daytime only, skip twilight
    const base = (ghiC / 1000) * kwp; // PR=1 modelled kW
    if (base <= 0.1) continue;
    const ratio = hourlyActualKwh[h] / base;
    if (Number.isFinite(ratio) && ratio > 0) ratios.push(ratio);
  }
  if (ratios.length === 0) return null;
  return clamp(median(ratios), 0.5, 0.95);
}

/** Fold one day's PR into the month record as a day-weighted running mean. */
function applyDayPR(state: ModelFile, monthKey: string, dayPR: number): void {
  const rec = state.months[monthKey] ?? { pr: dayPR, days: 0 };
  // Running median proxy: blend the new day's PR into the stored PR weighted by
  // accumulated days (stable, monotone toward the true median over many days).
  const newDays = rec.days + 1;
  rec.pr = clamp((rec.pr * rec.days + dayPR) / newDays, 0.5, 0.95);
  rec.days = newDays;
  state.months[monthKey] = rec;
}

/**
 * Ingest a single finished day (Madrid YYYY-MM-DD) into the learned model.
 * Compares the day's measured solar against the modelled base GHI/1000·kWp
 * (PR=1) over DAYTIME hours, then updates the month's learned PR =
 * clamp(median(actual/base), 0.5, 0.95). Idempotent: a day already ingested is
 * skipped. Returns true if it updated the model.
 */
export async function ingestDay(dateKey: string): Promise<boolean> {
  const state = load();
  if (state.ingested.includes(dateKey)) return false;

  const series = history.getDay(dateKey);
  if (!series) return false;

  const dayPR = dayPRFromHistory(dateKey);
  if (dayPR === null) {
    // No usable daytime production (e.g. fully missing data) — record as ingested
    // so we don't retry endlessly, but leave the model untouched.
    state.ingested.push(dateKey);
    prune(state);
    persist(state);
    return false;
  }

  const monthKey = madridMonthKey(new Date(`${dateKey}T12:00:00`));
  applyDayPR(state, monthKey, dayPR);
  state.ingested.push(dateKey);
  prune(state);
  persist(state);
  return true;
}

/** Keep the ingested-day ledger from growing unbounded (last ~90 days). */
function prune(state: ModelFile): void {
  state.ingested.sort();
  if (state.ingested.length > 90) state.ingested = state.ingested.slice(-90);
}

/**
 * Nightly ingest at Madrid midnight: fold *yesterday* into the learned model.
 * Best-effort; logs and swallows errors so it never crashes the process.
 */
export async function runNightlyIngest(): Promise<void> {
  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 12 * 3600 * 1000); // safely into prior day at Madrid midnight
    const key = history.madridDateKey(yesterday);
    const updated = await ingestDay(key);
    if (updated) {
      const { prEff, confidence, days, month } = effectivePR();
      console.log(
        `[solar-model] ingested ${key} → ${month} PR_eff=${prEff.toFixed(3)} (conf ${(confidence * 100) | 0}%, ${days}d)`,
      );
    }
  } catch (e) {
    console.error('[solar-model] nightly ingest failed:', (e as Error).message);
  }
}

/**
 * Schedule the nightly ingest to run shortly after each Madrid midnight.
 * Re-arms itself after every run. Call once at boot.
 */
export function startSolarModelScheduler(): void {
  // Warm-start the learned model from history at boot (one-time if the model file
  // is absent). load() does the backfill + persist; this just forces it eagerly so
  // the first /api/brain/plan already reflects seeded confidence, not cold-start.
  load();
  const schedule = () => {
    const now = new Date();
    const h = madridHour(now);
    const minNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, minute: '2-digit' }).format(now));
    // Minutes until 00:10 Madrid (a 10-min cushion past midnight so the prior day
    // is fully bucketed). If we're already past it today, target tomorrow.
    const minsNow = h * 60 + minNow;
    const target = 10; // 00:10
    let wait = target - minsNow;
    if (wait <= 0) wait += 24 * 60;
    setTimeout(() => {
      void runNightlyIngest().finally(schedule);
    }, wait * 60 * 1000);
  };
  schedule();
}
