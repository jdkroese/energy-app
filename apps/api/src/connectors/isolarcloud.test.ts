// Unit tests for the iSolarCloud connector's request signing + parsing (docs/44,
// Phase B). Uses a MOCK fetch + a locally-generated RSA keypair so nothing hits the
// network. Run with:
//   node --import tsx --test src/connectors/isolarcloud.test.ts
// (Node built-in runner via tsx, NOT vitest.)
//
// NOTE: this verifies OUR client behaviour (AES roundtrip, RSA-wrapping the AES key,
// header shape, result_code handling, real-time parsing). The live handshake against
// the real OpenAPI is still PENDING the owner's key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';

import {
  aesEncrypt,
  aesDecrypt,
  rsaEncryptKey,
  publicKeyFromField,
  buildSignedRequest,
  signedPost,
  parseRealTimeData,
  setFetchForTest,
  randomAesKey,
  diagnose,
  resetTokenForTest,
  resetPsKeysCacheForTest,
  discoverPsKeys,
} from './isolarcloud';
import type { IsolarcloudConfig } from '../runtime-config';

// A throwaway RSA keypair; we hand the connector the SPKI-DER public key (base64),
// exactly the shape iSolarCloud issues, and decrypt with the private key in the mock.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubDerB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const CFG: IsolarcloudConfig = {
  appkey: 'APPKEY123',
  accessKey: 'ACCESSKEY456',
  rsaPublicKey: pubDerB64,
  account: 'owner@example.com',
  password: 'secret',
  region: 'gateway.isolarcloud.eu',
};

/** Recover the per-request AES key the client wrapped for the server. */
function unwrapAesKey(xRandomSecretKey: string): string {
  const enc = Buffer.from(xRandomSecretKey, 'base64url');
  const dec = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, enc);
  return dec.toString('utf8');
}

// ---- AES roundtrip ----------------------------------------------------------

test('AES-128-ECB/PKCS7 encrypt→decrypt roundtrips', () => {
  const key = randomAesKey();
  const plain = JSON.stringify({ hello: 'world', n: 42 });
  const hex = aesEncrypt(plain, key);
  assert.match(hex, /^[0-9A-F]+$/); // hex uppercase
  assert.equal(aesDecrypt(hex, key), plain);
});

// ---- RSA wrap of the AES key ------------------------------------------------

test('rsaEncryptKey produces a value the matching private key can recover', () => {
  const key = randomAesKey();
  const wrapped = rsaEncryptKey(key, pubDerB64);
  assert.equal(unwrapAesKey(wrapped), key);
});

// ---- FIX 4: RSA key field accepts BOTH bare base64 DER and full PEM armor ----

const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString(); // -----BEGIN PUBLIC KEY-----

test('publicKeyFromField accepts a bare base64 SPKI-DER body', () => {
  const ko = publicKeyFromField(pubDerB64);
  assert.equal(ko.type, 'public');
});

test('publicKeyFromField accepts a full PEM block (----BEGIN PUBLIC KEY----- armor)', () => {
  const ko = publicKeyFromField(pubPem);
  assert.equal(ko.type, 'public');
});

test('rsaEncryptKey works with a full PEM-armored key (owner paste) — wraps recoverably', () => {
  const key = randomAesKey();
  const wrapped = rsaEncryptKey(key, pubPem);
  assert.equal(unwrapAesKey(wrapped), key);
});

test('publicKeyFromField tolerates surrounding whitespace/newlines on the bare body', () => {
  const messy = `  ${pubDerB64.slice(0, 40)}\n${pubDerB64.slice(40)}  \n`;
  const ko = publicKeyFromField(messy);
  assert.equal(ko.type, 'public');
});

// ---- buildSignedRequest headers + body -------------------------------------

test('buildSignedRequest sets the required headers and an AES-encrypted body', () => {
  const { headers, body, aesKey } = buildSignedRequest(CFG, { appkey: CFG.appkey, foo: 'bar' }, 'TOKEN99');
  assert.equal(headers['x-access-key'], 'ACCESSKEY456');
  assert.equal(headers['sys_code'], '901');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['token'], 'TOKEN99');
  // The wrapped key in the header must recover to the same AES key used for the body.
  assert.equal(unwrapAesKey(headers['x-random-secret-key']), aesKey);
  // And the body decrypts (with that key) back to our JSON.
  const decoded = JSON.parse(aesDecrypt(body, aesKey));
  assert.equal(decoded.appkey, 'APPKEY123');
  assert.equal(decoded.foo, 'bar');
});

