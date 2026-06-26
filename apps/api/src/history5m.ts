// Persistent 5-minute energy sampler for the Live day chart.
//
// Buckets the SAME live snapshot used by /api/live into 5-minute slots (288 per
// day) keyed by Madrid-local calendar day, keeping the last 30 days. Persisted to
// its OWN file (history-5m.json) with an atomic write (tmp + rename) so it never
// bloats the hot state.json that store.ts rewrites on every mutation.
//
// Path resolution mirrors store.ts:
//   HISTORY_5M_FILE env override, else
//   production → /opt/energy/history-5m.json
//   dev        → <repoRoot>/.data/history-5m.json

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ---- Series ----------------------------------------------------------------

export const HISTORY_SERIES = [
  'solarKw',
  'homeKw',
  'chargeKw',
  'dischargeKw',
  'gridImportKw',
  'gridExportKw',
  'sonnenSoc',
  'teslaSoc',
  'combinedSoc',
] as const;
export type HistorySeriesKey = (typeof HISTORY_SERIES)[number];
export type HistorySample = Record<HistorySeriesKey, number>;
export type HistorySeries = Record<HistorySeriesKey, number[]>;

export const BUCKETS_PER_DAY = 288; // 24h × 12 (5-min)
const MAX_DAYS = 30;

/** Power series default to 0 (not yet produced); SoC stays null until first seen. */
const SOC_SERIES = new Set<HistorySeriesKey>(['sonnenSoc', 'teslaSoc', 'combinedSoc']);

interface DayRecord {
  date: string; // Madrid YYYY-MM-DD
  /** Per-series 288-length arrays. Power: 0 before seen. SoC: null before seen. */
  series: Record<HistorySeriesKey, (number | null)[]>;
  /** Per-bucket sample count, for running averages. */
  seen: number[];
}

interface HistoryFile {
  v: 1;
  days: Record<string, DayRecord>;
}

// ---- In-memory cache + path ------------------------------------------------

let cache: HistoryFile | null = null;
let path: string | null = null;

function historyPath(): string {
  if (process.env.HISTORY_5M_FILE) return process.env.HISTORY_5M_FILE;
  // Co-locate with the state file so it lands in the same writable data dir.
  // (The mini sets STATE_FILE to ~/sites/energy/.data; /opt/energy is VPS-only
  // and doesn't exist there — writing it failed silently, losing all history.)
  if (process.env.STATE_FILE) return resolve(dirname(process.env.STATE_FILE), 'history-5m.json');
  if (process.env.NODE_ENV === 'production') return '/opt/energy/history-5m.json';
  // repoRoot = three levels up from apps/api/src in the CJS prod bundle. Under
  // tsx/ESM dev __dirname is undefined, so derive it from cwd (apps/api).
  const repoRoot =
    typeof __dirname !== 'undefined'
      ? resolve(__dirname, '..', '..', '..')
      : resolve(process.cwd(), '..', '..');
  return resolve(repoRoot, '.data', 'history-5m.json');
}

function file(): string {
  if (!path) path = historyPath();
  return path;
}

// ---- Madrid time helpers ---------------------------------------------------

