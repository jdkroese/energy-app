// Unit tests for the Tuya LOCAL (LAN) transport (docs/44 Phase 2). Run with the Node
// built-in test runner via tsx, from apps/api:
//   node --import tsx --test src/connectors/tuya-local.test.ts
// (apps/api has no formal test-runner script; tsx is a devDependency.)
//
// No real hardware is used anywhere here. Coverage:
//   - the UDP discovery frame parser, against synthetic packets built the same way the
//     real devices' broadcasts are shaped (plaintext JSON, and AES-128-ECB at both header
//     offsets tuya-lan-discover.mjs found in the wild);
//   - registry load (tolerant of a missing/malformed file) and the live-discovery merge;
//   - sub-device exclusion (Zigbee/BLE devices behind a gateway are never "local capable");
//   - the local-fails-falls-back-to-cloud decision boundary: sendCommands/readStatus reject
//     cleanly (before any network I/O) for every reason tuya.ts's sendCommandsDual is
//     relying on to trigger its cloud fallback — unknown device, sub-device, missing
//     key/ip, an untranslatable command code, and an active cool-off.
//
// tuya-local.ts reads DATA_DIR once at import time and loads its registry synchronously as
// part of module init, so the scratch DATA_DIR + fixture file are set up BEFORE the module
// is imported (a dynamic import, after the env var is set, is what makes that orderable).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuya-local-test-'));
process.env.DATA_DIR = scratchDir;

const FIXTURE_DEVICES = [
  {
    id: 'bf-switch-1',
    name: 'Test Switch',
    category: 'kg',
    ip: '203.0.113.9', // WAN — must never be used to connect
    localKey: 'abcdef0123456789', // 16 chars
    lanIp: '192.168.1.50',
    version: '3.3',
    sub: false,
    online: true,
    productId: 'p1',
  },
  {
    id: 'bf-sub-1',
    name: 'Test Scene Button',
    category: 'wxkg',
    ip: '',
    localKey: 'abcdef0123456789',
    lanIp: '', // sub-devices never get a LAN ip
    version: '',
    sub: true, // Zigbee/BLE behind a gateway — never LAN reachable
    online: true,
    productId: 'p2',
  },
  {
    id: 'bf-nokey-1',
    name: 'Test No Key',
    category: 'cz',
    ip: '203.0.113.10',
    localKey: '',
    lanIp: '192.168.1.51',
    version: '3.4',
    sub: false,
    online: true,
    productId: 'p3',
  },
  {
    id: 'bf-v35-1',
    name: 'CB Test Breaker',
    category: 'tdq',
    ip: '203.0.113.11',
    localKey: 'abcdef0123456789',
    lanIp: '192.168.1.52',
    version: '3.5', // AES-GCM — tuyapi cannot speak this; must fail closed to cloud
    sub: false,
    online: true,
    productId: 'p4',
  },
];
fs.writeFileSync(
  path.join(scratchDir, 'tuya-local.json'),
  JSON.stringify(
    { harvestedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(), devices: FIXTURE_DEVICES },
    null,
    2,
  ),
);

const tuyaLocal = await import('./tuya-local');

// ---- Discovery frame parser --------------------------------------------------------

const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

function plaintextFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.from([0x00, 0x00, 0x55, 0xaa, 0, 0, 0, 0]);
  const trailer = Buffer.from([0, 0, 0, 0]);
  return Buffer.concat([header, json, trailer]);
}

function encryptedFrame(payload: unknown, headerLen: 16 | 20): Buffer {
  const json = JSON.stringify(payload);
  const cipher = crypto.createCipheriv('aes-128-ecb', UDP_KEY, null);
  const body = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const header = Buffer.alloc(headerLen, 0);
  const trailer = Buffer.alloc(8, 0);
  return Buffer.concat([header, body, trailer]);
}

test('parseDiscoveryFrame: plaintext JSON broadcast (older v3.1 on 6666)', () => {
  const buf = plaintextFrame({ gwId: 'dev-plain-1', ip: '192.168.1.60', version: '3.1' });
  const info = tuyaLocal.parseDiscoveryFrame(buf);
  assert.deepEqual(info, { id: 'dev-plain-1', ip: '192.168.1.60', version: '3.1' });
});

test('parseDiscoveryFrame: falls back to devId when gwId is absent', () => {
  const buf = plaintextFrame({ devId: 'dev-plain-2', ip: '192.168.1.61', version: '3.1' });
  const info = tuyaLocal.parseDiscoveryFrame(buf);
  assert.equal(info?.id, 'dev-plain-2');
});

