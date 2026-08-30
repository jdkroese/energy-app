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
// isLocalEnabled() now also reads the persisted store (default-ON semantics — see
// tuya-local.ts). Point the store at a scratch file BEFORE anything imports it, so this
// suite never touches the real dev/prod state.json. Local is also hard-disabled via the env
// kill-switch so no test in here reaches the network; importing tuya-local itself is inert
// either way, since discovery is now started explicitly from index.ts rather than as an
// import side effect (see docs/53 and tuya-local-boot.test.ts). The env var is restored to
// "unset" right after that import completes; individual tests below set/restore it again to
// exercise the real on/off semantics.
process.env.STATE_FILE = path.join(scratchDir, 'state.json');
process.env.TUYA_LOCAL_ENABLED = '0';

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
    version: '3.5', // AES-GCM — tuyapi cannot speak this; the native GCM client handles it
    sub: false,
    online: true,
    productId: 'p4',
  },
  {
    id: 'bf-futurever-1',
    name: 'Test Future Version',
    category: 'tdq',
    ip: '203.0.113.12',
    localKey: 'abcdef0123456789',
    lanIp: '192.168.1.53',
    version: '9.9', // deliberately bogus — proves the fail-closed guard survives adding 3.5
    sub: false,
    online: true,
    productId: 'p5',
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
const store = await import('../store');
// Boot decision is made; restore to "unset" so the rest of the suite (and the default-ON
// test below) sees the same env shape a real deploy without the env var would.
delete process.env.TUYA_LOCAL_ENABLED;

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

test('sendCommands: a genuinely unsupported protocol version rejects — fails closed, never attempted', async () => {
  await assert.rejects(
    () => tuyaLocal.sendCommands('bf-futurever-1', [{ code: 'switch_1', value: true }]),
    /unsupported protocol version "9\.9"/,
  );
});

test('readStatus: a genuinely unsupported protocol version rejects', async () => {
  await assert.rejects(() => tuyaLocal.readStatus('bf-futurever-1'), /unsupported protocol version/);
});

// ---- Unsupported protocol version (v3.5) is a first-class, non-retrying reason ----------

test('capabilityBlockReason: a v3.5 device is natively supported — capable, not blocked', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const v35 = entries.find((e) => e.id === 'bf-v35-1')!;
  assert.equal(v35.localKey.length, 16, 'has a valid key');
  assert.ok(v35.lanIp, 'has a LAN ip');
  assert.equal(tuyaLocal.capabilityBlockReason(v35), null);
  assert.equal(tuyaLocal.computeLocalCapable(v35), true);
  assert.equal(tuyaLocal.pickLocalTransport(v35.version), 'native-gcm');
});