/** Madrid-local calendar day key (YYYY-MM-DD). */
export function madridDateKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** 5-minute bucket index (0..287) for a Date in Madrid local time. */
export function madridBucketIndex(d: Date): number {
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

// ---- Day record helpers ----------------------------------------------------

function blankDay(date: string): DayRecord {
  const series = Object.fromEntries(
    HISTORY_SERIES.map((k) => [
      k,
      new Array<number | null>(BUCKETS_PER_DAY).fill(SOC_SERIES.has(k) ? null : 0),
    ]),
  ) as Record<HistorySeriesKey, (number | null)[]>;
  return { date, series, seen: new Array<number>(BUCKETS_PER_DAY).fill(0) };
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ---- Load / persist --------------------------------------------------------

function load(): HistoryFile {
  if (cache) return cache;
  const f = file();
  try {
    if (existsSync(f)) {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<HistoryFile>;
      cache = hydrate(raw);
    } else {
      cache = { v: 1, days: {} };
    }
  } catch (e) {
    console.error('[history5m] load failed, starting empty:', (e as Error).message);
    cache = { v: 1, days: {} };
  }
  return cache;
}

/** Validate + coerce a persisted file onto a known-good shape. */
function hydrate(raw: Partial<HistoryFile>): HistoryFile {
  const out: HistoryFile = { v: 1, days: {} };
  if (!raw || typeof raw !== 'object' || !raw.days || typeof raw.days !== 'object') return out;
  for (const [key, day] of Object.entries(raw.days)) {
    if (!day || typeof day !== 'object') continue;
    const rec = blankDay(key);
    const src = day as Partial<DayRecord>;
    if (src.series && typeof src.series === 'object') {
      for (const k of HISTORY_SERIES) {
        const arr = (src.series as Record<string, unknown>)[k];
        if (Array.isArray(arr)) {
          for (let i = 0; i < BUCKETS_PER_DAY; i++) {
            const v = arr[i];
            if (typeof v === 'number' && Number.isFinite(v)) rec.series[k][i] = v;
            else if (v === null) rec.series[k][i] = null;
          }
        }
      }
    }
    if (Array.isArray(src.seen)) {
      for (let i = 0; i < BUCKETS_PER_DAY; i++) {
        const v = src.seen[i];
        if (typeof v === 'number' && Number.isFinite(v)) rec.seen[i] = v;
      }
    }
    out.days[key] = rec;
  }
  return out;
}

function persist(state: HistoryFile): void {
  const f = file();
  try {
    const dir = dirname(f);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, f); // atomic on the same filesystem
  } catch (e) {
    console.error('[history5m] persist failed:', (e as Error).message);
  }
}

/** Drop day keys older than the newest MAX_DAYS calendar days. */
function prune(state: HistoryFile): void {
  const keys = Object.keys(state.days).sort(); // YYYY-MM-DD sorts chronologically
  if (keys.length <= MAX_DAYS) return;
  for (const k of keys.slice(0, keys.length - MAX_DAYS)) delete state.days[k];
}

// ---- Public API ------------------------------------------------------------

/**
 * Record one live snapshot into its 5-minute bucket for today (Madrid). Called
 * from the /api/live sampling path, so the day fills as /api/live is polled.
 * Within a bucket each series is a running average. Persists atomically.
 */
export function record(sample: HistorySample): void {
  const state = load();
  const now = new Date();
  const dateKey = madridDateKey(now);
  let day = state.days[dateKey];
  if (!day) {
    day = blankDay(dateKey);
    state.days[dateKey] = day;
    prune(state);
  }
  const idx = madridBucketIndex(now);
  const n = day.seen[idx];
  for (const k of HISTORY_SERIES) {
    const prev = day.series[k][idx];
    const base = typeof prev === 'number' ? prev : 0;
    day.series[k][idx] = (base * n + sample[k]) / (n + 1);
  }
  day.seen[idx] = n + 1;
  persist(state);
}

/** Day keys available (Madrid YYYY-MM-DD), oldest → newest. */
export function availableDayKeys(): string[] {
  return Object.keys(load().days).sort();
}

/**
 * Measured 288-bucket series for a day key, or null if we have no data for it.
 * Power series are rounded kW (0 before seen); SoC series are rounded % (null
 * before seen). Buckets after `now` today are simply unfilled (0/null).
 */
export function getDay(dateKey: string): HistorySeries | null {
  const day = load().days[dateKey];
  if (!day) return null;
  const out = {} as HistorySeries;
  for (const k of HISTORY_SERIES) {
    const isSoc = SOC_SERIES.has(k);
    out[k] = day.series[k].map((v) => {
      if (v == null) return isSoc ? 0 : 0;
      return round(v, isSoc ? 0 : 2);
    });
  }
  return out;
}