// ---- signedPost against a mock server --------------------------------------

test('signedPost decrypts the server response and enforces result_code === "1"', async () => {
  // Mock server: decrypt the request with the wrapped AES key, answer AES-encrypted.
  setFetchForTest((async (_url: string, init: RequestInit) => {
    const xrsk = (init.headers as Record<string, string>)['x-random-secret-key'];
    const aesKey = unwrapAesKey(xrsk);
    const reqJson = JSON.parse(aesDecrypt(String(init.body), aesKey));
    assert.equal(reqJson.appkey, 'APPKEY123'); // proves the server got our signed body
    const respPlain = JSON.stringify({ result_code: '1', result_data: { token: 'TKN', echoed: reqJson.probe } });
    return new Response(aesEncrypt(respPlain, aesKey), { status: 200 });
  }) as unknown as typeof fetch);

  const out = await signedPost(CFG, '/openapi/login', { appkey: CFG.appkey, probe: 'ping' });
  const data = out.result_data as { token: string; echoed: string };
  assert.equal(data.token, 'TKN');
  assert.equal(data.echoed, 'ping');
  setFetchForTest(fetch);
});

test('signedPost throws on a non-"1" result_code', async () => {
  setFetchForTest((async (_url: string, init: RequestInit) => {
    const xrsk = (init.headers as Record<string, string>)['x-random-secret-key'];
    const aesKey = unwrapAesKey(xrsk);
    const respPlain = JSON.stringify({ result_code: 'E00001', result_msg: 'bad appkey' });
    return new Response(aesEncrypt(respPlain, aesKey), { status: 200 });
  }) as unknown as typeof fetch);

  await assert.rejects(() => signedPost(CFG, '/openapi/login', { appkey: 'x' }), /result_code E00001/);
  setFetchForTest(fetch);
});

test('signedPost surfaces an HTTP error', async () => {
  setFetchForTest((async () => new Response('nope', { status: 500 })) as unknown as typeof fetch);
  await assert.rejects(() => signedPost(CFG, '/openapi/login', {}), /HTTP 500/);
  setFetchForTest(fetch);
});

// ---- parseRealTimeData ------------------------------------------------------

test('parseRealTimeData maps p83033→W, p83022→kWh and flags offline correctly', () => {
  const json = {
    result_code: '1',
    result_data: {
      device_point_list: [
        { ps_key: 'A2160700249_11_0_0', device_point: { dev_sn: 'A2160700249', p83033: '2500', p83022: '9400', p83025: '1' } },
        { ps_key: 'B2160700111_11_0_0', device_point: { dev_sn: 'B2160700111', p83033: '0', p83022: '0', p83025: '0' } },
      ],
    },
  };
  const devs = parseRealTimeData(json);
  assert.equal(devs.length, 2);
  assert.equal(devs[0].serial, 'A2160700249');
  assert.equal(devs[0].acPowerW, 2500);
  assert.equal(devs[0].dailyKwh, 9.4); // 9400 Wh → 9.4 kWh
  assert.equal(devs[0].offline, false); // producing + running
  assert.equal(devs[0].pointsPresent, null); // power present → no fallback keys
  assert.equal(devs[1].acPowerW, 0);
  assert.equal(devs[1].offline, true); // zero power + not running
  assert.equal(devs[1].pointsPresent, null); // p83033 present (value "0") → real zero, not a miss
});

test('parseRealTimeData tolerates missing points / empty list', () => {
  assert.deepEqual(parseRealTimeData({ result_data: {} }), []);
  const devs = parseRealTimeData({ result_data: { device_point_list: [{ ps_key: 'X_1_0_0', device_point: {} }] } });
  assert.equal(devs[0].acPowerW, null);
  assert.equal(devs[0].dailyKwh, null);
  assert.equal(devs[0].offline, true); // no power + no run-state → treated as offline
  assert.deepEqual(devs[0].pointsPresent, []); // p83033 key absent → fallback reports (empty) present set
});

test('parseRealTimeData surfaces the ACTUAL point keys when p83033 is absent (point-id mismatch net)', () => {
  // device_type 1 may report AC power under a DIFFERENT point id — no p83033. We must
  // capture whatever keys ARE present so the right ids show up in one Test.
  const json = {
    result_code: '1',
    result_data: {
      device_point_list: [
        { ps_key: 'C1_1_0_0', device_point: { dev_sn: 'C1', p83067: '3100', p83022: '5000', p83001: '2' } },
      ],
    },
  };
  const devs = parseRealTimeData(json);
  assert.equal(devs[0].serial, 'C1');
  assert.equal(devs[0].acPowerW, null); // no p83033
  assert.deepEqual(devs[0].pointsPresent, ['dev_sn', 'p83001', 'p83022', 'p83067']); // sorted keys present
});