test('capabilityBlockReason: a genuinely unsupported (future) version still fails closed — the guard is narrowed, not removed', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const future = entries.find((e) => e.id === 'bf-futurever-1')!;
  assert.equal(future.localKey.length, 16, 'has a valid key');
  assert.ok(future.lanIp, 'has a LAN ip');
  assert.equal(tuyaLocal.capabilityBlockReason(future), 'unsupported-version');
  assert.equal(tuyaLocal.computeLocalCapable(future), false);
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

// ---- Native v3.5 (AES-GCM) transport: framing + GCM round-trip ------------------------
// All synthetic — no real device or socket anywhere below. packGcm35Frame/parseGcm35Frame/
// decryptGcm35Frame are round-tripped against each other exactly as the real connect/read/
// write path uses them (TuyaGcm35Device in tuya-local.ts), just without a socket in between.

function testLocalKey(): Buffer {
  return Buffer.from('0123456789abcdef', 'utf8'); // 16 bytes, same shape as a real local_key
}

test('packGcm35Frame/parseGcm35Frame/decryptGcm35Frame: round-trips a plaintext payload', () => {
  const key = testLocalKey();
  const plaintext = Buffer.from(JSON.stringify({ hello: 'world', n: 42 }), 'utf8');
  const framed = tuyaLocal.packGcm35Frame(7, 16, plaintext, key);

  assert.equal(framed.readUInt32BE(0), 0x00006699, 'frame starts with the v3.5 magic');
  assert.equal(framed.readUInt32BE(framed.length - 4), 0x00009966, 'frame ends with the v3.5 suffix');

  const parsed = tuyaLocal.parseGcm35Frame(framed);
  assert.ok(parsed);
  assert.equal(parsed!.seqno, 7);
  assert.equal(parsed!.cmd, 16);
  assert.equal(parsed!.consumed, framed.length);
  assert.equal(parsed!.iv.length, 12);
  assert.equal(parsed!.tag.length, 16);

  const decrypted = tuyaLocal.decryptGcm35Frame(key, parsed!);
  assert.deepEqual(decrypted, plaintext);
});

test('packGcm35Frame: uses a fresh random IV every call (never reused)', () => {
  const key = testLocalKey();
  const a = tuyaLocal.parseGcm35Frame(tuyaLocal.packGcm35Frame(1, 16, Buffer.from('{}'), key))!;
  const b = tuyaLocal.parseGcm35Frame(tuyaLocal.packGcm35Frame(2, 16, Buffer.from('{}'), key))!;
  assert.notDeepEqual(a.iv, b.iv);
});

test('parseGcm35Frame: returns null (not throw) on a short/partial buffer — streaming-safe', () => {
  const key = testLocalKey();
  const framed = tuyaLocal.packGcm35Frame(1, 16, Buffer.from('{"a":1}'), key);
  assert.equal(tuyaLocal.parseGcm35Frame(framed.subarray(0, 10)), null, 'shorter than the header');
  assert.equal(tuyaLocal.parseGcm35Frame(framed.subarray(0, framed.length - 1)), null, '1 byte short of the full frame');
});

test('parseGcm35Frame: two concatenated frames — the first parse consumes exactly one', () => {
  const key = testLocalKey();
  const first = tuyaLocal.packGcm35Frame(1, 16, Buffer.from('{"a":1}'), key);
  const second = tuyaLocal.packGcm35Frame(2, 13, Buffer.from('{"b":2}'), key);
  const both = Buffer.concat([first, second]);

  const parsed1 = tuyaLocal.parseGcm35Frame(both)!;
  assert.equal(parsed1.consumed, first.length);
  assert.equal(parsed1.seqno, 1);

  const parsed2 = tuyaLocal.parseGcm35Frame(both.subarray(parsed1.consumed))!;
  assert.equal(parsed2.seqno, 2);
  assert.equal(parsed2.cmd, 13);
});

test('parseGcm35Frame: rejects a bad prefix', () => {
  const key = testLocalKey();
  const framed = tuyaLocal.packGcm35Frame(1, 16, Buffer.from('{}'), key);
  framed.writeUInt32BE(0x000055aa, 0); // legacy 3.3/3.4 magic, not v3.5
  assert.throws(() => tuyaLocal.parseGcm35Frame(framed), /prefix/);
});

test('parseGcm35Frame: rejects a bad suffix', () => {
  const key = testLocalKey();
  const framed = tuyaLocal.packGcm35Frame(1, 16, Buffer.from('{}'), key);
  framed.writeUInt32BE(0xdeadbeef, framed.length - 4);
  assert.throws(() => tuyaLocal.parseGcm35Frame(framed), /suffix/);
});

test('decryptGcm35Frame: a tampered ciphertext byte fails GCM authentication', () => {
  const key = testLocalKey();
  const framed = tuyaLocal.packGcm35Frame(1, 16, Buffer.from('{"dps":{"1":true}}'), key);
  // Flip a bit inside the ciphertext, which starts right after the 18-byte header + 12-byte IV.
  framed[18 + 12] ^= 0xff;
  const parsed = tuyaLocal.parseGcm35Frame(framed)!;
  assert.throws(() => tuyaLocal.decryptGcm35Frame(key, parsed));
});

test('decryptGcm35Frame: the wrong key fails GCM authentication', () => {
  const framed = tuyaLocal.packGcm35Frame(1, 16, Buffer.from('{}'), testLocalKey());
  const parsed = tuyaLocal.parseGcm35Frame(framed)!;
  const wrongKey = Buffer.from('fedcba9876543210', 'utf8');
  assert.throws(() => tuyaLocal.decryptGcm35Frame(wrongKey, parsed));
});

test('decryptGcm35Frame: a tampered AAD (header) byte fails GCM authentication', () => {
  const key = testLocalKey();
  const framed = tuyaLocal.packGcm35Frame(1, 16, Buffer.from('{}'), key);
  const parsed = tuyaLocal.parseGcm35Frame(framed)!;
  const tamperedAad = Buffer.from(parsed.aad);
  tamperedAad[0] ^= 0xff;
  assert.throws(() => tuyaLocal.decryptGcm35Frame(key, { ...parsed, aad: tamperedAad }));
});

test('stripV35Retcode: drops the leading 4 bytes', () => {
  const body = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('{"dps":{}}')]);
  assert.equal(tuyaLocal.stripV35Retcode(body).toString('utf8'), '{"dps":{}}');
});

