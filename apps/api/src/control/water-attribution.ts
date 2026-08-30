// Water attribution engine (docs/51 P2) — the heart of the Water feature. For every
// hourly meter bucket, splits measured litres into irrigation / household / unexplained,
// so "unexplained litres" becomes the leak/anomaly signal instead of raw volume (which
// is dominated by irrigation — ~77% of the house's August 2026 draw, docs/51 §1).
//
// Pure functions (attributedIrrigationL, attributeBucket, learnZoneFlow, ...) are
// unit-testable in isolation. The orchestrator (runWaterAttribution) wires them to the
// SQLite store (control/water-history.ts) and the event bus (events.ts) and is
// FAIL-SOFT: any error is caught and logged, never thrown into the shared process.

import { streamEvents } from '../events';
import * as store from '../store';
import {
  readHourly,
  readZoneFlow,
  writeZoneFlow,
  writeWaterAttribution,
  readWaterAttribution,
  type ZoneFlowRow,
} from './water-history';

const HOUR_SEC = 3600;
const HOUR_MS = HOUR_SEC * 1000;

// ---- Reading logged irrigation sessions (narrow read helper over the event bus) ----
// Rain Bird sessions are logged by control/log-adapters.ts's logIrrigationSession() as
// 'session-end' observation events (category 'irrigation', device = zoneId, detail text
// "...ran ~<mins> min..."). There's no structured-duration field on the event, so we
// parse the (stable, single-writer) detail text rather than duplicate storage — the
// brief's explicit fallback when there's no clean structured read API.

export interface IrrigationRun {
  zoneId: string;
  startMs: number;
  endMs: number;
}

const MIN_RE = /ran\s*~?\s*(\d+(?:\.\d+)?)\s*min/i;

/** Logged irrigation runs whose window overlaps [fromMs, toMs]. Fail-soft (→ []). */
export function readIrrigationRuns(fromMs: number, toMs: number): IrrigationRun[] {
  try {
    // Look a day further back than fromMs: a run can END after fromMs but have STARTED
    // before it, and we key off the (only available) end-event timestamp.
    const events = streamEvents({
      category: ['irrigation'],
      from: new Date(fromMs - 24 * 3600_000).toISOString(),
      to: new Date(toMs).toISOString(),
    });
    const runs: IrrigationRun[] = [];
    for (const ev of events) {
      if (ev.entity !== 'session-end') continue;
      const zoneId = ev.device;
      if (!zoneId) continue;
      const m = MIN_RE.exec(ev.detail ?? '');
      if (!m) continue;
      const minutes = Number(m[1]);
      if (!Number.isFinite(minutes) || minutes <= 0) continue;
      const endMs = Date.parse(ev.ts);
      if (!Number.isFinite(endMs)) continue;
      const startMs = endMs - minutes * 60_000;
      if (endMs < fromMs || startMs > toMs) continue;
      runs.push({ zoneId, startMs, endMs });
    }
    return runs;
  } catch (e) {
    console.error('[water-attribution] readIrrigationRuns failed:', (e as Error).message);
    return [];
  }
}

// ---- Pure maths ---------------------------------------------------------------

/** Minutes a run occupied within the hourly bucket starting at `bucketStartMs`. */
export function minutesInBucket(run: IrrigationRun, bucketStartMs: number): number {
  const bucketEndMs = bucketStartMs + HOUR_MS;
  const s = Math.max(run.startMs, bucketStartMs);
  const e = Math.min(run.endMs, bucketEndMs);
  return Math.max(0, (e - s) / 60_000);
}

export interface ZoneFlow {
  zoneId: string;
  lpm: number;
  samples: number;
}

/** A learned zone flow is trusted once it has this many single-zone-hour samples. */
export const MIN_TRUSTED_SAMPLES = 3;
/** Minimum minutes a single-zone hour must run to count as a learning sample (avoids
 *  noisy short blips dominating the running average). */
export const MIN_LEARNING_MINUTES = 5;

export function zoneTrusted(z: ZoneFlow | undefined): boolean {
  return !!z && z.samples >= MIN_TRUSTED_SAMPLES;
}

/**
 * Learn (update) per-zone L/min from hours where EXACTLY ONE zone ran and no other zone
 * overlapped: lpm = (bucketLitres − householdBaseline) / minutesRun. Returns a NEW map
 * (existing entries not touched by this batch are carried over unchanged). Pure.
 */
