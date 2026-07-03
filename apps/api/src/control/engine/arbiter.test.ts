// Unit tests for the arbiter — priority resolution, tie-rejection at registration, loser
// recording, and the D5 demand clamps.
// Run: node --import tsx --test src/control/engine/arbiter.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { arbitrate, assertNoPriorityCollisions } from './arbiter';
import { PRIORITY } from './types';
import type { Claim, RuleDef, SonnenStance } from './types';
import type { ReconciledSnapshot } from './reconciled-snapshot';

/** Narrow a sonnen.stance claim's value (the union's value type is actuator-discriminated). */
function stance(claim: Claim | undefined): SonnenStance {
  assert.ok(claim);
  assert.equal(claim!.actuator, 'sonnen.stance');
  if (claim!.actuator !== 'sonnen.stance') throw new Error('not a sonnen.stance claim');
  return claim!.value;
}

// A minimal reconciled snapshot for clamp math. Only the fields the arbiter reads matter.
function recon(p: Partial<ReconciledSnapshot>): ReconciledSnapshot {
  return {
    band: 'P1',
    ageMs: 0,
    gridDirection: 'neutral',
    gridSource: 'sonnen',
    gridImportW: 0,
    gridExportW: 0,
    houseResidualW: 0,
    surplusW: 0,
    sonnenSoc: 50,
    teslaSoc: 50,
    meterDisagreementW: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: {} as any,
    ...p,
  };
}

function chargeClaim(ruleId: string, priority: number, chargeW: number): Claim {
  return {
    actuator: 'sonnen.stance',
    value: { mode: '1', chargeW, dischargeW: 0 },
    ruleId,
    priority,
    reason: `${ruleId} charge ${chargeW}W`,
    clamp: 'absorb',
  };
}

function dischargeClaim(ruleId: string, priority: number, dischargeW: number): Claim {
  return {
    actuator: 'sonnen.stance',
    value: { mode: '1', chargeW: 0, dischargeW },
    ruleId,
    priority,
    reason: `${ruleId} discharge ${dischargeW}W`,
    clamp: 'discharge',
  };
}

// ---- Priority resolution ----------------------------------------------------
test('highest-priority claim wins the actuator', () => {
  const claims: Claim[] = [
    { actuator: 'tesla.mode', value: 'self_consumption', ruleId: 'low', priority: PRIORITY.DEFAULT, reason: 'default' },
    { actuator: 'tesla.mode', value: 'backup', ruleId: 'high', priority: PRIORITY.WATCHDOG, reason: 'watchdog hold' },
  ];
  const r = arbitrate(claims, recon({}));
  assert.equal(r.intents['tesla.mode']?.ruleId, 'high');
  assert.equal((r.intents['tesla.mode']?.value as string), 'backup');
});

test('every loser is recorded with a reason naming the winner', () => {
  const claims: Claim[] = [
    { actuator: 'tesla.mode', value: 'self_consumption', ruleId: 'econ', priority: PRIORITY.ECONOMIC, reason: 'economic' },
    { actuator: 'tesla.mode', value: 'backup', ruleId: 'wd', priority: PRIORITY.WATCHDOG, reason: 'watchdog' },
    { actuator: 'tesla.mode', value: 'autonomous', ruleId: 'comfort', priority: PRIORITY.COMFORT, reason: 'comfort' },
  ];
  const r = arbitrate(claims, recon({}));
  const res = r.resolutions.find((x) => x.actuator === 'tesla.mode');
  assert.ok(res);
  assert.equal(res!.winner?.ruleId, 'wd');
  assert.equal(res!.losers.length, 2);
  for (const l of res!.losers) {
    assert.match(l.reason, /priority \d+ < \d+ \(wd\)/);
  }
});

test('different actuators each resolve independently', () => {
  const claims: Claim[] = [
    { actuator: 'tesla.mode', value: 'backup', ruleId: 'a', priority: PRIORITY.ECONOMIC, reason: 'a' },
    chargeClaim('b', PRIORITY.ECONOMIC, 500),
  ];
  const r = arbitrate(claims, recon({ surplusW: 1000 }));
  assert.equal(r.intents['tesla.mode']?.ruleId, 'a');
  assert.equal(r.intents['sonnen.stance']?.ruleId, 'b');
});

