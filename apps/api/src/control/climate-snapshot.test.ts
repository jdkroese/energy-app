// Unit tests for climateSurplusW — the surplus signal the opportunistic-load rules gate on.
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/control/climate-snapshot.test.ts
// (apps/api has no formal test-runner script; tsx is a devDependency.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { climateSurplusW } from './climate-snapshot';
import type { SonnenNormalized } from '../connectors/sonnen';
import type { TeslaNormalized } from '../connectors/tesla';

/** Minimal Tesla view; gridKw>0 = importing, <0 = exporting. */
function tesla(p: Partial<TeslaNormalized> = {}): TeslaNormalized {
  return {
    soc: 75, kwh: 20, kw: 0, dir: 'idle', reservePct: 20, backupKwh: 0, backupHours: 0,
    island: false, solarKw: 0, loadKw: 0, gridKw: 0, online: true, ...p,
  } as TeslaNormalized;
}

/** Minimal Sonnen view; GridFeedIn_W>0 = exporting. */
function sonnen(p: Partial<SonnenNormalized> = {}): SonnenNormalized {
  return { soc: 75, productionW: 0, gridFeedInW: 0, consumptionW: 0, ...p } as SonnenNormalized;
}

test('surplus = Tesla grid export (gridKw negative)', () => {
  // Exporting 4.2 kW while the Sonnen sits at 75% and (theoretically) "could" still charge —
  // the old nameplate-headroom model reserved that and reported ~0; export-basis reports the
  // real 4200 W we're actually spilling.
  assert.equal(climateSurplusW(sonnen({ soc: 75 }), tesla({ gridKw: -4.2 })), 4200);
});

test('surplus is 0 while importing (gridKw positive)', () => {
  assert.equal(climateSurplusW(sonnen(), tesla({ gridKw: 1.5 })), 0);
});

test('Tesla gateway is preferred over the Sonnen meter', () => {
  // Tesla says exporting 3 kW; Sonnen disagrees — the whole-home Tesla gateway wins.
  assert.equal(climateSurplusW(sonnen({ gridFeedInW: -9999 }), tesla({ gridKw: -3 })), 3000);
});

test('falls back to the Sonnen feed-in meter when Tesla is missing', () => {
  assert.equal(climateSurplusW(sonnen({ gridFeedInW: 2500 }), null), 2500);
  assert.equal(climateSurplusW(sonnen({ gridFeedInW: -500 }), null), 0); // importing ⇒ 0
});

test('no live meter ⇒ 0 surplus', () => {
  assert.equal(climateSurplusW(null, null), 0);
});
