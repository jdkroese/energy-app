// Persistent 5-minute grid-voltage history for the Live "Grid voltage" tile's
// 48h chart overlay.
//
// Buckets the SAME breaker reading already computed by /api/live into 5-minute
// slots keyed by bucket-start epoch ms, keeping the last 48h. Persisted to its
// OWN file (voltage-history.json) with an atomic write (tmp + rename) so it never
// bloats the hot state.json that store.ts rewrites on every mutation — mirroring
// history5m.ts.
//
// Path resolution mirrors history5m.ts / store.ts:
//   VOLTAGE_HISTORY_FILE env override, else co-located with STATE_FILE, else
//   production → /opt/energy/voltage-history.json, else <repoRoot>/.data/…

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ---- Types -----------------------------------------------------------------

/** One 5-minute bucket. `ts` is the bucket-start epoch ms (Math.floor(now/300000)*300000). */
export interface Sample {
  ts: number;
  voltageV: number;
  currentA: number;
  powerW: number;
  /** Sonnen inverter AC terminal voltage (V), when available. Runs higher than the
   *  breaker meter and governs the over-voltage trip; absent on old files / when 0. */
  sonnenUacV?: number;
}

const BUCKET_MS = 5 * 60 * 1000; // 5-minute slots
const RETENTION_MS = 48 * 60 * 60 * 1000; // keep 48h
const MAX_ENTRIES = 600; // hard ceiling (48h / 5min = 576; small headroom)

interface StoredSample extends Sample {
  /** Per-bucket sample count, for running averages. */
  n: number;
  /** Per-bucket count of folded-in Sonnen Uac readings (>0 only), tracked
   *  separately from `n` since some polls lack a real Uac. */
  un?: number;
}

interface HistoryFile {
  v: 1;
  samples: StoredSample[];
}

// ---- In-memory cache + path ------------------------------------------------

let cache: HistoryFile | null = null;
let path: string | null = null;

function historyPath(): string {
  if (process.env.VOLTAGE_HISTORY_FILE) return process.env.VOLTAGE_HISTORY_FILE;
  // Co-locate with the state file so it lands in the same writable data dir
  // (matches history5m.ts — /opt/energy is VPS-only and absent on the mini).
  if (process.env.STATE_FILE) return resolve(dirname(process.env.STATE_FILE), 'voltage-history.json');
  if (process.env.NODE_ENV === 'production') return '/opt/energy/voltage-history.json';
  // repoRoot = three levels up from apps/api/src in the CJS prod bundle. Under
  // tsx/ESM dev __dirname is undefined, so derive it from cwd (apps/api).
  const repoRoot =
    typeof __dirname !== 'undefined'
      ? resolve(__dirname, '..', '..', '..')
      : resolve(process.cwd(), '..', '..');
  return resolve(repoRoot, '.data', 'voltage-history.json');
}

function file(): string {
  if (!path) path = historyPath();
  return path;
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
      cache = { v: 1, samples: [] };
    }
  } catch (e) {
    console.error('[voltage-history] load failed, starting empty:', (e as Error).message);
    cache = { v: 1, samples: [] };
  }
  return cache;
}

/** Validate + coerce a persisted file onto a known-good shape (ascending by ts). */
function hydrate(raw: Partial<HistoryFile>): HistoryFile {
  const out: HistoryFile = { v: 1, samples: [] };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.samples)) return out;
  for (const s of raw.samples) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Partial<StoredSample>;
    if (
      typeof r.ts !== 'number' ||
      !Number.isFinite(r.ts) ||
      typeof r.voltageV !== 'number' ||
      !Number.isFinite(r.voltageV)
    )
      continue;
    const hasUac =
      typeof r.sonnenUacV === 'number' && Number.isFinite(r.sonnenUacV) && r.sonnenUacV > 0;
    out.samples.push({
      ts: r.ts,
      voltageV: r.voltageV,
      currentA: typeof r.currentA === 'number' && Number.isFinite(r.currentA) ? r.currentA : 0,
      powerW: typeof r.powerW === 'number' && Number.isFinite(r.powerW) ? r.powerW : 0,
      n: typeof r.n === 'number' && Number.isFinite(r.n) && r.n > 0 ? r.n : 1,
      // Back-compat: old files lack Uac entirely — leave it off so the chart gaps it.
      ...(hasUac
        ? {
            sonnenUacV: r.sonnenUacV as number,
            un: typeof r.un === 'number' && Number.isFinite(r.un) && r.un > 0 ? r.un : 1,
          }
        : {}),
    });
  }
  out.samples.sort((a, b) => a.ts - b.ts);
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
    console.error('[voltage-history] persist failed:', (e as Error).message);
  }
}

