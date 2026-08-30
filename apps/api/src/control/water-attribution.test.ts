// Unit tests for the water attribution engine's PURE functions (docs/51 P2). Run with:
//   node --import tsx --test src/control/water-attribution.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  minutesInBucket,
  learnZoneFlow,
  attributedIrrigationL,
  attributeBucket,
  householdBaselineForHour,
  median,
  zoneTrusted,
  MIN_TRUSTED_SAMPLES,
  type IrrigationRun,
  type ZoneFlow,
} from './water-attribution';

const HOUR_MS = 3600_000;

test('minutesInBucket clips a run to the hour window', () => {
  const bucketStart = Date.UTC(2026, 7, 29, 10, 0, 0);
  const run: IrrigationRun = { zoneId: 'z1', startMs: bucketStart - 5 * 60_000, endMs: bucketStart + 20 * 60_000 };
  // Run started 5 min before the bucket and ended 20 min in -> only 20 min overlap.
  assert.equal(minutesInBucket(run, bucketStart), 20);
});

test('minutesInBucket is 0 for a run entirely outside the bucket', () => {
  const bucketStart = Date.UTC(2026, 7, 29, 10, 0, 0);
  const run: IrrigationRun = { zoneId: 'z1', startMs: bucketStart - HOUR_MS, endMs: bucketStart - 60_000 };
  assert.equal(minutesInBucket(run, bucketStart), 0);
});