// ---- Tie rejection (at REGISTRATION, not per tick) --------------------------
test('registration throws on a same-priority collision', () => {
  const rules: RuleDef[] = [
    { id: 'r1', domain: 'battery', priority: PRIORITY.ECONOMIC, params: {}, decide: () => [] },
    { id: 'r2', domain: 'battery', priority: PRIORITY.ECONOMIC, params: {}, decide: () => [] },
  ];
  assert.throws(() => assertNoPriorityCollisions(rules), /priority collision at 500: r1, r2/);
});

test('distinct priorities register cleanly', () => {
  const rules: RuleDef[] = [
    { id: 'r1', domain: 'battery', priority: PRIORITY.ECONOMIC, params: {}, decide: () => [] },
    { id: 'r2', domain: 'watchdog', priority: PRIORITY.WATCHDOG, params: {}, decide: () => [] },
  ];
  assert.doesNotThrow(() => assertNoPriorityCollisions(rules));
});

// ---- Demand clamps (D5) -----------------------------------------------------
test('discharge claim is clamped to houseResidualW', () => {
  const r = arbitrate([dischargeClaim('dp', PRIORITY.ECONOMIC, 4600)], recon({ houseResidualW: 1200 }));
  const w = r.intents['sonnen.stance'];
  assert.equal(stance(w).dischargeW, 1200, 'clamped down to the real residual — can never push to grid');
  assert.match(w!.reason, /discharge clamped 4600→1200W/);
});

test('discharge claim with NO residual (Sonnen offline → null) is dropped, becomes a loser', () => {
  const r = arbitrate([dischargeClaim('dp', PRIORITY.ECONOMIC, 3000)], recon({ houseResidualW: null }));
  assert.equal(r.intents['sonnen.stance'], undefined, 'no trustworthy residual → no discharge (safe default)');
  const res = r.resolutions.find((x) => x.actuator === 'sonnen.stance');
  assert.equal(res?.winner, null);
  assert.equal(res?.losers.length, 1);
  assert.match(res!.losers[0].reason, /no house residual/);
});

test('discharge claim with zero residual is dropped', () => {
  const r = arbitrate([dischargeClaim('dp', PRIORITY.ECONOMIC, 3000)], recon({ houseResidualW: 0 }));
  assert.equal(r.intents['sonnen.stance'], undefined);
});

test('absorb claim is clamped to surplusW', () => {
  const r = arbitrate([chargeClaim('soak', PRIORITY.ECONOMIC, 4600)], recon({ surplusW: 830 }));
  const w = r.intents['sonnen.stance'];
  assert.equal(stance(w).chargeW, 830);
  assert.match(w!.reason, /absorb clamped 4600→830W/);
});

test('absorb claim with no surplus is dropped', () => {
  const r = arbitrate([chargeClaim('soak', PRIORITY.ECONOMIC, 3000)], recon({ surplusW: 0 }));
  assert.equal(r.intents['sonnen.stance'], undefined);
});

test('a claim within the ceiling is not annotated as clamped', () => {
  const r = arbitrate([chargeClaim('soak', PRIORITY.ECONOMIC, 500)], recon({ surplusW: 1000 }));
  const w = r.intents['sonnen.stance'];
  assert.equal(stance(w).chargeW, 500);
  assert.doesNotMatch(w!.reason, /clamped/);
});

test('a higher-priority claim clamped OUT lets a lower-priority survivor win the actuator', () => {
  // Watchdog wants to discharge but there is no residual → dropped. A lower-priority absorb
  // with surplus survives and wins. (Demonstrates clamp precedes priority.)
  const claims: Claim[] = [
    dischargeClaim('wd', PRIORITY.WATCHDOG, 3000),
    chargeClaim('soak', PRIORITY.ECONOMIC, 600),
  ];
  const r = arbitrate(claims, recon({ houseResidualW: 0, surplusW: 1000 }));
  assert.equal(r.intents['sonnen.stance']?.ruleId, 'soak');
});

test('empty claim set → no intents', () => {
  const r = arbitrate([], recon({}));
  assert.equal(Object.keys(r.intents).length, 0);
  assert.equal(r.resolutions.length, 0);
});
