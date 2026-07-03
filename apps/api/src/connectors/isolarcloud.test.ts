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
  assert.equal(devs[1].acPowerW, 0);
  assert.equal(devs[1].offline, true); // zero power + not running
});

test('parseRealTimeData tolerates missing points / empty list', () => {
  assert.deepEqual(parseRealTimeData({ result_data: {} }), []);
  const devs = parseRealTimeData({ result_data: { device_point_list: [{ ps_key: 'X_11_0_0', device_point: {} }] } });
  assert.equal(devs[0].acPowerW, null);
  assert.equal(devs[0].dailyKwh, null);
  assert.equal(devs[0].offline, true); // no power + no run-state → treated as offline
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
    const resp = byPath[path];
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

test('diagnose: login OK but zero devices → ok:false, whitelist guidance', async () => {
  resetTokenForTest();
  mockGateway({
    '/openapi/login': { result_code: '1', result_data: { token: 'TKN' } },
    // Empty plant list → no ps_keys discovered.
    '/openapi/getPowerStationList': { result_code: '1', result_data: { pageList: [] } },
  });
  const r = await diagnose(CFG);
  assert.equal(r.ok, false);
  assert.match(r.detail, /login OK, but no inverters found/);
  assert.match(r.detail, /getPowerStationList\/getDeviceList/);
  assert.match(r.detail, /OAuth2\.0 = No/);
  assert.equal(r.devices, undefined);
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
    '/openapi/getPowerStationList': { result_code: '1', result_data: { pageList: [{ ps_id: 42 }] } },
    '/openapi/getDeviceList': {
      result_code: '1',
      result_data: {
        pageList: [
          { device_type: 11, ps_key: 'A2160700249_11_0_0' },
          { device_type: 11, ps_key: 'B2160700111_11_0_0' },
          { device_type: 14, ps_key: 'METER_14_0_0' }, // non-inverter, ignored
        ],
      },
    },
    '/openapi/getDeviceRealTimeData': {
      result_code: '1',
      result_data: {
        device_point_list: [
          { ps_key: 'A2160700249_11_0_0', device_point: { dev_sn: 'A2160700249', p83033: '2500', p83022: '9400', p83025: '1' } },
          { ps_key: 'B2160700111_11_0_0', device_point: { dev_sn: 'B2160700111', p83033: '0', p83022: '0', p83025: '0' } },
        ],
      },
    },
  });
  const r = await diagnose(CFG);
  assert.equal(r.ok, true);
  assert.match(r.detail, /^authenticated · 2 inverters ·/);
  assert.match(r.detail, /A2160700249 2\.50kW/);
  assert.match(r.detail, /B2160700111 0\.00kW \(offline\)/);
  assert.equal(r.devices?.length, 2);
  assert.equal(r.devices?.[0].serial, 'A2160700249');
  assert.equal(r.devices?.[0].acPowerW, 2500);
  setFetchForTest(fetch);
});

test('diagnose: serialMap set → derives ps_keys without plant discovery, success', async () => {
  resetTokenForTest();
  mockGateway({
    '/openapi/login': { result_code: '1', result_data: { token: 'TKN' } },
    '/openapi/getDeviceRealTimeData': {
      result_code: '1',
      result_data: {
        device_point_list: [
          { ps_key: 'A2160700249_11_0_0', device_point: { dev_sn: 'A2160700249', p83033: '1200', p83022: '3000', p83025: '1' } },
        ],
      },
    },
    // No plant/device endpoints registered — if diagnose called them it would 404/throw.
  });
  const r = await diagnose({ ...CFG, serialMap: { A2160700249: '192.168.1.67' } });
  assert.equal(r.ok, true);
  assert.equal(r.devices?.length, 1);
  assert.match(r.detail, /A2160700249 1\.20kW/);
  setFetchForTest(fetch);
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