// ---- diagnose (full read-chain Test button) --------------------------------
// A path-routing mock: given a map of endpoint→plaintext-response, decrypt each request,
// answer AES-encrypted with the recovered per-request key (like the real gateway). A
// response can be a plain object (encrypted) or a { plainError } to simulate a plaintext
// auth/permission error body.

function mockGateway(byPath: Record<string, unknown>): void {
  setFetchForTest((async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const xrsk = (init.headers as Record<string, string>)['x-random-secret-key'];
    const aesKey = unwrapAesKey(xrsk);
    let resp = byPath[path];
    // A path may map to a function (called per-request) to count hits / vary the answer.
    if (typeof resp === 'function') resp = (resp as () => unknown)();
    if (resp === undefined) return new Response('not found', { status: 404 });
    const respPlain = JSON.stringify(resp);
    return new Response(aesEncrypt(respPlain, aesKey), { status: 200 });
  }) as unknown as typeof fetch);
}

test('diagnose: login failure → ok:false, "login failed"', async () => {
  resetTokenForTest();
  mockGateway({ '/openapi/login': { result_code: 'E00001', result_msg: 'account error' } });
  const r = await diagnose(CFG);
  assert.equal(r.ok, false);
  assert.match(r.detail, /^login failed —/);
  assert.match(r.detail, /account error/);
  assert.equal(r.devices, undefined);
  setFetchForTest(fetch);
});

test('diagnose: login OK but 0 plants → ok:false, propagation guidance', async () => {
  resetTokenForTest();
  mockGateway({
    '/openapi/login': { result_code: '1', result_data: { token: 'TKN' } },
    // Empty plant list → no ps_keys discovered (freshly-authorized / still propagating).
    '/openapi/getPowerStationList': { result_code: '1', result_data: { pageList: [] } },
  });
  const r = await diagnose(CFG);
  assert.equal(r.ok, false);
  assert.match(r.detail, /login OK · getPowerStationList returned 0 plants/);
  assert.match(r.detail, /still be propagating/);
  assert.equal(r.devices, undefined);
  setFetchForTest(fetch);
});

test('diagnose: 1 plant + devices but none are inverters → device_type filter guidance', async () => {
  resetTokenForTest();
  mockGateway({
    '/openapi/login': { result_code: '1', result_data: { token: 'TKN' } },
    '/openapi/getPowerStationList': {
      result_code: '1',
      result_data: { pageList: [{ ps_id: 7, ps_name: 'Javea' }] },
    },
    '/openapi/getDeviceList': {
      result_code: '1',
      result_data: {
        // device_types 7 + 22 (meter/logger etc.) — none is the inverter type (1), so we
        // still land in the "0 inverters" branch and surface the filter-adjust guidance.
        pageList: [
          { device_type: 7, ps_key: 'X_7_0_0' },
          { device_type: 22, ps_key: 'Y_22_0_0' },
        ],
      },
    },
  });
  const r = await diagnose(CFG);
  assert.equal(r.ok, false);
  assert.match(r.detail, /login OK · 1 plant \(Javea\) · 2 devices but 0 are inverters/);
  assert.match(r.detail, /device_types seen: \[7,22\]/);
  assert.match(r.detail, /device_type filter may need adjusting/);
  assert.match(r.detail, /expected 1/); // constant now 1 (SG string inverter), not 11
  assert.equal(r.devices, undefined);
  setFetchForTest(fetch);
});

