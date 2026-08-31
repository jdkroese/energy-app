// Unit tests for the Tuya cloud connector's pure helpers. Run from apps/api:
//   node --import tsx --test src/connectors/tuya.test.ts
//
// Importing tuya.ts pulls in tuya-local.ts, which at import time reads the store and (when
// local is enabled) starts a UDP discovery listener. So — exactly like tuya-local.test.ts —
// we point the store at a scratch file and hard-disable local via the env kill-switch BEFORE
// the dynamic import, so this suite never opens sockets or touches the real state.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuya-test-'));
process.env.DATA_DIR = scratchDir;
process.env.STATE_FILE = path.join(scratchDir, 'state.json');
process.env.TUYA_LOCAL_ENABLED = '0';

const tuya = await import('./tuya');
const tuyaLocal = await import('./tuya-local');
const store = await import('../store');
// Boot decision (module-import-time `if (isLocalEnabled()) startDiscoveryListener()`) is made
// with local hard-disabled above — restore to "unset" so the docs/51 getDevices() tests below
// can exercise real on/off semantics via the store, same pattern as tuya-local.test.ts.
delete process.env.TUYA_LOCAL_ENABLED;
const {
  parseThingModelDpMap,
  normCode,
  dpMapsFor,
  localFleetSnapshot,
  mapWithConcurrency,
  captureDpMaps,
  getDevices,
  isExcludedSubOrGateway,
  isKnownExcludedId,
  syncFleetFromCloud,
  invalidateFleet,
} = tuya;

/** docs/51 test helper: set local (LAN) control on/off via the store (the env kill-switch is
 *  deleted above so this takes effect). */
function setLocalControl(enabled: boolean): void {
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.tuya = { ...(s.integrations.tuya ?? {}), localControl: enabled };
  });
}

/** docs/51 test helper: set the manual (LAN-only) fleet toggle via the store.
 *  `undefined` restores the default (ON). */
function setFleetManual(enabled: boolean | undefined): void {
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.tuya = { ...(s.integrations.tuya ?? {}), fleetManual: enabled };
  });
}

// A real Tuya thing-model payload (trimmed) for a `cz` metering plug — the `model` field is
// itself a JSON string, and each property carries `abilityId` (the local dp number).
const REAL_MODEL = JSON.stringify({
  services: [
    {
      properties: [
        { abilityId: 1, code: 'switch_1', typeSpec: { type: 'bool' } },
        { abilityId: 9, code: 'countdown_1', typeSpec: { type: 'value' } },
        { abilityId: 19, code: 'cur_power', typeSpec: { type: 'value' } },
        { abilityId: 20, code: 'cur_voltage', typeSpec: { type: 'value' } },
        { abilityId: 51, code: 'overcharge_switch', typeSpec: { type: 'bool' } },
      ],
    },
  ],
});

test('parseThingModelDpMap maps each code to its abilityId (the local dp)', () => {
  const map = parseThingModelDpMap(REAL_MODEL);
  assert.equal(map.get('switch_1'), 1);
  assert.equal(map.get('cur_power'), 19);
  assert.equal(map.get('cur_voltage'), 20);
  assert.equal(map.get('overcharge_switch'), 51);
  assert.equal(map.size, 5);
});

test('parseThingModelDpMap flattens properties across multiple services', () => {
  const model = JSON.stringify({
    services: [
      { properties: [{ abilityId: 1, code: 'switch_led' }] },
      { properties: [{ abilityId: 22, code: 'bright_value' }] },
    ],
  });
  const map = parseThingModelDpMap(model);
  assert.equal(map.get('switch_led'), 1);
  assert.equal(map.get('bright_value'), 22);
});

test('parseThingModelDpMap tolerates junk without throwing', () => {
  assert.equal(parseThingModelDpMap('not json').size, 0);
  assert.equal(parseThingModelDpMap('{}').size, 0);
  assert.equal(parseThingModelDpMap(JSON.stringify({ services: [] })).size, 0);
  assert.equal(parseThingModelDpMap(JSON.stringify({ services: [{}] })).size, 0);
});

