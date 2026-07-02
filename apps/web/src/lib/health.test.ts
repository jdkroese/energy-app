// Unit tests for the shared health derivation (docs/36 §3). apps/web has no
// formal test runner; mirror capabilities.test.ts and run with tsx + node:test:
//   node --import tsx --test apps/web/src/lib/health.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  worstState,
  isIssue,
  healthTone,
  subsystemRollup,
  climateHealth,
  blindHealth,
  batteryHealth,
  type RollupInput,
} from './health';
import type { DeviceView, BlindUnit, BatteryDetail } from './types';

test('worstState picks the most severe; empty → ok', () => {
  assert.equal(worstState([]), 'ok');
  assert.equal(worstState(['ok', 'nosetup']), 'ok');
  assert.equal(worstState(['ok', 'warning', 'offline']), 'offline');
  assert.equal(worstState(['warning', 'error', 'offline']), 'error');
});

test('isIssue: warning/offline/error are issues; ok/nosetup are not', () => {
  assert.equal(isIssue('warning'), true);
  assert.equal(isIssue('offline'), true);
  assert.equal(isIssue('error'), true);
  assert.equal(isIssue('ok'), false);
  assert.equal(isIssue('nosetup'), false);
});

test('healthTone maps states to StatusDot tones', () => {
  assert.equal(healthTone('ok'), 'solar');
  assert.equal(healthTone('warning'), 'grid');
  assert.equal(healthTone('error'), 'danger');
  assert.equal(healthTone('offline'), 'grid'); // offline is a fault the owner should see — amber, not muted
  assert.equal(healthTone('nosetup'), 'offline'); // only not-configured stays muted
});

test('climateHealth: offline > lowBattery > ok', () => {
  const base = { online: true, lowBattery: false } as unknown as DeviceView;
  assert.equal(climateHealth({ ...base, online: false }).state, 'offline');
  assert.equal(climateHealth({ ...base, lowBattery: true }).state, 'warning');
  assert.equal(climateHealth(base).state, 'ok');
});

test('blindHealth: un-anchored timed blind warns', () => {
  const base = { online: true, positionMode: 'timed', anchored: false } as unknown as BlindUnit;
  assert.equal(blindHealth(base).state, 'warning');
  assert.equal(blindHealth({ ...base, anchored: true }).state, 'ok');
  assert.equal(blindHealth({ ...base, online: false }).state, 'offline');
});

test('batteryHealth: low health warns', () => {
  const base = { online: true, health: 92 } as unknown as BatteryDetail;
  assert.equal(batteryHealth(base).state, 'ok');
  assert.equal(batteryHealth({ ...base, health: 60 }).state, 'warning');
  assert.equal(batteryHealth({ ...base, online: false }).state, 'offline');
});

test('subsystemRollup: counts, issues float, fleetError forces error', () => {
  const items: RollupInput[] = [
    { id: 'a', name: 'A', health: { state: 'ok', reason: 'Online' } },
    { id: 'b', name: 'B', health: { state: 'offline', reason: 'Offline' } },
    { id: 'c', name: 'C', health: { state: 'warning', reason: 'Low battery' } },
  ];
  const r = subsystemRollup(items);
  assert.equal(r.total, 3);
  assert.equal(r.online, 2); // b is offline
  assert.equal(r.worst, 'offline');
  assert.equal(r.issues.length, 2);
  // worst-first ordering
  assert.equal(r.issues[0].state, 'offline');

  const withFleet = subsystemRollup(items, { fleetError: 'Cloud unreachable' });
  assert.equal(withFleet.worst, 'error');
  assert.equal(withFleet.issues[0].reason, 'Cloud unreachable');
});
