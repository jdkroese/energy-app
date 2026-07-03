// Unit tests for decideTeslaMode — the Tesla mode decision (Phase 0 fix).
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/control/coordinator-tesla-mode.test.ts
//
// Regression: the old favoursArbitrage(scenario) heuristic pinned the Tesla to
// 'autonomous' for ANY scenario with gridCharge (max-savings / storm-ready), handing the
// discharge decision to Tesla's own optimizer — which idled at 100% through P1/P2 while
// the house imported 3.7 kW of P2 grid (observed 2026-07-02 evening). 'autonomous' is now
// warranted ONLY by the tariff-arbitrage automation in enabled+ACTIVE execution mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideTeslaMode } from './coordinator';

test('max-savings-style scenario WITHOUT active arbitrage → self_consumption (the fix)', () => {
  // The scenario no longer matters: with no active-mode arbitrage and no hold, the Tesla
  // must discharge for the house — never sit in vendor-autonomous.
  const d = decideTeslaMode(false, false, 'auto');
  assert.equal(d.mode, 'self_consumption');
});

test('discharge-priority hold in auto authority → backup (unchanged)', () => {
  const d = decideTeslaMode(false, true, 'auto');
  assert.equal(d.mode, 'backup');
});

test('discharge-priority hold in SHADOW authority → self_consumption (shadow never writes)', () => {
  const d = decideTeslaMode(false, true, 'shadow');
  assert.equal(d.mode, 'self_consumption');
});

test('tariff-arbitrage enabled + active execution mode → autonomous', () => {
  const d = decideTeslaMode(true, false, 'auto');
  assert.equal(d.mode, 'autonomous');
});

test('active arbitrage outranks the discharge hold', () => {
  const d = decideTeslaMode(true, true, 'auto');
  assert.equal(d.mode, 'autonomous');
});

test('every decision carries a one-line reason (feeds the decision trace)', () => {
  for (const [arb, hold] of [
    [false, false],
    [false, true],
    [true, false],
  ] as const) {
    const d = decideTeslaMode(arb, hold, 'auto');
    assert.ok(d.reason.length > 0, `${d.mode} must explain itself`);
  }
});