export function learnZoneFlow(
  buckets: Array<{ bucketStartMs: number; litres: number }>,
  runs: IrrigationRun[],
  householdBaselineFor: (bucketStartMs: number) => number,
  existing: Record<string, ZoneFlow>,
): Record<string, ZoneFlow> {
  const out: Record<string, ZoneFlow> = { ...existing };
  for (const b of buckets) {
    const active = runs
      .map((r) => ({ r, minutes: minutesInBucket(r, b.bucketStartMs) }))
      .filter((x) => x.minutes > 0);
    if (active.length !== 1) continue; // exactly one zone, no overlap
    const { r, minutes } = active[0];
    if (minutes < MIN_LEARNING_MINUTES) continue;
    const baseline = householdBaselineFor(b.bucketStartMs);
    const irrigationL = Math.max(0, b.litres - baseline);
    const lpm = irrigationL / minutes;
    if (!Number.isFinite(lpm) || lpm <= 0) continue;
    const prev = out[r.zoneId];
    const n = prev?.samples ?? 0;
    const prevLpm = prev?.lpm ?? lpm;
    out[r.zoneId] = { zoneId: r.zoneId, lpm: (prevLpm * n + lpm) / (n + 1), samples: n + 1 };
  }
  return out;
}

/** Median of a numeric array. Pure; returns 0 for an empty input. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A reasonable fallback L/min when a zone has no trusted learned rate and no manual
 *  override — a mid-range drip/sprinkler figure so attribution doesn't collapse to 0
 *  litres attributed on a zone's very first few runs. */
export const DEFAULT_FALLBACK_LPM = 8;

export interface AttributedIrrigation {
  litres: number;
  /** 'high' when exactly one (or zero) zones ran this bucket; 'low' on an overlap, since
   *  the split across concurrent zones then relies on possibly-unlearned rates. */
  confidence: 'high' | 'low';
  zones: string[];
}

/** Attributed irrigation litres for one bucket = Σ(zone L/min × minutes that zone ran). */
export function attributedIrrigationL(
  bucketStartMs: number,
  runs: IrrigationRun[],
  zoneFlow: Record<string, ZoneFlow>,
  overrides: Record<string, number> = {},
): AttributedIrrigation {
  const active = runs
    .map((r) => ({ r, minutes: minutesInBucket(r, bucketStartMs) }))
    .filter((x) => x.minutes > 0);
  if (active.length === 0) return { litres: 0, confidence: 'high', zones: [] };
  let total = 0;
  const zones: string[] = [];
  for (const { r, minutes } of active) {
    const learned = zoneFlow[r.zoneId];
    const lpm = overrides[r.zoneId] ?? (zoneTrusted(learned) ? learned!.lpm : (learned?.lpm ?? DEFAULT_FALLBACK_LPM));
    total += minutes * lpm;
    zones.push(r.zoneId);
  }
  return { litres: total, confidence: active.length === 1 ? 'high' : 'low', zones };
}

export interface AttributionResult {
  totalL: number;
  householdL: number;
  irrigationL: number;
  unexplainedL: number;
  confidence: 'high' | 'low';
  zones: string[];
}

/**
 * Split one bucket's measured litres. household = min(measured, baseline) — never more
 * than what was actually measured, so a very-low-flow hour can't manufacture a negative
 * unexplained figure. unexplained = max(0, measured − irrigation − household).
 */
export function attributeBucket(
  measuredL: number,
  bucketStartMs: number,
  runs: IrrigationRun[],
  zoneFlow: Record<string, ZoneFlow>,
  householdBaselineL: number,
  overrides: Record<string, number> = {},
): AttributionResult {
  const { litres: irrigationL, confidence, zones } = attributedIrrigationL(bucketStartMs, runs, zoneFlow, overrides);
  const householdL = Math.min(measuredL, householdBaselineL);
  const unexplainedL = Math.max(0, measuredL - irrigationL - householdL);
  return { totalL: measuredL, householdL, irrigationL, unexplainedL, confidence, zones };
}

// ---- Household baseline (rolling median by hour-of-day, non-irrigation hours only) ----