test('median: odd and even counts', () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

// ---- Zone-flow learning from single-zone hours ---------------------------------

test('learnZoneFlow computes lpm from a clean single-zone hour', () => {
  const bucketStart = Date.UTC(2026, 7, 29, 6, 0, 0);
  const run: IrrigationRun = { zoneId: 'rb-1', startMs: bucketStart, endMs: bucketStart + 10 * 60_000 }; // 10 min
  // Household baseline 5 L; bucket measured 5 (baseline) + 10min * 12 L/min = 125 L.
  const learned = learnZoneFlow(
    [{ bucketStartMs: bucketStart, litres: 125 }],
    [run],
    () => 5,
    {},
  );
  assert.ok(learned['rb-1']);
  assert.equal(learned['rb-1'].lpm, 12);
  assert.equal(learned['rb-1'].samples, 1);
});

test('learnZoneFlow SKIPS an hour where two zones overlap (not a clean single-zone sample)', () => {
  const bucketStart = Date.UTC(2026, 7, 29, 6, 0, 0);
  const runs: IrrigationRun[] = [
    { zoneId: 'rb-1', startMs: bucketStart, endMs: bucketStart + 10 * 60_000 },
    { zoneId: 'rb-2', startMs: bucketStart + 5 * 60_000, endMs: bucketStart + 15 * 60_000 },
  ];
  const learned = learnZoneFlow([{ bucketStartMs: bucketStart, litres: 300 }], runs, () => 5, {});
  assert.deepEqual(learned, {});
});

test('learnZoneFlow SKIPS a run shorter than the minimum learning minutes', () => {
  const bucketStart = Date.UTC(2026, 7, 29, 6, 0, 0);
  const run: IrrigationRun = { zoneId: 'rb-1', startMs: bucketStart, endMs: bucketStart + 2 * 60_000 }; // 2 min < 5 min floor
  const learned = learnZoneFlow([{ bucketStartMs: bucketStart, litres: 30 }], [run], () => 5, {});
  assert.deepEqual(learned, {});
});

test('learnZoneFlow averages across multiple single-zone samples (running average)', () => {
  const b1 = Date.UTC(2026, 7, 29, 6, 0, 0);
  const b2 = Date.UTC(2026, 7, 30, 6, 0, 0);
  const runs: IrrigationRun[] = [
    { zoneId: 'rb-1', startMs: b1, endMs: b1 + 10 * 60_000 }, // 10 min, 10L/min -> 100L + baseline 0
    { zoneId: 'rb-1', startMs: b2, endMs: b2 + 10 * 60_000 }, // 10 min, 14L/min -> 140L + baseline 0
  ];
  const learned = learnZoneFlow(
    [
      { bucketStartMs: b1, litres: 100 },
      { bucketStartMs: b2, litres: 140 },
    ],
    runs,
    () => 0,
    {},
  );
  assert.equal(learned['rb-1'].samples, 2);
  assert.equal(learned['rb-1'].lpm, 12); // (10+14)/2
});

test('zoneTrusted requires the minimum sample count', () => {
  assert.equal(zoneTrusted(undefined), false);
  assert.equal(zoneTrusted({ zoneId: 'z', lpm: 10, samples: MIN_TRUSTED_SAMPLES - 1 }), false);
  assert.equal(zoneTrusted({ zoneId: 'z', lpm: 10, samples: MIN_TRUSTED_SAMPLES }), true);
});

// ---- Attribution split ----------------------------------------------------------

test('attributedIrrigationL sums minutes x lpm across zones active in the bucket', () => {
  const bucketStart = Date.UTC(2026, 7, 29, 6, 0, 0);
  const runs: IrrigationRun[] = [{ zoneId: 'rb-1', startMs: bucketStart, endMs: bucketStart + 15 * 60_000 }];
  const flow: Record<string, ZoneFlow> = { 'rb-1': { zoneId: 'rb-1', lpm: 10, samples: MIN_TRUSTED_SAMPLES } };
  const res = attributedIrrigationL(bucketStart, runs, flow);
  assert.equal(res.litres, 150);
  assert.equal(res.confidence, 'high');
});

test('attributedIrrigationL falls back to DEFAULT_FALLBACK_LPM for an untrusted zone', () => {
  const bucketStart = Date.UTC(2026, 7, 29, 6, 0, 0);
  const runs: IrrigationRun[] = [{ zoneId: 'rb-1', startMs: bucketStart, endMs: bucketStart + 10 * 60_000 }];
  const res = attributedIrrigationL(bucketStart, runs, {});
  assert.ok(res.litres > 0); // used the fallback, not 0
});

test('attributedIrrigationL marks confidence LOW on an overlap of two zones', () => {
  const bucketStart = Date.UTC(2026, 7, 29, 6, 0, 0);
  const runs: IrrigationRun[] = [
    { zoneId: 'rb-1', startMs: bucketStart, endMs: bucketStart + 10 * 60_000 },
    { zoneId: 'rb-2', startMs: bucketStart, endMs: bucketStart + 10 * 60_000 },
  ];
  const res = attributedIrrigationL(bucketStart, runs, {});
  assert.equal(res.confidence, 'low');
});

test('attributeBucket splits measured litres into household + irrigation + unexplained', () => {
  const bucketStart = Date.UTC(2026, 7, 29, 6, 0, 0);
  const run: IrrigationRun = { zoneId: 'rb-1', startMs: bucketStart, endMs: bucketStart + 10 * 60_000 };
  const flow: Record<string, ZoneFlow> = { 'rb-1': { zoneId: 'rb-1', lpm: 10, samples: MIN_TRUSTED_SAMPLES } };
  // 10 min * 10 L/min = 100L irrigation, household baseline 5L, measured 110 -> unexplained 5.
  const res = attributeBucket(110, bucketStart, [run], flow, 5);
  assert.equal(res.irrigationL, 100);
  assert.equal(res.householdL, 5);
  assert.equal(res.unexplainedL, 5);
});

test('attributeBucket never produces negative unexplained (clamped at 0)', () => {
  const bucketStart = Date.UTC(2026, 7, 29, 6, 0, 0);
  const run: IrrigationRun = { zoneId: 'rb-1', startMs: bucketStart, endMs: bucketStart + 10 * 60_000 };
  const flow: Record<string, ZoneFlow> = { 'rb-1': { zoneId: 'rb-1', lpm: 50, samples: MIN_TRUSTED_SAMPLES } }; // way over measured
  const res = attributeBucket(20, bucketStart, [run], flow, 5);
  assert.equal(res.unexplainedL, 0);
});

test('attributeBucket household never exceeds what was actually measured', () => {
  const res = attributeBucket(2, Date.now(), [], {}, 50); // measured only 2L, baseline says 50L
  assert.equal(res.householdL, 2);
});

// ---- Household baseline ---------------------------------------------------------

test('householdBaselineForHour is the median of non-irrigating hours at that hour-of-day', () => {
  // Use UTC noon so the hour-of-day (Madrid, UTC+2 in August) is deterministic-ish;
  // instead pick hours far from any DST edge and just assert relative behaviour.
  const day0 = Math.floor(Date.UTC(2026, 7, 1, 4, 0, 0) / 1000); // 04:00 UTC -> 06:00 Madrid (CEST)
  const daySec = 86_400;
  const buckets = [0, 1, 2, 3, 4].map((i) => ({ bucketStartSec: day0 + i * daySec, litres: 10 + i }));
  const baseline = householdBaselineForHour(6, buckets, []);
  assert.equal(baseline, 12); // median of [10,11,12,13,14]
});

test('householdBaselineForHour EXCLUDES hours where irrigation ran', () => {
  const day0 = Math.floor(Date.UTC(2026, 7, 1, 4, 0, 0) / 1000);
  const daySec = 86_400;
  const buckets = [0, 1, 2].map((i) => ({ bucketStartSec: day0 + i * daySec, litres: 10 }));
  // Irrigation ran during bucket index 1 (huge spike) — must be excluded from the baseline.
  buckets[1].litres = 5000;
  const runs: IrrigationRun[] = [{ zoneId: 'rb-1', startMs: buckets[1].bucketStartSec * 1000, endMs: buckets[1].bucketStartSec * 1000 + 60_000 }];
  const baseline = householdBaselineForHour(6, buckets, runs);
  assert.equal(baseline, 10); // the irrigating hour (5000L) is excluded
});