test('parseThingModelDpMap skips properties missing code or a numeric abilityId', () => {
  const model = JSON.stringify({
    services: [
      {
        properties: [
          { abilityId: 1, code: 'switch_1' }, // kept
          { code: 'no_ability' }, // no abilityId -> skipped
          { abilityId: 7 }, // no code -> skipped
          { abilityId: '3', code: 'string_ability' }, // abilityId not a number -> skipped
        ],
      },
    ],
  });
  const map = parseThingModelDpMap(model);
  assert.equal(map.size, 1);
  assert.equal(map.get('switch_1'), 1);
});

test('normCode collapses transposed code spellings for the same datapoint', () => {
  // The exact real-world mismatch: cloud spec says switch_led_1, thing model says led_switch_1.
  assert.equal(normCode('switch_led_1'), normCode('led_switch_1'));
  assert.equal(normCode('switch_led_1'), '1_led_switch');
});

test('normCode is case- and separator-insensitive but keeps distinct codes distinct', () => {
  assert.equal(normCode('Bright_Value_1'), normCode('bright value 1'));
  assert.notEqual(normCode('switch_1'), normCode('switch_2'));
  assert.notEqual(normCode('switch_led_1'), normCode('bright_value_1'));
});

// ---- mapWithConcurrency (docs/49 Change 2) -----------------------------------------------

test('mapWithConcurrency: preserves result order and never runs more than `limit` at once', async () => {
  let active = 0;
  let maxActive = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const results = await mapWithConcurrency(items, 3, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 10;
  });
  assert.deepEqual(results, items.map((n) => n * 10));
  assert.ok(maxActive <= 3, `max concurrent was ${maxActive}`);
});

test('mapWithConcurrency: an empty items array resolves to an empty array without invoking fn', async () => {
  let calls = 0;
  const results = await mapWithConcurrency([] as number[], 5, async () => {
    calls++;
    return 0;
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test('mapWithConcurrency: limit larger than the item count still runs every item exactly once', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 50, async (n) => n + 1);
  assert.deepEqual(results, [2, 3, 4]);
});

// ---- dpMapsFor: persisted-first + capture-on-cloud-success (docs/49 Change 1) ------------
// Mocks global.fetch (a real writable global, unlike this module's own ESM exports) to stand
// in for the Tuya cloud. Sets store creds so isConfigured()/mustCreds() succeed.

function setTuyaCreds(): void {
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.tuya = { ...(s.integrations.tuya ?? {}), region: 'eu', accessId: 'test-id', accessSecret: 'test-secret' };
  });
}

const REAL_MODEL_2 = JSON.stringify({
  services: [{ properties: [{ abilityId: 1, code: 'switch_1' }, { abilityId: 19, code: 'cur_power' }] }],
});

/** Minimal fetch mock: answers the token endpoint, the thing-model endpoint (with
 *  `modelJson`), and the specifications endpoint (empty — the alias-bridge step is allowed
 *  to no-op), tracking how many thing-model calls were made. Never touches the real network. */