test('stripV35Retcode: a buffer shorter than 4 bytes is returned as-is, never throws', () => {
  const short = Buffer.from([1, 2]);
  assert.doesNotThrow(() => tuyaLocal.stripV35Retcode(short));
  assert.deepEqual(tuyaLocal.stripV35Retcode(short), short);
});

test('decodeGcm35Json: parses a plain JSON body', () => {
  const body = Buffer.from('{"dps":{"1":true}}', 'utf8');
  assert.deepEqual(tuyaLocal.decodeGcm35Json(body), { dps: { '1': true } });
});

test('decodeGcm35Json: strips a leading "3.5"+12-null version header before parsing', () => {
  const header = Buffer.concat([Buffer.from('3.5', 'latin1'), Buffer.alloc(12)]);
  const body = Buffer.concat([header, Buffer.from('{"ok":true}', 'utf8')]);
  assert.deepEqual(tuyaLocal.decodeGcm35Json(body), { ok: true });
});

test('decodeGcm35Json: an empty body is null (ack-only frame), not an error', () => {
  assert.equal(tuyaLocal.decodeGcm35Json(Buffer.alloc(0)), null);
});

test('decodeGcm35Json: non-JSON garbage throws (caller decides whether that is fatal)', () => {
  assert.throws(() => tuyaLocal.decodeGcm35Json(Buffer.from('not json', 'utf8')));
});

// ---- Session key negotiation state machine (messages 0x03/0x04/0x05) ------------------

test('session key handshake: a full simulated round trip agrees on the same session key from both sides', () => {
  const localKey = testLocalKey(); // the shared local_key both "us" and the simulated device hold
  const localNonce = crypto.randomBytes(16); // generated by us (the client)
  const remoteNonce = crypto.randomBytes(16); // generated by the simulated device

  assert.deepEqual(tuyaLocal.buildSessionNegStart(localNonce), localNonce, 'message 1 is just the raw nonce, no envelope');

  // What a real device sends back as SESS_KEY_NEG_RESP: its own nonce plus proof (HMAC)
  // that it holds the same local_key.
  const deviceHmacOfClientNonce = crypto.createHmac('sha256', localKey).update(localNonce).digest();
  const respPayload = Buffer.concat([remoteNonce, deviceHmacOfClientNonce]);

  const gotRemoteNonce = tuyaLocal.verifySessionNegResp(respPayload, localKey, localNonce);
  assert.deepEqual(gotRemoteNonce, remoteNonce);

  // Message 3: our proof that we derived the same thing.
  const finishPayload = tuyaLocal.buildSessionNegFinish(localKey, remoteNonce);
  const deviceExpectedFinish = crypto.createHmac('sha256', localKey).update(remoteNonce).digest();
  assert.deepEqual(finishPayload, deviceExpectedFinish);

  // Both sides derive the session key from the SAME two nonces + local_key. Simulate the
  // device side independently (mirroring tinytuya's documented formula, not calling our own
  // function twice) and confirm they agree — that agreement is the actual point of the
  // handshake.
  const clientSessionKey = tuyaLocal.deriveSessionKey35(localKey, localNonce, remoteNonce);
  const xored = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) xored[i] = localNonce[i] ^ remoteNonce[i];
  const deviceCipher = crypto.createCipheriv('aes-128-gcm', localKey, localNonce.subarray(0, 12));
  const deviceSessionKey = Buffer.concat([deviceCipher.update(xored), deviceCipher.final()]);
  assert.deepEqual(clientSessionKey, deviceSessionKey);
  assert.equal(clientSessionKey.length, 16);
});