/** Madrid local hour-of-day (0..23) for an epoch-seconds bucket start. */
function hourOfDay(bucketStartSec: number): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).format(
      new Date(bucketStartSec * 1000),
    ),
  );
}

/**
 * Rolling median household baseline (litres) for a given hour-of-day, computed from
 * `windowDays` of hourly buckets at that SAME hour-of-day that had NO irrigation running.
 * Pure given its inputs.
 */
export function householdBaselineForHour(
  hour: number,
  hourlyBuckets: Array<{ bucketStartSec: number; litres: number }>,
  runs: IrrigationRun[],
): number {
  const samples: number[] = [];
  for (const b of hourlyBuckets) {
    if (hourOfDay(b.bucketStartSec) !== hour) continue;
    const irrigating = runs.some((r) => minutesInBucket(r, b.bucketStartSec * 1000) > 0);
    if (irrigating) continue;
    samples.push(b.litres);
  }
  return median(samples);
}

// ---- Orchestrator (side-effecting; fail-soft) --------------------------------

const ATTRIBUTION_WINDOW_DAYS = 14; // recompute this trailing window on every pass
const BASELINE_WINDOW_DAYS = 30; // household baseline learns from this much history

/** Best-effort: re-derive household baselines + attribution for the trailing window,
 *  and update learned per-zone flow rates. Called after every successful water poll
 *  (new hourly data). NEVER throws. */
export function runWaterAttribution(now: number = Date.now()): void {
  try {
    const toSec = Math.floor(now / 1000);
    const attribWindowFromSec = toSec - ATTRIBUTION_WINDOW_DAYS * 86_400;
    const baselineWindowFromSec = toSec - BASELINE_WINDOW_DAYS * 86_400;

    const baselineHourly = readHourly(baselineWindowFromSec, toSec).map((h) => ({
      bucketStartSec: h.bucketTs,
      litres: h.litres,
    }));
    const attribHourly = readHourly(attribWindowFromSec, toSec);
    if (attribHourly.length === 0) return;

    const runs = readIrrigationRuns(baselineWindowFromSec * 1000, now);

    const baselineCache = new Map<number, number>();
    const householdBaselineFor = (bucketStartMs: number): number => {
      const hour = hourOfDay(Math.floor(bucketStartMs / 1000));
      let v = baselineCache.get(hour);
      if (v === undefined) {
        v = householdBaselineForHour(hour, baselineHourly, runs);
        baselineCache.set(hour, v);
      }
      return v;
    };

    // Learn zone flow from the baseline window (more samples → faster convergence).
    const existingFlow: Record<string, ZoneFlow> = {};
    for (const [id, row] of Object.entries(readZoneFlow())) existingFlow[id] = { zoneId: id, lpm: row.lpm, samples: row.samples };
    const learnBuckets = baselineHourly.map((h) => ({ bucketStartMs: h.bucketStartSec * 1000, litres: h.litres }));
    const learned = learnZoneFlow(learnBuckets, runs, householdBaselineFor, existingFlow);
    const flowRows: ZoneFlowRow[] = Object.values(learned).map((z) => ({
      zoneId: z.zoneId,
      lpm: z.lpm,
      samples: z.samples,
      updatedTs: Date.now(),
    }));
    if (flowRows.length > 0) writeZoneFlow(flowRows);

    // Manual overrides (docs/51 "expose a manual override") take precedence over learned.
    const overrides = store.get().water?.zoneFlowOverrides ?? {};

    const attributionRows = attribHourly.map((h) => {
      const res = attributeBucket(h.litres, h.bucketTs * 1000, runs, learned, householdBaselineFor(h.bucketTs * 1000), overrides);
      return {
        bucketTs: h.bucketTs,
        irrigationL: Math.round(res.irrigationL * 100) / 100,
        householdL: Math.round(res.householdL * 100) / 100,
        unexplainedL: Math.round(res.unexplainedL * 100) / 100,
        zones: res.zones,
      };
    });
    writeWaterAttribution(attributionRows);
  } catch (e) {
    console.error('[water-attribution] pass failed:', (e as Error).message);
  }
}

/** Read the stored attribution split for a window, keyed by bucket_ts. Fail-soft (→ []). */
export function attributionFor(fromSec: number, toSec: number) {
  return readWaterAttribution(fromSec, toSec);
}
