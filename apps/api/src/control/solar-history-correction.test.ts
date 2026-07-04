// Unit tests for the solar-history double-count correction. Run with the Node
// built-in test runner via tsx:
//   node --import tsx --test src/control/solar-history-correction.test.ts
//
// Covers the PURE correction primitives (correctedSolar / isEligibleTs /
// isClampAffected / decideBucket) and the end-to-end APPLY over a hermetic
// temporary SQLite store + history-5m.json (idempotency + backup + clamp count).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  correctedSolar,
  isEligibleTs,
  isClampAffected,
  decideBucket,
  CUTOFF_SEC,
  CUTOFF_ISO,
} from './solar-history-correction';

// ---- Pure primitives --------------------------------------------------------

test('correctedSolar = max(0, stored − sungrow)', () => {
  assert.equal(correctedSolar(10, 4), 6);
  assert.equal(correctedSolar(4.6, 4.6), 0);
  // never negative — a Sungrow value larger than the (clamped) stored total floors to 0
  assert.equal(correctedSolar(3, 5), 0);
});

test('correctedSolar treats null / non-finite stored as 0', () => {
  assert.equal(correctedSolar(null, 2), 0);
  assert.equal(correctedSolar(undefined, 2), 0);
  assert.equal(correctedSolar(Number.NaN, 2), 0);
});

test('zero Sungrow contribution leaves the value unchanged', () => {
  assert.equal(correctedSolar(7.3, 0), 7.3);
});

test('cutoff excludes rows at/after the fix instant', () => {
  assert.equal(isEligibleTs(CUTOFF_SEC - 1), true); // strictly before → eligible
  assert.equal(isEligibleTs(CUTOFF_SEC), false); // AT the cutoff → already correct
  assert.equal(isEligibleTs(CUTOFF_SEC + 1), false); // after → already correct
  assert.equal(CUTOFF_ISO, '2026-07-04T10:50:00Z');
});

test('clamp-affected rows are detected at/above the 18 kW ceiling', () => {
  assert.equal(isClampAffected(18), true);
  assert.equal(isClampAffected(17.98), true); // within epsilon of the ceiling
  assert.equal(isClampAffected(9.2), false);
  assert.equal(isClampAffected(null), false);
});

test('decideBucket: eligible + Sungrow present → changed', () => {
  const d = decideBucket(CUTOFF_SEC - 100, 9.0, 3.5);
  assert.equal(d.eligible, true);
  assert.equal(d.changed, true);
  assert.equal(d.before, 9.0);
  assert.equal(d.after, 5.5);
  assert.equal(d.clamped, false);
});

test('decideBucket: post-cutoff row is never changed', () => {
  const d = decideBucket(CUTOFF_SEC + 100, 9.0, 3.5);
  assert.equal(d.eligible, false);
  assert.equal(d.changed, false);
  assert.equal(d.after, 9.0); // unchanged
});

test('decideBucket: zero-Sungrow bucket unchanged even when eligible', () => {
  const d = decideBucket(CUTOFF_SEC - 100, 6.0, 0);
  assert.equal(d.eligible, true);
  assert.equal(d.changed, false);
  assert.equal(d.after, 6.0);
});

test('decideBucket: clamped row still corrected but flagged approximate', () => {
  const d = decideBucket(CUTOFF_SEC - 100, 18, 4.6);
  assert.equal(d.changed, true);
  assert.equal(d.after, 13.4);
  assert.equal(d.clamped, true);
});

// ---- End-to-end APPLY over a hermetic store ---------------------------------
// Gated on better-sqlite3 loading (native). If it can't load in this env the DB
// path is skipped — the pure tests above still cover the correction math.