test('verifySessionNegResp: rejects a too-short response', () => {
  const localKey = testLocalKey();
  assert.throws(() => tuyaLocal.verifySessionNegResp(Buffer.alloc(10), localKey, crypto.randomBytes(16)), /too short/);
});

test('verifySessionNegResp: rejects a wrong HMAC — wrong/rotated local_key or a foreign reply', () => {
  const localKey = testLocalKey();
  const localNonce = crypto.randomBytes(16);
  const remoteNonce = crypto.randomBytes(16);
  const wrongHmac = crypto.randomBytes(32); // not HMAC(localKey, localNonce)
  const respPayload = Buffer.concat([remoteNonce, wrongHmac]);
  assert.throws(() => tuyaLocal.verifySessionNegResp(respPayload, localKey, localNonce), /HMAC mismatch/);
});

test('deriveSessionKey35: different nonce pairs produce different session keys', () => {
  const localKey = testLocalKey();
  const a = tuyaLocal.deriveSessionKey35(localKey, Buffer.alloc(16, 1), Buffer.alloc(16, 2));
  const b = tuyaLocal.deriveSessionKey35(localKey, Buffer.alloc(16, 3), Buffer.alloc(16, 4));
  assert.equal(a.length, 16);
  assert.notDeepEqual(a, b);
});

// ---- pickLocalTransport (routing between the two supported local clients) -------------

test('pickLocalTransport: 3.3/3.4/unknown route to tuyapi, 3.5 routes to the native GCM client', () => {
  assert.equal(tuyaLocal.pickLocalTransport('3.3'), 'tuyapi');
  assert.equal(tuyaLocal.pickLocalTransport('3.4'), 'tuyapi');
  assert.equal(tuyaLocal.pickLocalTransport(''), 'tuyapi');
  assert.equal(tuyaLocal.pickLocalTransport('3.5'), 'native-gcm');
});

// ---- Diagnostics (never exposes local_key) ---------------------------------------------

test('getDiagnostics: reports totals + per-device capability without ever including local_key', () => {
  const diag = tuyaLocal.getDiagnostics();
  assert.equal(diag.totals.devices, FIXTURE_DEVICES.length);
  assert.equal(diag.totals.capable, 2, 'bf-switch-1 (tuyapi) and bf-v35-1 (native-gcm) are both locally capable');
  assert.equal(diag.totals.unsupportedVersion, 1, 'only the genuinely-unsupported future version is counted here now');

  const json = JSON.stringify(diag);
  assert.doesNotMatch(json, /abcdef0123456789/, 'the local_key value must never appear in diagnostics output');
  assert.ok(!json.includes('localKey'), 'the localKey field name must never appear in diagnostics output');

  const sw = diag.devices.find((d) => d.id === 'bf-switch-1');
  assert.ok(sw);
  assert.equal(sw.localCapable, true);
  assert.equal(sw.reason, null);
  assert.equal(sw.lanIp, '192.168.1.50');
  assert.equal(sw.transport, 'tuyapi');

  const sub = diag.devices.find((d) => d.id === 'bf-sub-1');
  assert.ok(sub);
  assert.equal(sub.localCapable, false);
  assert.equal(sub.reason, 'gateway-sub-device');
  assert.equal(sub.transport, null, 'not locally capable at all — no transport applies');

  const nokey = diag.devices.find((d) => d.id === 'bf-nokey-1');
  assert.ok(nokey);
  assert.equal(nokey.reason, 'no-key');

  const v35 = diag.devices.find((d) => d.id === 'bf-v35-1');
  assert.ok(v35);
  assert.equal(v35.localCapable, true, 'v3.5 is natively supported now, not blocked');
  assert.equal(v35.reason, null);
  assert.equal(v35.version, '3.5');
  assert.equal(v35.transport, 'native-gcm');

  const future = diag.devices.find((d) => d.id === 'bf-futurever-1');
  assert.ok(future);
  assert.equal(future.localCapable, false);
  assert.equal(future.reason, 'unsupported-version', 'a genuinely unsupported version still reads as a distinct, explicit reason');
  assert.equal(future.transport, null);
});