test('parseDiscoveryFrame: AES-128-ECB at offset 20 (frame carries a return code)', () => {
  const buf = encryptedFrame({ gwId: 'dev-enc-20', ip: '192.168.1.62', version: '3.3' }, 20);
  const info = tuyaLocal.parseDiscoveryFrame(buf);
  assert.deepEqual(info, { id: 'dev-enc-20', ip: '192.168.1.62', version: '3.3' });
});

test('parseDiscoveryFrame: AES-128-ECB at offset 16 (no return code)', () => {
  const buf = encryptedFrame({ gwId: 'dev-enc-16', ip: '192.168.1.63', version: '3.4' }, 16);
  const info = tuyaLocal.parseDiscoveryFrame(buf);
  assert.deepEqual(info, { id: 'dev-enc-16', ip: '192.168.1.63', version: '3.4' });
});

test('parseDiscoveryFrame: garbage buffer is rejected, not thrown', () => {
  const buf = crypto.randomBytes(40);
  assert.doesNotThrow(() => tuyaLocal.parseDiscoveryFrame(buf));
});

test('parseDiscoveryFrame: valid JSON with neither gwId nor devId returns null', () => {
  const buf = plaintextFrame({ ip: '192.168.1.64', version: '3.3' });
  assert.equal(tuyaLocal.parseDiscoveryFrame(buf), null);
});

// ---- Registry load ------------------------------------------------------------------

test('loadRegistryFromFile: a missing file degrades to an empty registry', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'does-not-exist.json'));
  assert.deepEqual(entries, []);
});

test('loadRegistryFromFile: malformed JSON degrades to an empty registry', () => {
  const file = path.join(scratchDir, 'malformed.json');
  fs.writeFileSync(file, '{ not valid json');
  assert.deepEqual(tuyaLocal.loadRegistryFromFile(file), []);
});

test('loadRegistryFromFile: a devices field that is not an array degrades to empty', () => {
  const file = path.join(scratchDir, 'bad-shape.json');
  fs.writeFileSync(file, JSON.stringify({ devices: 'oops' }));
  assert.deepEqual(tuyaLocal.loadRegistryFromFile(file), []);
});

test('loadRegistryFromFile: entries without an id are skipped; others get field defaults', () => {
  const file = path.join(scratchDir, 'partial.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      devices: [
        { name: 'no id here', localKey: 'x' }, // skipped — no id
        { id: 'bf-minimal' }, // only id — everything else defaults
        { id: 'bf-numeric-version', version: 3.4, sub: true }, // numeric version coerced to string
      ],
    }),
  );
  const entries = tuyaLocal.loadRegistryFromFile(file);
  assert.equal(entries.length, 2);

  const minimal = entries.find((e) => e.id === 'bf-minimal');
  assert.ok(minimal);
  assert.equal(minimal.name, 'bf-minimal', 'name falls back to id when absent');
  assert.equal(minimal.lanIp, '');
  assert.equal(minimal.localKey, '');
  assert.equal(minimal.sub, false);
  assert.equal(minimal.online, false);

  const numeric = entries.find((e) => e.id === 'bf-numeric-version');
  assert.ok(numeric);
  assert.equal(numeric.version, '3.4', 'a numeric version in the file is coerced to a string');
  assert.equal(numeric.sub, true);
});

test('loadRegistryFromFile: the real fixture used to boot the module round-trips cleanly', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  assert.equal(entries.length, FIXTURE_DEVICES.length);
  const sw = entries.find((e) => e.id === 'bf-switch-1');
  assert.ok(sw);
  assert.equal(sw.lanIp, '192.168.1.50');
  assert.equal(sw.wanIp, '203.0.113.9', 'the cloud WAN ip is captured separately from lanIp');
});

// ---- Sub-device exclusion / local capability -----------------------------------------

test('computeLocalCapable: a fully-populated Wi-Fi device is capable', () => {
  const entry = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'))[0];
  assert.equal(tuyaLocal.computeLocalCapable(entry), true);
});

test('computeLocalCapable: a Zigbee/BLE gateway sub-device is NEVER capable, even with a key + ip', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sub = entries.find((e) => e.id === 'bf-sub-1')!;
  // Prove exclusion is driven by `sub`, not by the (missing) lanIp: give it everything else.
  const wouldOtherwiseQualify = { ...sub, lanIp: '192.168.1.99' };
  assert.equal(wouldOtherwiseQualify.sub, true);
  assert.equal(tuyaLocal.computeLocalCapable(wouldOtherwiseQualify), false);
});

