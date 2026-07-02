// Unit tests for the site-wide solar plausibility clamp (defense-in-depth against a
// Tesla-side/summing anomaly the per-inverter Sungrow guard can't catch). Run with the
// Node built-in test runner via tsx:
//   node --import tsx --test src/routes/live-solar-clamp.test.ts
// (apps/api has no formal test-runner script; tsx is a devDependency.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampSiteSolarKw, SITE_SOLAR_CEILING_KW } from './live';

test('a normal total (9.2 kW) passes through unchanged and is not flagged', () => {
  const r = clampSiteSolarKw(9.2);
  assert.equal(r.kw, 9.2);
  assert.equal(r.clamped, false);
});

test('a value at the ceiling is not clamped', () => {
  const r = clampSiteSolarKw(SITE_SOLAR_CEILING_KW);
  assert.equal(r.kw, SITE_SOLAR_CEILING_KW);
  assert.equal(r.clamped, false);
});

test('an impossible total is clamped to the ceiling and flagged', () => {
  // e.g. a garbage sample that summed to 15.6 + normal arrays → well over 18.
  const r = clampSiteSolarKw(24.7);
  assert.equal(r.kw, SITE_SOLAR_CEILING_KW);
  assert.equal(r.clamped, true);
});

test('a negative value is floored to 0 but NOT flagged (no log spam)', () => {
  const r = clampSiteSolarKw(-3);
  assert.equal(r.kw, 0);
  assert.equal(r.clamped, false);
});

test('a non-finite value degrades to 0, not flagged', () => {
  const r = clampSiteSolarKw(Number.NaN);
  assert.equal(r.kw, 0);
  assert.equal(r.clamped, false);
});

test('a custom ceiling is respected', () => {
  const r = clampSiteSolarKw(12, 10);
  assert.equal(r.kw, 10);
  assert.equal(r.clamped, true);
});