function installFetchMock(modelJson: string): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let thingModelCalls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    const json = async (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
    if (u.includes('/v1.0/token')) {
      return json({ success: true, result: { access_token: 'tok', expire_time: 7200, uid: 'u1' } });
    }
    if (u.includes('/cloud/thing/') && u.endsWith('/model')) {
      thingModelCalls++;
      return json({ success: true, result: { model: modelJson } });
    }
    if (u.includes('/specifications')) {
      return json({ success: true, result: { category: 'kg', functions: [], status: [] } });
    }
    return json({ success: false, code: 999, msg: `unmocked url in test: ${u}` });
  }) as typeof fetch;
  return {
    calls: () => thingModelCalls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('dpMapsFor: a persisted dp-map (tuyaLocal.getDpMap) short-circuits — zero cloud calls', async () => {
  setTuyaCreds();
  // Seed a registry entry to persist onto (setDpMap no-ops for an unknown device id).
  fs.writeFileSync(
    path.join(scratchDir, 'tuya-local.json'),
    JSON.stringify({ devices: [{ id: 'bf-precached-1', name: 'Precached', category: 'kg', localKey: '0123456789abcdef', lanIp: '', version: '3.3', sub: false }] }),
  );
  tuyaLocal.reloadRegistry();
  tuyaLocal.setDpMap('bf-precached-1', new Map([['switch_1', 1], ['cur_power', 19]]));

  const mock = installFetchMock(REAL_MODEL_2);
  try {
    const maps = await dpMapsFor('bf-precached-1');
    assert.equal(maps.codeToDp.get('switch_1'), 1);
    assert.equal(maps.codeToDp.get('cur_power'), 19);
    assert.equal(mock.calls(), 0, 'a persisted map must never trigger a cloud thing-model fetch');
  } finally {
    mock.restore();
  }
});

test('dpMapsFor: no persisted map -> fetches the cloud thing model once, then PERSISTS it via tuyaLocal.setDpMap', async () => {
  setTuyaCreds();
  fs.writeFileSync(
    path.join(scratchDir, 'tuya-local.json'),
    JSON.stringify({ devices: [{ id: 'bf-freshcapture-1', name: 'Fresh', category: 'kg', localKey: '0123456789abcdef', lanIp: '', version: '3.3', sub: false }] }),
  );
  tuyaLocal.reloadRegistry();
  assert.equal(tuyaLocal.getDpMap('bf-freshcapture-1'), null, 'nothing persisted yet');

  const mock = installFetchMock(REAL_MODEL_2);
  try {
    const maps = await dpMapsFor('bf-freshcapture-1');
    assert.equal(maps.codeToDp.get('switch_1'), 1);
    assert.equal(mock.calls(), 1, 'exactly one cloud thing-model fetch for a fresh capture');

    const persisted = tuyaLocal.getDpMap('bf-freshcapture-1');
    assert.ok(persisted, 'a successful cloud fetch must be persisted onto the registry entry');
    assert.equal(persisted!.codeToDp.get('switch_1'), 1);
    assert.equal(persisted!.codeToDp.get('cur_power'), 19);
  } finally {
    mock.restore();
  }
});

// ---- localFleetSnapshot (docs/49 Change 2): shape + per-device failure isolation --------

test('localFleetSnapshot: only locally-capable devices WITH a persisted dp-map appear; a per-device read failure degrades to offline, not dropped', async () => {
  fs.writeFileSync(
    path.join(scratchDir, 'tuya-local.json'),
    JSON.stringify({
      devices: [
        // Capable + has a dp-map -> included (will fail to connect to 127.0.0.1:6668 in this
        // sandbox, which is the point: that failure must degrade the entry, not drop it).
        { id: 'bf-local-cap', name: 'Local Cap', category: 'kg', localKey: '0123456789abcdef', lanIp: '127.0.0.1', version: '3.3', sub: false },
        // Capable but no dp-map captured yet -> excluded.
        { id: 'bf-local-nodp', name: 'No Dp', category: 'kg', localKey: '0123456789abcdef', lanIp: '127.0.0.1', version: '3.3', sub: false },
        // Zigbee/BLE sub-device -> never locally capable -> excluded, even with a dp-map.
        { id: 'bf-local-sub', name: 'Sub', category: 'wxkg', localKey: '0123456789abcdef', lanIp: '', version: '', sub: true },
      ],
    }),
  );
  tuyaLocal.reloadRegistry();
  tuyaLocal.setDpMap('bf-local-cap', new Map([['switch_1', 1]]));
  tuyaLocal.setDpMap('bf-local-sub', new Map([['switch_1', 1]])); // even with a map, sub stays excluded

  const fleet = await localFleetSnapshot();
  const ids = fleet.map((d) => d.id);
  assert.ok(ids.includes('bf-local-cap'));
  assert.ok(!ids.includes('bf-local-nodp'), 'capable but no persisted dp-map yet -> excluded');
  assert.ok(!ids.includes('bf-local-sub'), 'gateway sub-device -> excluded regardless of dp-map');

  const cap = fleet.find((d) => d.id === 'bf-local-cap')!;
  assert.equal(cap.online, false, 'nothing is listening on 127.0.0.1:6668 in this sandbox -> read fails');
  assert.deepEqual(cap.status, []);
  assert.equal(cap.name, 'Local Cap');
  assert.equal(cap.category, 'kg');
});

test('localFleetSnapshot: an empty registry (or none locally capable) resolves to an empty array', async () => {
  fs.writeFileSync(path.join(scratchDir, 'tuya-local.json'), JSON.stringify({ devices: [] }));
  tuyaLocal.reloadRegistry();
  assert.deepEqual(await localFleetSnapshot(), []);
});

// ---- captureDpMaps (docs/49 Change 4) -----------------------------------------------------

test('captureDpMaps: captures locally-capable devices missing a map, counts ones that already had it, skips sub-devices', async () => {
  setTuyaCreds();
  fs.writeFileSync(
    path.join(scratchDir, 'tuya-local.json'),
    JSON.stringify({
      devices: [
        { id: 'bf-cap-new', name: 'New', category: 'kg', localKey: '0123456789abcdef', lanIp: '192.168.9.9', version: '3.3', sub: false },
        { id: 'bf-cap-existing', name: 'Existing', category: 'kg', localKey: '0123456789abcdef', lanIp: '192.168.9.10', version: '3.3', sub: false },
        { id: 'bf-cap-sub', name: 'Sub', category: 'wxkg', localKey: '0123456789abcdef', lanIp: '', version: '', sub: true },
      ],
    }),
  );
  tuyaLocal.reloadRegistry();
  tuyaLocal.setDpMap('bf-cap-existing', new Map([['switch_1', 1]]));

  const mock = installFetchMock(REAL_MODEL_2);
  try {
    const result = await captureDpMaps();
    assert.equal(result.total, 2, 'the sub-device is excluded from the fleet total');
    assert.equal(result.captured, 1, 'bf-cap-new is newly captured');
    assert.equal(result.alreadyHad, 1, 'bf-cap-existing already had a map — dpMapsFor returns it without a fresh fetch');
    assert.equal(result.failed, 0);
    assert.deepEqual(result.failedIds, []);

    const gotNew = tuyaLocal.getDpMap('bf-cap-new');
    assert.ok(gotNew, 'the newly-captured map is persisted');
    assert.equal(gotNew!.codeToDp.get('switch_1'), 1);
  } finally {
    mock.restore();
  }
});

test('captureDpMaps: a device not YET locally capable (no LAN ip discovered) is still captured — future-proofing, not gated on current reachability', async () => {
  setTuyaCreds();
  fs.writeFileSync(
    path.join(scratchDir, 'tuya-local.json'),
    JSON.stringify({
      devices: [
        // No lanIp yet (undiscovered) and no key (pending re-harvest) — NOT locally capable
        // right now, but still worth capturing a dp-map for ahead of either being fixed.
        { id: 'bf-cap-nolan', name: 'No LAN yet', category: 'kg', localKey: '', lanIp: '', version: '', sub: false },
      ],
    }),
  );
  tuyaLocal.reloadRegistry();
  assert.equal(tuyaLocal.isLocalCapable('bf-cap-nolan'), false, 'sanity: not locally capable today');

  const mock = installFetchMock(REAL_MODEL_2);
  try {
    const result = await captureDpMaps();
    assert.equal(result.total, 1, 'a not-yet-capable non-sub device is still included in the capture pass');
    assert.equal(result.captured, 1);
    assert.ok(tuyaLocal.getDpMap('bf-cap-nolan'), 'its dp-map is persisted even though it cannot go local yet');
  } finally {
    mock.restore();
  }
});

test('captureDpMaps: a device the cloud has no thing-model for counts as failed, without aborting the run', async () => {
  setTuyaCreds();
  fs.writeFileSync(
    path.join(scratchDir, 'tuya-local.json'),
    JSON.stringify({
      devices: [
        { id: 'bf-cap-ok', name: 'Ok', category: 'kg', localKey: '0123456789abcdef', lanIp: '192.168.9.11', version: '3.3', sub: false },
        { id: 'bf-cap-empty', name: 'Empty model', category: 'kg', localKey: '0123456789abcdef', lanIp: '192.168.9.12', version: '3.3', sub: false },
      ],
    }),
  );
  tuyaLocal.reloadRegistry();

  const mock = installFetchMock(JSON.stringify({ services: [] })); // resolves to an EMPTY map for every device
  try {
    const result = await captureDpMaps();
    assert.equal(result.total, 2);
    assert.equal(result.captured, 0);
    assert.equal(result.failed, 2, 'an empty resolved map counts as a failure to capture, not a silent success');
    assert.deepEqual(result.failedIds.sort(), ['bf-cap-empty', 'bf-cap-ok']);
  } finally {
    mock.restore();
  }
});

// ---- docs/51: manual (LAN-only) fleet + sub-device/gateway exclusion --------------------
// Mocks global.fetch to stand in for BOTH the token endpoint and the cloud fleet endpoints
// (bulk associated-users listing + the per-device direct read) so every assertion below can
// see EXACTLY which URLs (if any) were hit — the whole point of docs/51 Change 1 is that a
// manual+local-on getDevices() call must hit none of them at all.

function installFleetFetchMock(opts: {
  bulkDevices?: Array<Record<string, unknown>>;
  directDevices?: Record<string, Record<string, unknown>>;
}): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const json = async (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
    if (u.includes('/v1.0/token')) {
      return json({ success: true, result: { access_token: 'tok', expire_time: 7200, uid: 'u1' } });
    }
    if (u.includes('/v1.0/iot-01/associated-users/devices')) {
      return json({ success: true, result: { devices: opts.bulkDevices ?? [], has_more: false } });
    }
    const directMatch = /\/v1\.0\/devices\/([^/?]+)$/.exec(u);
    if (directMatch) {
      const d = opts.directDevices?.[directMatch[1]];
      return d ? json({ success: true, result: d }) : json({ success: false, code: 1, msg: 'not found' });
    }
    return json({ success: false, code: 999, msg: `unmocked url in test: ${u}` });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('isExcludedSubOrGateway: true for a gateway category (wg2) or an id cross-referenced as a sub-device, false otherwise', () => {
  const gateway = { id: 'bf-gw-pure-1', name: 'Gateway', category: 'wg2', online: true, status: [] };
  const sceneSwitch = { id: 'bf-sw-pure-1', name: 'Scene Switch', category: 'wxkg', online: true, status: [] };
  const plug = { id: 'bf-plug-pure-1', name: 'Plug', category: 'cz', online: true, status: [] };
  const subIds = new Set(['bf-sw-pure-1']);
  assert.equal(isExcludedSubOrGateway(gateway, subIds), true, 'gateway category (wg2) excluded');
  assert.equal(isExcludedSubOrGateway(sceneSwitch, subIds), true, 'cross-referenced sub-device id excluded');
  assert.equal(isExcludedSubOrGateway(plug, subIds), false);
});

test('isKnownExcludedId: true for a registry sub-device or gateway id (zero cloud calls), false for a normal or unknown id', () => {
  fs.writeFileSync(
    path.join(scratchDir, 'tuya-local.json'),
    JSON.stringify({
      devices: [
        { id: 'bf-known-sub-1', name: 'Sub', category: 'wxkg', localKey: '', lanIp: '', version: '', sub: true },
        { id: 'bf-known-gw-1', name: 'GW', category: 'wg2', localKey: '', lanIp: '', version: '', sub: false },
        { id: 'bf-known-normal-1', name: 'Normal', category: 'cz', localKey: '', lanIp: '', version: '', sub: false },
      ],
    }),
  );
  tuyaLocal.reloadRegistry();
  assert.equal(isKnownExcludedId('bf-known-sub-1'), true);
  assert.equal(isKnownExcludedId('bf-known-gw-1'), true);
  assert.equal(isKnownExcludedId('bf-known-normal-1'), false);
  assert.equal(isKnownExcludedId('bf-totally-unknown-1'), false, 'unclassifiable ids are never excluded by guess');
});

test('getDevices(): cloud path drops the gateway (wg2) + a registry-flagged sub-device, keeps a normal device (docs/51 Change 2)', async () => {
  setTuyaCreds();
  setFleetManual(false); // exercise the cloud path directly
  setLocalControl(false);
  invalidateFleet();
  fs.writeFileSync(
    path.join(scratchDir, 'tuya-local.json'),
    JSON.stringify({ devices: [{ id: 'bf-sw-drop-1', name: 'Scene Switch', category: 'wxkg', localKey: '', lanIp: '', version: '', sub: true }] }),
  );
  tuyaLocal.reloadRegistry();

  const mock = installFleetFetchMock({
    bulkDevices: [
      { id: 'bf-normal-drop-1', name: 'Plug', category: 'cz', online: true, status: [] },
      { id: 'bf-gw-drop-1', name: 'Gateway', category: 'wg2', online: true, status: [] },
      { id: 'bf-sw-drop-1', name: 'Scene Switch', category: 'wxkg', online: true, status: [] },
    ],
  });
  try {
    const ids = (await getDevices()).map((d) => d.id);
    assert.ok(ids.includes('bf-normal-drop-1'), 'an ordinary device is kept');
    assert.ok(!ids.includes('bf-gw-drop-1'), 'the gateway (wg2) is dropped');
    assert.ok(!ids.includes('bf-sw-drop-1'), 'the sub-device (cross-referenced by id) is dropped');
  } finally {
    mock.restore();
  }
});

test('getDevices(): fleetManual ON (default) + local ON — zero cloud calls, serves the LAN snapshot only (acceptance #1)', async () => {
  setTuyaCreds();
  setFleetManual(undefined); // undefined = default = ON
  setLocalControl(true);
  invalidateFleet();
  fs.writeFileSync(
    path.join(scratchDir, 'tuya-local.json'),
    JSON.stringify({
      devices: [{ id: 'bf-manual-cap-1', name: 'Manual Cap', category: 'kg', localKey: '0123456789abcdef', lanIp: '127.0.0.1', version: '3.3', sub: false }],
    }),
  );
  tuyaLocal.reloadRegistry();
  tuyaLocal.setDpMap('bf-manual-cap-1', new Map([['switch_1', 1]]));

  const mock = installFleetFetchMock({ bulkDevices: [{ id: 'bf-should-never-appear-1', name: 'X', category: 'cz', online: true, status: [] }] });
  try {
    const devices = await getDevices();
    assert.deepEqual(devices.map((d) => d.id), ['bf-manual-cap-1'], 'served from the local snapshot only');
    assert.equal(mock.calls.length, 0, 'zero cloud calls — not even a token fetch');
  } finally {
    mock.restore();
  }
});

test('getDevices(): fleetManual ON + local OFF is contradictory — falls through to the cloud path, never an empty fleet', async () => {
  setTuyaCreds();
  setFleetManual(true);
  setLocalControl(false);
  invalidateFleet();
  const mock = installFleetFetchMock({ bulkDevices: [{ id: 'bf-fallback-cloud-1', name: 'Cloud', category: 'cz', online: true, status: [] }] });
  try {
    const devices = await getDevices();
    assert.deepEqual(devices.map((d) => d.id), ['bf-fallback-cloud-1']);
    assert.ok(mock.calls.some((u) => u.includes('associated-users')), 'cloud fleet endpoint was hit');
  } finally {
    mock.restore();
  }
});

test('getDevices(): fleetManual OFF preserves the pre-docs/51 cloud-primary behaviour regardless of local (acceptance #6)', async () => {
  setTuyaCreds();
  setFleetManual(false);
  setLocalControl(true);
  invalidateFleet();
  const mock = installFleetFetchMock({ bulkDevices: [{ id: 'bf-legacy-cloud-1', name: 'Legacy', category: 'cz', online: true, status: [] }] });
  try {
    const devices = await getDevices();
    assert.deepEqual(devices.map((d) => d.id), ['bf-legacy-cloud-1']);
    assert.ok(mock.calls.some((u) => u.includes('associated-users')), 'cloud-primary path used, unaffected by local being on');
  } finally {
    mock.restore();
  }
});

test('syncFleetFromCloud(): exactly one cloud fleet refresh; newIds are cloud devices the local registry does not know yet', async () => {
  setTuyaCreds();
  setFleetManual(undefined);
  setLocalControl(true);
  invalidateFleet();
  fs.writeFileSync(
    path.join(scratchDir, 'tuya-local.json'),
    JSON.stringify({ devices: [{ id: 'bf-sync-known-1', name: 'Known', category: 'cz', localKey: '', lanIp: '', version: '', sub: false }] }),
  );
  tuyaLocal.reloadRegistry();

  const mock = installFleetFetchMock({
    bulkDevices: [
      { id: 'bf-sync-known-1', name: 'Known', category: 'cz', online: true, status: [] },
      { id: 'bf-sync-new-1', name: 'Brand New', category: 'cz', online: true, status: [] },
    ],
  });
  try {
    const result = await syncFleetFromCloud();
    assert.equal(result.devices, 2);
    assert.deepEqual(result.newIds, ['bf-sync-new-1']);
    const bulkCalls = mock.calls.filter((u) => u.includes('associated-users'));
    assert.equal(bulkCalls.length, 1, 'exactly one cloud fleet refresh');
  } finally {
    mock.restore();
  }
});
