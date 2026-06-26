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
  const repoRoot = resolve(__dirname, '..', '..', '..');
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
  try {
    if (existsSync(f)) {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<ModelFile>;
      cache = hydrate(raw);
    } else {
      cache = { v: 1, months: {}, ingested: [] };
    }
  } catch (e) {
    console.error('[solar-model] load failed, starting empty:', (e as Error).message);
    cache = { v: 1, months: {}, ingested: [] };
  }
  return cache;
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
 * Ingest a single finished day (Madrid YYYY-MM-DD) into the learned model.
 * Compares the day's measured solar (kW, 5-min buckets aggregated to hourly kWh)
 * against the modelled base GHI/1000·kWp (PR=1) over DAYTIME hours, then updates
 * the month's learned PR = clamp(median(actual/base), 0.5, 0.95). Idempotent:
 * a day already ingested is skipped. Returns true if it updated the model.
 */
export async function ingestDay(dateKey: string): Promise<boolean> {
  const state = load();
  if (state.ingested.includes(dateKey)) return false;

  const series = history.getDay(dateKey);
  if (!series) return false;

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
  if (ratios.length === 0) {
    // No usable daytime production (e.g. fully missing data) — record as ingested
    // so we don't retry endlessly, but leave the model untouched.
    state.ingested.push(dateKey);
    prune(state);
    persist(state);
    return false;
  }

  const monthKey = madridMonthKey(date);
  const dayPR = clamp(median(ratios), 0.5, 0.95);
  const rec = state.months[monthKey] ?? { pr: dayPR, days: 0 };
  // Running median proxy: blend the new day's PR into the stored PR weighted by
  // accumulated days (stable, monotone toward the true median over many days).
  const newDays = rec.days + 1;
  rec.pr = clamp((rec.pr * rec.days + dayPR) / newDays, 0.5, 0.95);
  rec.days = newDays;
  state.months[monthKey] = rec;
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
