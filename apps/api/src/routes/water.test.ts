// Unit tests for the Water routes' not-configured shape (docs/51). Run with:
//   node --import tsx --test src/routes/water.test.ts

// Isolate persistence to a throwaway file so the test never touches the dev .data/state.json,
// and isolate the metering DB too (water-history.ts opens it on first use). Both must be set
// BEFORE the modules that lazily read them are imported.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'energy-water-route-test-'));
process.env.STATE_FILE = join(dir, 'state.json');
process.env.METERING_DB_FILE = join(dir, 'metering.db');
// Ensure no env fallback accidentally "configures" the connector for this test.
delete process.env.CONTAZARA_EMAIL;
delete process.env.CONTAZARA_PASSWORD;
delete process.env.CONTAZARA_SERIAL;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { getWater, getWaterHistory, getWaterSettings, MAX_BACK } = await import('./water');

test('GET /api/water returns configured:false with a well-shaped (never 500) payload when unconfigured', async () => {
  const res = (await getWater()) as Record<string, unknown>;
  assert.equal(res.configured, false);
  assert.equal(res.connected, false);
  assert.ok(res.meter && typeof res.meter === 'object');
  assert.equal((res.meter as Record<string, unknown>).serial, null);
  const today = res.today as Record<string, unknown>;
  assert.equal(today.totalL, 0);
  assert.ok(Array.isArray(today.hours));
  assert.equal((today.hours as unknown[]).length, 0);
  const month = res.month as Record<string, unknown>;
  assert.equal(month.m3, 0);
  assert.ok(Array.isArray(res.activeAlerts));
  assert.equal((res.activeAlerts as unknown[]).length, 0);
  const quietHour = res.quietHour as Record<string, unknown>;
  assert.equal(typeof quietHour.floorLph, 'number');
});

test('GET /api/water/history returns an empty-but-shaped payload when unconfigured', () => {
  const res = getWaterHistory('week', '0') as Record<string, unknown>;
  assert.equal(res.range, 'week');
  assert.equal(res.offset, 0);
  assert.ok(Array.isArray(res.labels));
  assert.equal((res.labels as unknown[]).length, 0);
  const series = res.series as Record<string, unknown>;
  assert.ok(Array.isArray(series.total));
  const dayparts = res.dayparts as Record<string, unknown>;
  assert.ok('night' in dayparts && 'morning' in dayparts && 'afternoon' in dayparts && 'evening' in dayparts);
  const totals = res.totals as Record<string, unknown>;
  assert.equal(totals.totalL, 0);
});

test('GET /api/water/history clamps an out-of-range offset to MAX_BACK', () => {
  const res = getWaterHistory('month', String(-(MAX_BACK.month + 50))) as Record<string, unknown>;
  assert.equal(res.offset, -MAX_BACK.month);
});

test('GET /api/water/history falls back to "day" for an invalid range', () => {
  const res = getWaterHistory('bogus', '0') as Record<string, unknown>;
  assert.equal(res.range, 'day');
});

test('GET /api/water/settings reports hasPassword:false and no email/serial when unconfigured', () => {
  const res = getWaterSettings() as Record<string, unknown>;
  assert.equal(res.hasPassword, false);
  assert.equal(res.email, '');
  assert.equal(res.serial, '');
  assert.ok(res.thresholds && typeof res.thresholds === 'object');
  assert.ok(res.tariff && typeof res.tariff === 'object');
});