test('computeLocalCapable: missing/short local_key is not capable', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const nokey = entries.find((e) => e.id === 'bf-nokey-1')!;
  assert.equal(tuyaLocal.computeLocalCapable(nokey), false);
  assert.equal(tuyaLocal.computeLocalCapable({ ...nokey, localKey: 'tooshort' }), false, 'a key that is not 16 chars is rejected too');
});

test('computeLocalCapable: no LAN ip discovered yet is not capable', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sw = entries.find((e) => e.id === 'bf-switch-1')!;
  assert.equal(tuyaLocal.computeLocalCapable({ ...sw, lanIp: '' }), false);
});

test('computeLocalCapable: an unknown (undefined) entry is not capable', () => {
  assert.equal(tuyaLocal.computeLocalCapable(undefined), false);
});

// ---- Health / cooldown ----------------------------------------------------------------

test('computeCanAttempt: no health record yet — always allowed', () => {
  assert.equal(tuyaLocal.computeCanAttempt(undefined), true);
});

test('computeCanAttempt: failures below the threshold are still allowed', () => {
  const h = { consecutiveFailures: 2, lastOkAt: null, lastFailAt: Date.now(), lastError: 'x' };
  assert.equal(tuyaLocal.computeCanAttempt(h), true);
});

test('computeCanAttempt: at the threshold and inside the cooldown window is blocked', () => {
  const now = 1_000_000_000;
  const h = { consecutiveFailures: 3, lastOkAt: null, lastFailAt: now - 1000, lastError: 'x' };
  assert.equal(tuyaLocal.computeCanAttempt(h, now), false);
});

test('computeCanAttempt: at the threshold but past the cooldown window is allowed again', () => {
  const now = 1_000_000_000;
  const h = { consecutiveFailures: 5, lastOkAt: null, lastFailAt: now - 6 * 60_000, lastError: 'x' };
  assert.equal(tuyaLocal.computeCanAttempt(h, now), true);
});

// ---- localAttemptBlockedReason (the decision tuya.ts's fallback relies on) -----------

test('localAttemptBlockedReason: undefined entry -> "unknown device"', () => {
  assert.match(tuyaLocal.localAttemptBlockedReason(undefined, undefined) ?? '', /unknown device/);
});

test('localAttemptBlockedReason: sub-device is blocked even with key+ip', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sub = { ...entries.find((e) => e.id === 'bf-sub-1')!, lanIp: '192.168.1.99' };
  assert.match(tuyaLocal.localAttemptBlockedReason(sub, undefined) ?? '', /sub-device/);
});

test('localAttemptBlockedReason: missing key is blocked', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const nokey = entries.find((e) => e.id === 'bf-nokey-1')!;
  assert.match(tuyaLocal.localAttemptBlockedReason(nokey, undefined) ?? '', /local_key/);
});

test('localAttemptBlockedReason: missing lanIp is blocked', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sw = { ...entries.find((e) => e.id === 'bf-switch-1')!, lanIp: '' };
  assert.match(tuyaLocal.localAttemptBlockedReason(sw, undefined) ?? '', /LAN ip/);
});

test('localAttemptBlockedReason: an active cooldown is blocked', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sw = entries.find((e) => e.id === 'bf-switch-1')!;
  const now = 2_000_000_000;
  const h = { consecutiveFailures: 4, lastOkAt: null, lastFailAt: now - 1000, lastError: 'boom' };
  assert.match(tuyaLocal.localAttemptBlockedReason(sw, h, now) ?? '', /cooldown/);
});

test('localAttemptBlockedReason: a fully healthy, capable device is NOT blocked', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sw = entries.find((e) => e.id === 'bf-switch-1')!;
  assert.equal(tuyaLocal.localAttemptBlockedReason(sw, undefined), null);
});

// ---- DP <-> cloud code translation ------------------------------------------------------

test('translateCommands: maps cloud codes to local dp indices', () => {
  const dpForCode = new Map([['switch_1', 1], ['countdown_1', 9]]);
  const data = tuyaLocal.translateCommands(
    [{ code: 'switch_1', value: true }, { code: 'countdown_1', value: 0 }],
    dpForCode,
  );
  assert.deepEqual(data, { '1': true, '9': 0 });
});

test('translateCommands: an unmapped code throws BEFORE any network I/O — this is the fallback trigger', () => {
  const dpForCode = new Map([['switch_1', 1]]);
  assert.throws(
    () => tuyaLocal.translateCommands([{ code: 'switch_1', value: true }, { code: 'mystery_dp', value: 1 }], dpForCode),
    /mystery_dp/,
  );
});