test('diagnose: a device_type=1 device (SG string inverter) IS recognized as an inverter', async () => {
  // The real fix: the owner's SG5.0RS units report device_type 1 (seen list [1,7,22]).
  // With DEVICE_TYPE_INVERTER=1 the type-1 device must now be picked up and read.
  resetTokenForTest();
  resetPsKeysCacheForTest();
  mockGateway({
    '/openapi/login': { result_code: '1', result_data: { token: 'TKN' } },
    '/openapi/getPowerStationList': { result_code: '1', result_data: { pageList: [{ ps_id: 7, ps_name: 'Javea' }] } },
    '/openapi/getDeviceList': {
      result_code: '1',
      result_data: {
        pageList: [
          { device_type: 1, ps_key: 'SG1_1_0_0' }, // string inverter — now matched
          { device_type: 7, ps_key: 'MTR_7_0_0' }, // meter — ignored
          { device_type: 22, ps_key: 'LOG_22_0_0' }, // logger — ignored
        ],
      },
    },
    '/openapi/getDeviceRealTimeData': {
      result_code: '1',
      result_data: {
        device_point_list: [
          { ps_key: 'SG1_1_0_0', device_point: { dev_sn: 'SG1', p83033: '4200', p83022: '11000', p83025: '1' } },
        ],
      },
    },
  });
  const r = await diagnose(CFG);
  assert.equal(r.ok, true);
  assert.match(r.detail, /device_types \[1,7,22\] · 1 inverter ·/);
  assert.match(r.detail, /SG1 4\.20kW/);
  assert.equal(r.devices?.length, 1);
  assert.equal(r.devices?.[0].serial, 'SG1');
  assert.equal(r.devices?.[0].acPowerW, 4200);
  setFetchForTest(fetch);
  resetPsKeysCacheForTest();
});

test('diagnose: 1 plant but 0 devices → getDeviceList-empty guidance', async () => {
  resetTokenForTest();
  mockGateway({
    '/openapi/login': { result_code: '1', result_data: { token: 'TKN' } },
    '/openapi/getPowerStationList': {
      result_code: '1',
      result_data: { pageList: [{ ps_id: 7, ps_name: 'Javea' }] },
    },
    '/openapi/getDeviceList': { result_code: '1', result_data: { pageList: [] } },
  });
  const r = await diagnose(CFG);
  assert.equal(r.ok, false);
  assert.match(r.detail, /login OK · 1 plant \(Javea\) · 0 devices/);
  assert.match(r.detail, /getDeviceList returned nothing/);
  setFetchForTest(fetch);
});

test('diagnose: discovery service error → ok:false surfaces result_msg + guidance', async () => {
  resetTokenForTest();
  mockGateway({
    '/openapi/login': { result_code: '1', result_data: { token: 'TKN' } },
    '/openapi/getPowerStationList': { result_code: 'E90001', result_msg: 'no permission for this service' },
  });
  const r = await diagnose(CFG);
  assert.equal(r.ok, false);
  assert.match(r.detail, /login OK, but device discovery failed/);
  assert.match(r.detail, /no permission for this service/);
  assert.match(r.detail, /Service API management/);
  setFetchForTest(fetch);
});

test('diagnose: full success → ok:true, per-device serial + kW, devices returned', async () => {
  resetTokenForTest();
  mockGateway({
    '/openapi/login': { result_code: '1', result_data: { token: 'TKN' } },
    '/openapi/getPowerStationList': { result_code: '1', result_data: { pageList: [{ ps_id: 42, ps_name: 'Javea' }] } },
    '/openapi/getDeviceList': {
      result_code: '1',
      result_data: {
        pageList: [
          { device_type: 1, ps_key: 'A2160700249_1_0_0' },
          { device_type: 1, ps_key: 'B2160700111_1_0_0' },
          { device_type: 14, ps_key: 'METER_14_0_0' }, // non-inverter, ignored
        ],
      },
    },
    '/openapi/getDeviceRealTimeData': {
      result_code: '1',
      result_data: {
        device_point_list: [
          { ps_key: 'A2160700249_1_0_0', device_point: { dev_sn: 'A2160700249', p83033: '2500', p83022: '9400', p83025: '1' } },
          { ps_key: 'B2160700111_1_0_0', device_point: { dev_sn: 'B2160700111', p83033: '0', p83022: '0', p83025: '0' } },
        ],
      },
    },
  });
  const r = await diagnose(CFG);
  assert.equal(r.ok, true);
  assert.match(r.detail, /^login OK · 1 plant \(Javea\) · 3 devices · device_types \[1,14\] · 2 inverters ·/);
  assert.match(r.detail, /A2160700249 2\.50kW/);
  assert.match(r.detail, /B2160700111 0\.00kW \(offline\)/);
  assert.equal(r.devices?.length, 2);
  assert.equal(r.devices?.[0].serial, 'A2160700249');
  assert.equal(r.devices?.[0].acPowerW, 2500);
  setFetchForTest(fetch);
});

