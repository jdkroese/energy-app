// Run with:
//   node --import tsx --test src/control/water-billing.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { billingPeriodFor, projectPeriodM3 } from './water-billing';

// AMJASA reads on the 1st of odd months — factura 3/1836657 ran 01/05 -> 01/07/2026.
const ANCHOR = '2026-07-01';

test('finds the bimonthly period containing a date', () => {
  const p = billingPeriodFor(new Date('2026-08-15T10:00:00Z'), ANCHOR, 2);
  assert.equal(p.startDay, '2026-07-01');
  assert.equal(p.endDay, '2026-09-01');
  assert.equal(p.months, 2);
  assert.equal(p.daysTotal, 62); // Jul 31 + Aug 31
});

test('the anchor date itself starts a period, it does not end one', () => {
  const p = billingPeriodFor(new Date('2026-07-01T09:00:00Z'), ANCHOR, 2);
  assert.equal(p.startDay, '2026-07-01');
  assert.equal(p.daysElapsed, 0);
});

test('a date before the anchor resolves to an earlier period, not a crash', () => {
  const p = billingPeriodFor(new Date('2026-05-20T10:00:00Z'), ANCHOR, 2);
  assert.equal(p.startDay, '2026-05-01');
  assert.equal(p.endDay, '2026-07-01');
});

test('reproduces the billed period on the real invoice (01/05 -> 01/07)', () => {
  const p = billingPeriodFor(new Date('2026-06-15T12:00:00Z'), ANCHOR, 2);
  assert.equal(p.startDay, '2026-05-01');
  assert.equal(p.endDay, '2026-07-01');
  // The bill states 152 m3 and 2,492 m3/day, implying 61 days.
  assert.equal(p.daysTotal, 61);
});

test('periods tile the timeline with no gap or overlap', () => {
  const a = billingPeriodFor(new Date('2026-08-15T10:00:00Z'), ANCHOR, 2);
  const b = billingPeriodFor(new Date('2026-09-15T10:00:00Z'), ANCHOR, 2);
  assert.equal(a.endSec, b.startSec, 'one period ends exactly where the next begins');
});

test('a month-boundary anchor survives short months', () => {
  const p = billingPeriodFor(new Date('2026-02-10T10:00:00Z'), '2026-01-31', 1);
  assert.equal(p.startDay, '2026-01-31');
  assert.equal(p.endDay, '2026-02-28', 'clamped into February rather than spilling into March');
});

test('an unparseable anchor degrades instead of throwing', () => {
  const p = billingPeriodFor(new Date('2026-08-15T10:00:00Z'), 'not-a-date', 2);
  assert.ok(p.startDay.length === 10);
  assert.equal(p.months, 2);
});

test('projection answers "at this rate, where do I land?"', () => {
  const p = billingPeriodFor(new Date('2026-08-01T10:00:00Z'), ANCHOR, 2);
  // 31 days elapsed of 62; 140 m3 so far -> ~280 m3 for the period.
  assert.equal(p.daysElapsed, 31);
  assert.equal(projectPeriodM3(140, p), 280);
});

test('projection does not divide by zero on the first day', () => {
  const p = billingPeriodFor(new Date('2026-07-01T06:00:00Z'), ANCHOR, 2);
  assert.equal(p.daysElapsed, 0);
  assert.ok(Number.isFinite(projectPeriodM3(3, p)));
});