test('translateStatus: maps known dps to codes and drops unmapped ones (status is sparse by nature)', () => {
  const codeForDp = new Map([[1, 'switch_1'], [20, 'cur_power']]);
  const items = tuyaLocal.translateStatus({ '1': true, '20': 3940, '101': 'vendor-extension' }, codeForDp);
  assert.deepEqual(items, [
    { code: 'switch_1', value: true },
    { code: 'cur_power', value: 3940 },
  ]);
});

test('translateStatus: a non-numeric dp key is dropped, not thrown', () => {
  const codeForDp = new Map([[1, 'switch_1']]);
  assert.doesNotThrow(() => tuyaLocal.translateStatus({ weird: true }, codeForDp));
  assert.deepEqual(tuyaLocal.translateStatus({ weird: true }, codeForDp), []);
});

// ---- mergeDiscoveryInfo (registry merge from live UDP discovery) ----------------------

test('mergeDiscoveryInfo: a fresh ip updates the entry and reports changed', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sw = entries.find((e) => e.id === 'bf-switch-1')!;
  const { entry, changed } = tuyaLocal.mergeDiscoveryInfo(sw, { id: sw.id, ip: '192.168.1.77', version: '3.3' });
  assert.equal(changed, true);
  assert.equal(entry.lanIp, '192.168.1.77');
  assert.notEqual(entry, sw, 'a changed merge returns a new object, never mutates the input');
});

test('mergeDiscoveryInfo: the same ip/version reports unchanged and returns the same entry', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sw = entries.find((e) => e.id === 'bf-switch-1')!;
  const { entry, changed } = tuyaLocal.mergeDiscoveryInfo(sw, { id: sw.id, ip: sw.lanIp, version: sw.version });
  assert.equal(changed, false);
  assert.equal(entry, sw);
});

test('mergeDiscoveryInfo: a broadcast missing ip/version never blanks out a value already known (AP-isolation tolerant)', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sw = entries.find((e) => e.id === 'bf-switch-1')!;
  const { entry, changed } = tuyaLocal.mergeDiscoveryInfo(sw, { id: sw.id, ip: '', version: '' });
  assert.equal(changed, false);
  assert.equal(entry.lanIp, sw.lanIp);
  assert.equal(entry.version, sw.version);
});

// ---- sendCommands / readStatus: the local-fails-falls-back-to-cloud decision ----------
// Every case below rejects during the synchronous preflight/translation stage, strictly
// before getConnection() would open a socket — no real hardware or network I/O involved.
// This is exactly the boundary tuya.ts's sendCommandsDual/getStatus catch() to fall back
// to the (unchanged) cloud path.

test('sendCommands: an unknown device id rejects ("unknown device")', async () => {
  await assert.rejects(() => tuyaLocal.sendCommands('no-such-device', [{ code: 'switch_1', value: true }]), /unknown device/);
});

test('readStatus: an unknown device id rejects ("unknown device")', async () => {
  await assert.rejects(() => tuyaLocal.readStatus('no-such-device'), /unknown device/);
});

test('sendCommands: a gateway sub-device rejects, never attempting a connection', async () => {
  await assert.rejects(
    () => tuyaLocal.sendCommands('bf-sub-1', [{ code: 'switch_1', value: true }]),
    /sub-device/,
  );
});

test('sendCommands: a device with no local_key rejects', async () => {
  await assert.rejects(() => tuyaLocal.sendCommands('bf-nokey-1', [{ code: 'switch_1', value: true }]), /local_key/);
});

test('sendCommands: a capable device with an unmapped command code rejects (empty dpForCode default)', async () => {
  // No dpForCode passed at all — sendCommands defaults to an empty map, so translation
  // fails closed exactly as it would if tuya.ts's cloud specification lookup failed.
  await assert.rejects(
    () => tuyaLocal.sendCommands('bf-switch-1', [{ code: 'switch_1', value: true }]),
    /no local datapoint mapping/,
  );
});

test('sendCommands: no commands to send rejects', async () => {
  await assert.rejects(() => tuyaLocal.sendCommands('bf-switch-1', []), /no commands/);
});

test('sendCommands: an unsupported protocol version (v3.5) rejects — fails closed, never attempted', async () => {
  await assert.rejects(
    () => tuyaLocal.sendCommands('bf-v35-1', [{ code: 'switch_1', value: true }]),
    /unsupported protocol version "3\.5"/,
  );
});

test('readStatus: an unsupported protocol version (v3.5) rejects', async () => {
  await assert.rejects(() => tuyaLocal.readStatus('bf-v35-1'), /unsupported protocol version/);
});

// ---- Unsupported protocol version (v3.5) is a first-class, non-retrying reason ----------