test('getDiagnostics: v35SightingsUncorrelated omits ips that already match a known device', () => {
  // No live sightings were fed in during this test run (no real UDP), so the list is empty
  // — this just proves the field exists and is well-formed, not a false positive.
  const diag = tuyaLocal.getDiagnostics();
  assert.deepEqual(diag.v35SightingsUncorrelated, []);
});

// ---- isLocalEnabled: default-ON semantics + the store-backed reversible toggle ---------
// docs/44 Phase 2 is hardware-verified, so local is now enabled by DEFAULT: the store
// setting (Settings → Tuya → "Local LAN control") is the normal on/off switch, since the
// production mini's launchd plist can't be edited remotely. TUYA_LOCAL_ENABLED remains a
// hard override on top: '0' always wins (kill switch), '1' always wins (force-on); any
// other/unset value defers to the store. Every case here saves/restores the env var and
// resets the store's tuya.localControl afterward so it can't leak into other tests.

function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.TUYA_LOCAL_ENABLED;
  if (value === undefined) delete process.env.TUYA_LOCAL_ENABLED;
  else process.env.TUYA_LOCAL_ENABLED = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.TUYA_LOCAL_ENABLED;
    else process.env.TUYA_LOCAL_ENABLED = prev;
  }
}

function setStoreLocalControl(value: boolean | undefined): void {
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.tuya = { ...(s.integrations.tuya ?? {}), localControl: value };
  });
}

test('isLocalEnabled: TUYA_LOCAL_ENABLED=0 is a hard kill switch, even if the store says on', () => {
  setStoreLocalControl(true);
  withEnv('0', () => {
    assert.equal(tuyaLocal.isLocalEnabled(), false);
  });
  setStoreLocalControl(undefined);
});

test('isLocalEnabled: TUYA_LOCAL_ENABLED=1 forces on, even if the store says off', () => {
  setStoreLocalControl(false);
  withEnv('1', () => {
    assert.equal(tuyaLocal.isLocalEnabled(), true);
  });
  setStoreLocalControl(undefined);
});

test('isLocalEnabled: env unset + no store setting yet defaults ON', () => {
  setStoreLocalControl(undefined);
  withEnv(undefined, () => {
    assert.equal(tuyaLocal.isLocalEnabled(), true);
  });
});

test('isLocalEnabled: env unset + store localControl=true is ON', () => {
  setStoreLocalControl(true);
  withEnv(undefined, () => {
    assert.equal(tuyaLocal.isLocalEnabled(), true);
  });
  setStoreLocalControl(undefined);
});

test('isLocalEnabled: env unset + store localControl=false is OFF — the reversible toggle', () => {
  setStoreLocalControl(false);
  withEnv(undefined, () => {
    assert.equal(tuyaLocal.isLocalEnabled(), false);
  });
  setStoreLocalControl(undefined);
});

// ---- listRegistry ----------------------------------------------------------------------

test('listRegistry: snapshots every loaded entry (server-internal only — carries localKey)', () => {
  const all = tuyaLocal.listRegistry();
  assert.equal(all.length, FIXTURE_DEVICES.length);
  assert.ok(all.some((e) => e.id === 'bf-switch-1'));
});

// ---- Persisted dp-map (docs/49 Change 1) ------------------------------------------------
// `getDpMap`/`setDpMap` operate on the SAME module-level registry the rest of this suite
// boots from (loaded once at import from the fixture file above) — tests below pick ids not
// asserted on by earlier sections so mutating their dpMap here can't affect those.

test('parseDpMap: an object of string->finite-number round-trips through loadRegistryFromFile', () => {
  const file = path.join(scratchDir, 'dpmap-good.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ devices: [{ id: 'bf-dpmap-1', dpMap: { switch_1: 1, cur_power: 19 } }] }),
  );
  const entries = tuyaLocal.loadRegistryFromFile(file);
  assert.deepEqual(entries[0].dpMap, { switch_1: 1, cur_power: 19 });
});

