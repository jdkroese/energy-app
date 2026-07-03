// Unit tests for the daylight-gated recovery hold (FIX 1): the dark/offline/stall inverter
// alerts stop firing at DUSK because their daylight gate closes — not because the inverter
// recovered. shouldHoldRecovery() must HOLD (suppress) the "outage cleared" message at
// night/dusk for those daylight-gated watches, but still ALLOW it on a genuine daytime
// recovery, and never hold a non-gated watch (voltage / charge-stall / fault).
// Run with: node --import tsx --test src/alert-loop-recovery.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldHoldRecovery } from './alert-loop';

test('daylight-gated watch is HELD when it is NOT daylight (dusk/night) — no false all-clear', () => {
  assert.equal(shouldHoldRecovery({ daylightGated: true }, /* daylight */ false), true);
});

test('daylight-gated watch is RELEASED on a genuine daytime recovery (daylight true)', () => {
  assert.equal(shouldHoldRecovery({ daylightGated: true }, /* daylight */ true), false);
});

test('a non-daylight-gated watch (voltage / charge-stall / fault) is never held, even at night', () => {
  assert.equal(shouldHoldRecovery({ daylightGated: false }, false), false);
  assert.equal(shouldHoldRecovery({ daylightGated: false }, true), false);
  // undefined (default) is treated as not gated.
  assert.equal(shouldHoldRecovery({}, false), false);
});
