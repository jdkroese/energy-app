// Unit tests for the solar source-merge + dark-classification (docs/44). Run with:
//   node --import tsx --test src/solar-sources.test.ts
// (apps/api uses the Node built-in test runner via tsx, NOT vitest.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeSolarSources, matchCloudDevice, LOCAL_FRESH_MS } from './solar-sources';
import { classifyInverterState, backoffDelayMs, PRODUCING_FLOOR_W } from './connectors/sungrow';
import type { InverterNormalized } from './connectors/sungrow';
import type { CloudDevice, CloudSnapshot } from './connectors/isolarcloud';

const NOW = 1_700_000_000_000;

function inv(p: Partial<InverterNormalized>): InverterNormalized {
  return {
    id: '192.168.1.67',
    name: 'Solar Inverter 1',
    ip: '192.168.1.67',
    model: 'SG5.0RS',
    acPowerW: 0,
    dailyKwh: 0,
    totalKwh: 0,
    tempC: null,
    workState: 'Run',
    reachable: true,
    lastSeen: null,
    state: 'producing',
    reachableSibling: false,
    lastGoodTs: NOW,
    faults: [],
    ...p,
  };
}

function cloudDev(p: Partial<CloudDevice>): CloudDevice {
  return { serial: 'A2160700249', psKey: 'A2160700249_11_0_0', acPowerW: null, rawAcPower: null, rawAcPowerUnit: null, dailyKwh: null, totalKwh: null, deviceState: null, rawDevStatus: null, rawDevFaultStatus: null, offline: false, pointsPresent: null, allPoints: [], ...p };
}

function snap(devices: CloudDevice[]): CloudSnapshot {
  return { devices, ts: new Date(NOW).toISOString() };
}

// ---- classifyInverterState --------------------------------------------------

test('classify: reachable + meaningful power → producing', () => {
  assert.equal(classifyInverterState(true, 3940), 'producing');
});

test('classify: reachable + ~0 power → asleep', () => {
  assert.equal(classifyInverterState(true, 0), 'asleep');
  assert.equal(classifyInverterState(true, PRODUCING_FLOOR_W), 'asleep'); // boundary is NOT producing
});

test('classify: unreachable → unreachable (never silently asleep)', () => {
  assert.equal(classifyInverterState(false, 0), 'unreachable');
});

// ---- exponential backoff ----------------------------------------------------

test('backoff doubles 60s → 2m → 5m cap', () => {
  assert.equal(backoffDelayMs(0), 0);
  assert.equal(backoffDelayMs(1), 60_000);
  assert.equal(backoffDelayMs(2), 120_000);
  assert.equal(backoffDelayMs(3), 240_000);
  assert.equal(backoffDelayMs(4), 300_000); // capped at 5m
  assert.equal(backoffDelayMs(10), 300_000);
});

// ---- mergeSolarSources: no cloud -------------------------------------------

test('merge: no cloud snapshot → local passes through, source annotated', () => {
  const local = [inv({ acPowerW: 3000, reachable: true }), inv({ id: 'x', ip: 'x', reachable: false, state: 'unreachable' })];
  const out = mergeSolarSources(local, null, undefined, NOW);
  assert.equal(out[0].source, 'local');
  assert.equal(out[1].source, 'none');
  assert.equal(out[0].acPowerW, 3000);
});

// ---- mergeSolarSources: fresh local wins live kW ---------------------------

test('merge: fresh local keeps its live kW even when cloud has a value', () => {
  const local = [inv({ acPowerW: 3000, reachable: true, lastGoodTs: NOW - 10_000 })];
  const cloud = snap([cloudDev({ acPowerW: 999, offline: false })]);
  const out = mergeSolarSources(local, cloud, undefined, NOW);
  assert.equal(out[0].source, 'local');
  assert.equal(out[0].acPowerW, 3000); // local wins, not the cloud 999
});

// ---- mergeSolarSources: stale local falls back to cloud --------------------

test('merge: unreachable local falls back to cloud power + confirms not-dark', () => {
  const local = [inv({ acPowerW: 0, reachable: false, state: 'unreachable', lastGoodTs: NOW - 10 * 60_000 })];
  const cloud = snap([cloudDev({ acPowerW: 2500, dailyKwh: 12.4, offline: false })]);
  const out = mergeSolarSources(local, cloud, undefined, NOW);
  assert.equal(out[0].source, 'cloud');
  assert.equal(out[0].acPowerW, 2500);
  assert.equal(out[0].dailyKwh, 12.4);
  assert.equal(out[0].state, 'producing');
  assert.equal(out[0].cloudConfirmedDark, false);
});

test('merge: local dark + cloud says offline → cloudConfirmedDark set (outage source of truth)', () => {
  const local = [inv({ acPowerW: 0, reachable: false, state: 'unreachable', lastGoodTs: NOW - 10 * 60_000 })];
  const cloud = snap([cloudDev({ acPowerW: 0, offline: true })]);
  const out = mergeSolarSources(local, cloud, undefined, NOW);
  assert.equal(out[0].source, 'cloud');
  assert.equal(out[0].cloudConfirmedDark, true);
  assert.equal(out[0].state, 'unreachable');
});

test('merge: stale-but-reachable local (older than fresh window) still uses cloud fallback path', () => {
  const local = [inv({ acPowerW: 0, reachable: true, lastGoodTs: NOW - (LOCAL_FRESH_MS + 1000) })];
  const cloud = snap([cloudDev({ acPowerW: 1800, offline: false })]);
  const out = mergeSolarSources(local, cloud, undefined, NOW);
  assert.equal(out[0].source, 'cloud');
  assert.equal(out[0].acPowerW, 1800);
});

// ---- matchCloudDevice -------------------------------------------------------

test('match: explicit serialMap matches serial → dongle IP', () => {
  const i = inv({ id: '192.168.1.181', ip: '192.168.1.181' });
  const devs = [cloudDev({ serial: 'AAA', psKey: 'AAA_11_0_0' }), cloudDev({ serial: 'BBB', psKey: 'BBB_11_0_0' })];
  const map = { BBB: '192.168.1.181' };
  const m = matchCloudDevice(i, 0, devs, map);
  assert.equal(m?.serial, 'BBB');
});

test('match: explicit map that does not match → null (never guesses)', () => {
  const i = inv({ id: '10.0.0.9', ip: '10.0.0.9' });
  const devs = [cloudDev({ serial: 'AAA' })];
  const m = matchCloudDevice(i, 0, devs, { ZZZ: '1.2.3.4' });
  assert.equal(m, null);
});

test('match: no map → positional fallback by index', () => {
  const i = inv({});
  const devs = [cloudDev({ serial: 'AAA' }), cloudDev({ serial: 'BBB' })];
  assert.equal(matchCloudDevice(i, 1, devs, undefined)?.serial, 'BBB');
  assert.equal(matchCloudDevice(i, 5, devs, undefined), null);
});