test('capabilityBlockReason: a v3.5 device is blocked as "unsupported-version", not treated as offline/missing', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const v35 = entries.find((e) => e.id === 'bf-v35-1')!;
  assert.equal(v35.localKey.length, 16, 'has a valid key');
  assert.ok(v35.lanIp, 'has a LAN ip');
  assert.equal(tuyaLocal.capabilityBlockReason(v35), 'unsupported-version');
  assert.equal(tuyaLocal.computeLocalCapable(v35), false);
});

test('capabilityBlockReason: an entry with NO version yet recorded is not treated as unsupported (falls back to 3.3)', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sw = { ...entries.find((e) => e.id === 'bf-switch-1')!, version: '' };
  assert.equal(tuyaLocal.capabilityBlockReason(sw), null);
});

test('isV35DiscoveryFrame: recognizes the v3.5 magic (0x00006699) and rejects everything else', () => {
  const v35 = Buffer.alloc(24);
  v35.writeUInt32BE(0x00006699, 0);
  assert.equal(tuyaLocal.isV35DiscoveryFrame(v35), true);

  const legacy = Buffer.alloc(24);
  legacy.writeUInt32BE(0x000055aa, 0);
  assert.equal(tuyaLocal.isV35DiscoveryFrame(legacy), false);

  assert.equal(tuyaLocal.isV35DiscoveryFrame(Buffer.alloc(2)), false, 'too short to hold a magic — never throws');
});

test('correlateV35Sighting: tags the matching-lanIp entry as v3.5, leaves others untouched', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sw = entries.find((e) => e.id === 'bf-switch-1')!; // version '3.3', lanIp 192.168.1.50
  const updated = tuyaLocal.correlateV35Sighting(entries, sw.lanIp);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, 'bf-switch-1');
  assert.equal(updated[0].version, '3.5');
  assert.equal(sw.version, '3.3', 'the input entry is never mutated');
});

test('correlateV35Sighting: an ip matching no known device correlates to nothing', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  assert.deepEqual(tuyaLocal.correlateV35Sighting(entries, '192.168.1.250'), []);
});

test('correlateV35Sighting: an entry already known as v3.5 is not re-flagged (idempotent)', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const v35 = entries.find((e) => e.id === 'bf-v35-1')!;
  assert.deepEqual(tuyaLocal.correlateV35Sighting(entries, v35.lanIp), []);
});

// ---- Diagnostics (never exposes local_key) ---------------------------------------------

test('getDiagnostics: reports totals + per-device capability without ever including local_key', () => {
  const diag = tuyaLocal.getDiagnostics();
  assert.equal(diag.totals.devices, FIXTURE_DEVICES.length);
  assert.equal(diag.totals.capable, 1, 'only bf-switch-1 has key+ip, is not a sub-device, and is a supported version');
  assert.equal(diag.totals.unsupportedVersion, 1, 'bf-v35-1 is counted separately from "capable"');

  const json = JSON.stringify(diag);
  assert.doesNotMatch(json, /abcdef0123456789/, 'the local_key value must never appear in diagnostics output');
  assert.ok(!json.includes('localKey'), 'the localKey field name must never appear in diagnostics output');

  const sw = diag.devices.find((d) => d.id === 'bf-switch-1');
  assert.ok(sw);
  assert.equal(sw.localCapable, true);
  assert.equal(sw.reason, null);
  assert.equal(sw.lanIp, '192.168.1.50');

  const sub = diag.devices.find((d) => d.id === 'bf-sub-1');
  assert.ok(sub);
  assert.equal(sub.localCapable, false);
  assert.equal(sub.reason, 'gateway-sub-device');

  const nokey = diag.devices.find((d) => d.id === 'bf-nokey-1');
  assert.ok(nokey);
  assert.equal(nokey.reason, 'no-key');

  const v35 = diag.devices.find((d) => d.id === 'bf-v35-1');
  assert.ok(v35);
  assert.equal(v35.localCapable, false);
  assert.equal(v35.reason, 'unsupported-version', 'a v3.5 device reads as a distinct, explicit reason — not just "not capable"');
  assert.equal(v35.version, '3.5');
});

test('getDiagnostics: v35SightingsUncorrelated omits ips that already match a known device', () => {
  // No live sightings were fed in during this test run (no real UDP), so the list is empty
  // — this just proves the field exists and is well-formed, not a false positive.
  const diag = tuyaLocal.getDiagnostics();
  assert.deepEqual(diag.v35SightingsUncorrelated, []);
});

test('isLocalEnabled: default (no TUYA_LOCAL_ENABLED env) is OFF', () => {
  assert.equal(tuyaLocal.isLocalEnabled(), false);
});