test('diagnose: inverter found but p83033 missing → detail surfaces the points present', async () => {
  // The device_type filter is right (an inverter is discovered + read) but the point ids
  // differ for it: AC power arrives as p83067, not p83033. The Test must name the actual
  // keys present so the right point ids are visible in ONE more Test.
  resetTokenForTest();
  resetPsKeysCacheForTest();
  mockGateway({
    '/openapi/login': { result_code: '1', result_data: { token: 'TKN' } },
    '/openapi/getPowerStationList': { result_code: '1', result_data: { pageList: [{ ps_id: 7, ps_name: 'Javea' }] } },
    '/openapi/getDeviceList': { result_code: '1', result_data: { pageList: [{ device_type: 1, ps_key: 'SG1_1_0_0' }] } },
    '/openapi/getDeviceRealTimeData': {
      result_code: '1',
      result_data: {
        device_point_list: [
          { ps_key: 'SG1_1_0_0', device_point: { dev_sn: 'SG1', p83067: '4200', p83022: '11000', p83001: '2' } },
        ],
      },
    },
  });
  const r = await diagnose(CFG);
  assert.equal(r.ok, true); // a device WAS read — the chain works, only the point ids differ
  assert.match(r.detail, /SG1: no p83033 — points present: dev_sn,p83001,p83022,p83067/);
  assert.equal(r.devices?.[0].acPowerW, null);
  assert.deepEqual(r.devices?.[0].pointsPresent, ['dev_sn', 'p83001', 'p83022', 'p83067']);
  setFetchForTest(fetch);
  resetPsKeysCacheForTest();
});

test('diagnose: serialMap set → derives ps_keys without plant discovery, success', async () => {
  resetTokenForTest();
  mockGateway({
    '/openapi/login': { result_code: '1', result_data: { token: 'TKN' } },
    '/openapi/getDeviceRealTimeData': {
      result_code: '1',
      result_data: {
        device_point_list: [
          { ps_key: 'A2160700249_1_0_0', device_point: { dev_sn: 'A2160700249', p83033: '1200', p83022: '3000', p83025: '1' } },
        ],
      },
    },
    // No plant/device endpoints registered — if diagnose called them it would 404/throw.
  });
  const r = await diagnose({ ...CFG, serialMap: { A2160700249: '192.168.1.67' } });
  assert.equal(r.ok, true);
  assert.equal(r.devices?.length, 1);
  assert.match(r.detail, /^login OK · serialMap · 1 inverter ·/);
  assert.match(r.detail, /A2160700249 1\.20kW/);
  setFetchForTest(fetch);
});

// ---- discoverPsKeys caching: EMPTY must NOT stick for 30 min (post-authorization propagation) ----

test('discoverPsKeys does not cache an empty discovery — re-probes on the next call', async () => {
  resetPsKeysCacheForTest();
  let plantCalls = 0;
  mockGateway({
    // Empty plant list every time → 0 ps_keys. A 30-min cache would freeze this stale.
    '/openapi/getPowerStationList': (() => {
      plantCalls += 1;
      return { result_code: '1', result_data: { pageList: [] } };
    }),
  });

  const first = await discoverPsKeys(CFG, 'TKN');
  assert.deepEqual(first, []);
  const callsAfterFirst = plantCalls;
  // A NON-empty result would be served from cache; an empty one must re-hit the endpoint.
  const second = await discoverPsKeys(CFG, 'TKN');
  assert.deepEqual(second, []);
  assert.ok(plantCalls > callsAfterFirst, 'empty discovery was cached (should have re-probed)');
  setFetchForTest(fetch);
  resetPsKeysCacheForTest();
});

test('discoverPsKeys caches a NON-empty discovery — no re-probe on the next call', async () => {
  resetPsKeysCacheForTest();
  let plantCalls = 0;
  mockGateway({
    '/openapi/getPowerStationList': (() => {
      plantCalls += 1;
      return { result_code: '1', result_data: { pageList: [{ ps_id: 7 }] } };
    }),
    '/openapi/getDeviceList': { result_code: '1', result_data: { pageList: [{ device_type: 1, ps_key: 'A_1_0_0' }] } },
  });

  const first = await discoverPsKeys(CFG, 'TKN');
  assert.deepEqual(first, ['A_1_0_0']);
  const callsAfterFirst = plantCalls;
  const second = await discoverPsKeys(CFG, 'TKN');
  assert.deepEqual(second, ['A_1_0_0']);
  assert.equal(plantCalls, callsAfterFirst, 'non-empty discovery should be served from cache');
  setFetchForTest(fetch);
  resetPsKeysCacheForTest();
});

test('diagnose never throws (fail-soft) on a transport error', async () => {
  resetTokenForTest();
  setFetchForTest((async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch);
  const r = await diagnose(CFG);
  assert.equal(r.ok, false);
  assert.match(r.detail, /login failed —/);
  setFetchForTest(fetch);
});