test('parseDpMap: numeric-string values coerce to numbers; non-finite entries are dropped, never throw', () => {
  const file = path.join(scratchDir, 'dpmap-mixed.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      devices: [
        { id: 'bf-dpmap-2', dpMap: { switch_1: '1', cur_power: 19, bad: 'not-a-number', worse: null } },
      ],
    }),
  );
  const entries = tuyaLocal.loadRegistryFromFile(file);
  assert.deepEqual(entries[0].dpMap, { switch_1: 1, cur_power: 19 });
});

test('parseDpMap: missing/malformed dpMap (absent, array, string, empty object) all degrade to undefined', () => {
  const file = path.join(scratchDir, 'dpmap-bad.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      devices: [
        { id: 'bf-dpmap-none' }, // absent entirely
        { id: 'bf-dpmap-arr', dpMap: [1, 2, 3] },
        { id: 'bf-dpmap-str', dpMap: 'nope' },
        { id: 'bf-dpmap-empty', dpMap: {} },
        { id: 'bf-dpmap-allbad', dpMap: { a: 'x', b: null } },
      ],
    }),
  );
  const entries = tuyaLocal.loadRegistryFromFile(file);
  for (const e of entries) assert.equal(e.dpMap, undefined, `${e.id} should have no dpMap`);
});

test('getDpMap: null when nothing has been captured for a known device', () => {
  const entries = tuyaLocal.loadRegistryFromFile(path.join(scratchDir, 'tuya-local.json'));
  const sw = entries.find((e) => e.id === 'bf-nokey-1')!;
  assert.equal(sw.dpMap, undefined, 'the fixture file itself carries no dpMap');
  assert.equal(tuyaLocal.getDpMap('bf-nokey-1'), null);
});

test('getDpMap: null for an unknown device id', () => {
  assert.equal(tuyaLocal.getDpMap('no-such-device-at-all'), null);
});

test('setDpMap/getDpMap: round-trips a code->dp map in both directions', () => {
  const codeToDp = new Map([['switch_1', 1], ['cur_power', 19]]);
  tuyaLocal.setDpMap('bf-switch-1', codeToDp);
  const got = tuyaLocal.getDpMap('bf-switch-1');
  assert.ok(got);
  assert.equal(got!.codeToDp.get('switch_1'), 1);
  assert.equal(got!.codeToDp.get('cur_power'), 19);
  assert.equal(got!.dpToCode.get(1), 'switch_1');
  assert.equal(got!.dpToCode.get(19), 'cur_power');
});

test('setDpMap: a no-op on an unknown device id (never throws, never grows the registry)', () => {
  const before = tuyaLocal.listRegistry().length;
  assert.doesNotThrow(() => tuyaLocal.setDpMap('totally-unknown-device', new Map([['switch_1', 1]])));
  assert.equal(tuyaLocal.listRegistry().length, before);
  assert.equal(tuyaLocal.getDpMap('totally-unknown-device'), null);
});

test('setDpMap: an empty map is a no-op — never wipes a previously-captured dpMap', () => {
  tuyaLocal.setDpMap('bf-futurever-1', new Map([['switch_1', 1]]));
  assert.ok(tuyaLocal.getDpMap('bf-futurever-1'));
  tuyaLocal.setDpMap('bf-futurever-1', new Map());
  const got = tuyaLocal.getDpMap('bf-futurever-1');
  assert.ok(got, 'the previously-set map must still be there — an empty map never overwrites it');
  assert.equal(got!.codeToDp.get('switch_1'), 1);
});

test('getDiagnostics: dpMapCaptured/dpMapsCaptured reflect setDpMap without ever leaking the map contents', () => {
  tuyaLocal.setDpMap('bf-v35-1', new Map([['switch_1', 1]]));
  const diag = tuyaLocal.getDiagnostics();
  const v35 = diag.devices.find((d) => d.id === 'bf-v35-1');
  assert.ok(v35);
  assert.equal(v35!.dpMapCaptured, true);
  assert.ok(diag.totals.dpMapsCaptured >= 1);
  const json = JSON.stringify(diag);
  assert.ok(!json.includes('switch_1'), 'dp-map contents (cloud codes) must never appear in diagnostics output');
});