test('APPLY corrects tiers, backs up, is idempotent, counts clamped', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'solar-corr-'));
  // Point the store + JSON at the temp dir BEFORE importing the modules that read env.
  process.env.METERING_DB_FILE = join(dir, 'metering.db');
  process.env.HISTORY_5M_FILE = join(dir, 'history-5m.json');

  // Load the DB handle; skip the whole test if the native module isn't available.
  const { db, getMeta } = await import('../db/sqlite');
  const handle = db();
  if (!handle) {
    t.skip('better-sqlite3 unavailable in this environment');
    return;
  }

  const before = CUTOFF_SEC - 3600; // a 5m/hourly bucket safely before the cutoff
  const beforeDay = '2026-07-01'; // a daily bucket before the cutoff day
  const after = CUTOFF_SEC + 3600; // a post-cutoff bucket that must stay untouched

  // Seed contaminated whole-house rows.
  handle
    .prepare(
      `INSERT INTO energy_5m (ts, solar_kw, home_kw, charge_kw, discharge_kw, grid_import_kw, grid_export_kw, sonnen_soc, tesla_soc, combined_soc, samples)
       VALUES (?, ?, 0,0,0,0,0, 50, 50, 50, 1)`,
    )
    .run(before, 9.0); // stored = tesla(5.5) + sungrow(3.5)
  handle
    .prepare(
      `INSERT INTO energy_5m (ts, solar_kw, home_kw, charge_kw, discharge_kw, grid_import_kw, grid_export_kw, sonnen_soc, tesla_soc, combined_soc, samples)
       VALUES (?, 18.0, 0,0,0,0,0, 50, 50, 50, 1)`,
    )
    .run(before + 300); // clamped row (at the ceiling)
  handle
    .prepare(
      `INSERT INTO energy_5m (ts, solar_kw, home_kw, charge_kw, discharge_kw, grid_import_kw, grid_export_kw, sonnen_soc, tesla_soc, combined_soc, samples)
       VALUES (?, 7.0, 0,0,0,0,0, 50, 50, 50, 1)`,
    )
    .run(after); // POST-cutoff — must never change

  handle
    .prepare(`INSERT INTO energy_hourly (bucket_ts, solar_kwh, home_kwh, charge_kwh, discharge_kwh, grid_import_kwh, grid_export_kwh, samples, src) VALUES (?, ?, 0,0,0,0,0, 12, 'live')`)
    .run(Math.floor(before / 3600) * 3600, 8.0);
  handle
    .prepare(`INSERT INTO energy_daily (day, solar_kwh, home_kwh, charge_kwh, discharge_kwh, grid_import_kwh, grid_export_kwh, samples, src) VALUES (?, ?, 0,0,0,0,0, 288, 'live')`)
    .run(beforeDay, 40.0);

  // Ground-truth Sungrow contribution (un-contaminated per-inverter history).
  handle.prepare(`INSERT INTO inverter_5m (inverter_id, ts, ac_kw, daily_kwh, total_kwh, samples) VALUES ('sg1', ?, 2.0, 0, 0, 1)`).run(before);
  handle.prepare(`INSERT INTO inverter_5m (inverter_id, ts, ac_kw, daily_kwh, total_kwh, samples) VALUES ('sg2', ?, 1.5, 0, 0, 1)`).run(before);
  handle.prepare(`INSERT INTO inverter_5m (inverter_id, ts, ac_kw, daily_kwh, total_kwh, samples) VALUES ('sg1', ?, 4.6, 0, 0, 1)`).run(before + 300); // for the clamped row
  handle.prepare(`INSERT INTO inverter_hourly (inverter_id, bucket_ts, ac_kwh, samples) VALUES ('sg1', ?, 3.0, 12)`).run(Math.floor(before / 3600) * 3600);
  handle.prepare(`INSERT INTO inverter_daily (inverter_id, day, ac_kwh, samples) VALUES ('sg1', ?, 15.0, 288)`).run(beforeDay);

  // A history-5m.json with one contaminated seen bucket on beforeDay.
  const jsonDay = {
    date: beforeDay,
    series: {
      solarKw: new Array(288).fill(0),
      homeKw: new Array(288).fill(0),
      chargeKw: new Array(288).fill(0),
      dischargeKw: new Array(288).fill(0),
      gridImportKw: new Array(288).fill(0),
      gridExportKw: new Array(288).fill(0),
      sonnenSoc: new Array(288).fill(null),
      teslaSoc: new Array(288).fill(null),
      combinedSoc: new Array(288).fill(null),
    },
    seen: new Array(288).fill(0),
  };
  // Bucket index 120 = 10:00 Madrid; give it a stored solar and a matching seen>0.
  jsonDay.series.solarKw[120] = 6.0;
  jsonDay.seen[120] = 3;
  writeFileSync(process.env.HISTORY_5M_FILE, JSON.stringify({ v: 1, days: { [beforeDay]: jsonDay } }), 'utf8');

  const { computeCorrection, applyCorrection, MARKER_KEY, history5mPath, madridBucketStartTs } = await import('./solar-history-correction');

  // Seed a matching Sungrow inverter_5m row at the JSON bucket's exact instant so
  // the JSON tier has a real 3.5 kW contribution to subtract (6.0 − 3.5 = 2.5).
  const jsonBucketTs = madridBucketStartTs(beforeDay, 120)!;
  handle.prepare(`INSERT INTO inverter_5m (inverter_id, ts, ac_kw, daily_kwh, total_kwh, samples) VALUES ('sg1', ?, 3.5, 0, 0, 1)`).run(jsonBucketTs);

  // DRY RUN writes nothing.
  const dry = computeCorrection();
  assert.equal(dry.alreadyApplied, false);
  assert.equal(dry.applied, false);
  const tier5 = dry.tiers.find((x) => x.tier === '5m')!;
  assert.equal(tier5.rowsChanged, 2); // the 9.0 row + the 18.0 clamped row (post-cutoff excluded)
  assert.equal(tier5.clampedApprox, 1);
  // Verify the DB is untouched by the dry run.
  const stillRaw = handle.prepare(`SELECT solar_kw FROM energy_5m WHERE ts = ?`).get(before) as { solar_kw: number };
  assert.equal(stillRaw.solar_kw, 9.0);
  assert.equal(getMeta(MARKER_KEY), null);

  // APPLY.
  const applied = applyCorrection();
  assert.equal(applied.applied, true);
  assert.equal(applied.error, undefined);

  // 5m: 9.0 − 3.5 = 5.5; clamped 18.0 − 4.6 = 13.4; post-cutoff 7.0 unchanged.
  assert.equal((handle.prepare(`SELECT solar_kw FROM energy_5m WHERE ts = ?`).get(before) as { solar_kw: number }).solar_kw, 5.5);
  assert.equal((handle.prepare(`SELECT solar_kw FROM energy_5m WHERE ts = ?`).get(before + 300) as { solar_kw: number }).solar_kw, 13.4);
  assert.equal((handle.prepare(`SELECT solar_kw FROM energy_5m WHERE ts = ?`).get(after) as { solar_kw: number }).solar_kw, 7.0);
  // hourly: 8.0 − 3.0 = 5.0
  assert.equal((handle.prepare(`SELECT solar_kwh FROM energy_hourly WHERE bucket_ts = ?`).get(Math.floor(before / 3600) * 3600) as { solar_kwh: number }).solar_kwh, 5.0);
  // daily: 40.0 − 15.0 = 25.0
  assert.equal((handle.prepare(`SELECT solar_kwh FROM energy_daily WHERE day = ?`).get(beforeDay) as { solar_kwh: number }).solar_kwh, 25.0);

  // Backup table holds the originals.
  const backupRows = handle.prepare(`SELECT * FROM energy_solar_backup ORDER BY tier, bucket_key`).all() as Array<{ tier: string; old_solar: number; clamped: number }>;
  assert.ok(backupRows.length >= 4);
  const clampBackup = backupRows.find((r) => r.old_solar === 18);
  assert.equal(clampBackup?.clamped, 1);

  // JSON: corrected in-place (6.0 − 3.5 = 2.5) + a backup file made.
  const jsonAfter = JSON.parse(readFileSync(history5mPath(), 'utf8')) as { days: Record<string, { series: { solarKw: number[] } }> };
  assert.equal(jsonAfter.days[beforeDay].series.solarKw[120], 2.5);
  assert.equal(existsSync(`${history5mPath()}.solar-correction-backup`), true);

  // Idempotency: a second apply no-ops and reports alreadyApplied.
  const second = applyCorrection();
  assert.equal(second.applied, false);
  assert.equal(second.alreadyApplied, true);
  // Values unchanged after the second run.
  assert.equal((handle.prepare(`SELECT solar_kw FROM energy_5m WHERE ts = ?`).get(before) as { solar_kw: number }).solar_kw, 5.5);
});