/** Drop buckets older than the 48h window, with a hard count ceiling. */
function prune(state: HistoryFile, now: number): void {
  const cutoff = now - RETENTION_MS;
  let kept = state.samples.filter((s) => s.ts >= cutoff);
  if (kept.length > MAX_ENTRIES) kept = kept.slice(-MAX_ENTRIES);
  state.samples = kept;
}

// ---- Public API ------------------------------------------------------------

/**
 * Record one breaker reading into its 5-minute bucket. Called from the /api/live
 * path, so history fills as /api/live is polled (and via the 5-min background
 * sampler). Within a bucket each field is a running average. Skips readings with
 * no real voltage (voltageV <= 0). Persists atomically. Never throws.
 */
export function record(reading: {
  voltageV: number;
  currentA: number;
  powerW: number;
  sonnenUacV?: number;
}): void {
  try {
    if (!Number.isFinite(reading.voltageV) || reading.voltageV <= 0) return; // no real reading
    // Only fold Uac in when it's a real reading (>0); otherwise leave the bucket's Uac untouched.
    const uac =
      typeof reading.sonnenUacV === 'number' && Number.isFinite(reading.sonnenUacV) && reading.sonnenUacV > 0
        ? reading.sonnenUacV
        : null;
    const state = load();
    const now = Date.now();
    const bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const last = state.samples[state.samples.length - 1];
    if (last && last.ts === bucket) {
      // Running average within the active bucket.
      const n = last.n;
      last.voltageV = round((last.voltageV * n + reading.voltageV) / (n + 1));
      last.currentA = round((last.currentA * n + reading.currentA) / (n + 1), 1);
      last.powerW = Math.round((last.powerW * n + reading.powerW) / (n + 1));
      last.n = n + 1;
      if (uac !== null) {
        // Averaged over its own count so buckets with only some Uac polls stay correct.
        const un = last.un ?? 0;
        last.sonnenUacV = round((((last.sonnenUacV ?? 0) * un) + uac) / (un + 1));
        last.un = un + 1;
      }
    } else {
      state.samples.push({
        ts: bucket,
        voltageV: round(reading.voltageV),
        currentA: round(reading.currentA, 1),
        powerW: Math.round(reading.powerW),
        n: 1,
        ...(uac !== null ? { sonnenUacV: round(uac), un: 1 } : {}),
      });
      prune(state, now);
    }
    persist(state);
  } catch (e) {
    console.error('[voltage-history] record failed:', (e as Error).message);
  }
}

/**
 * Ascending-by-ts samples within the last `hoursBack` hours (default 48). The
 * per-bucket count `n` is stripped — callers only need the averaged values.
 */
export function getRecent(hoursBack = 48): Sample[] {
  const state = load();
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  return state.samples
    .filter((s) => s.ts >= cutoff)
    .map((s) => ({
      ts: s.ts,
      voltageV: s.voltageV,
      currentA: s.currentA,
      powerW: s.powerW,
      // Only surface a real Uac so the chart gaps (not plots 0) where it's missing.
      ...(typeof s.sonnenUacV === 'number' && s.sonnenUacV > 0 ? { sonnenUacV: s.sonnenUacV } : {}),
    }));
}
