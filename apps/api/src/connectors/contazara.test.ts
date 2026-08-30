// Unit tests for the Contazara water-meter connector (docs/52). Hermetic — a mock
// fetch injected via setFetchForTest(), nothing hits the network. Run with:
//   node --import tsx --test src/connectors/contazara.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  setFetchForTest,
  resetTokenForTest,
  getToken,
  probe,
  diagnose,
  parseSubscriberInfo,
  parseDaily,
  parseHourly,
  parseTimeslot,
  nightLitresFromHourly,
  parseMeterTimestamp,
  madridLocalToEpochSec,
} from './contazara';
import type { ContazaraConfig } from '../runtime-config';

const CFG: ContazaraConfig = { email: 'owner@example.com', password: 'secret', serial: 'P23EA822644C', pollHours: 6 };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ---- Token grant --------------------------------------------------------------

test('getToken performs the password grant and returns the access token', async () => {
  resetTokenForTest();
  let capturedUrl = '';
  let capturedBody = '';
  setFetchForTest(async (url, init) => {
    capturedUrl = String(url);
    capturedBody = String((init as RequestInit).body);
    return jsonResponse({ access_token: 'TOKEN123', refresh_token: 'REFRESH456', expires_in: 599 });
  });
  const token = await getToken(CFG);
  assert.equal(token, 'TOKEN123');
  assert.match(capturedUrl, /\/auth\/realms\/cz-iot-platform\/protocol\/openid-connect\/token$/);
  const params = new URLSearchParams(capturedBody);
  assert.equal(params.get('username'), CFG.email);
  assert.equal(params.get('password'), CFG.password);
  assert.equal(params.get('grant_type'), 'password');
  assert.equal(params.get('client_id'), 'service-iot-api');
  setFetchForTest(fetch);
});

test('getToken reuses the cached token within its expiry window (no second grant)', async () => {
  resetTokenForTest();
  let calls = 0;
  setFetchForTest(async () => {
    calls += 1;
    return jsonResponse({ access_token: 'TOKEN-A', expires_in: 599 });
  });
  const t1 = await getToken(CFG);
  const t2 = await getToken(CFG);
  assert.equal(t1, 'TOKEN-A');
  assert.equal(t2, 'TOKEN-A');
  assert.equal(calls, 1);
  setFetchForTest(fetch);
});

test('probe() fails soft (ok:false) on an HTTP error, never throws', async () => {
  resetTokenForTest();
  setFetchForTest(async () => jsonResponse({}, false, 401));
  const result = await probe(CFG);
  assert.equal(result.ok, false);
  assert.match(result.detail, /HTTP 401/);
  setFetchForTest(fetch);
});

// ---- Night-slot alignment (docs/52 §2 "verified 2026-08-30") -------------------
// 29 Aug hourly: 121 + 1717 + 1271 + 1500 + 1428 (hours 00..04) — the brief's captured
// figures sum with hour 05 to ~6,037 L, matching the timeslot endpoint's 6,036 L night
// value (a ~1L rounding difference). This nails down which hours belong to "night".

test('the night slot is hours 00:00-05:59 (six hours), matching the captured timeslot figure', () => {
  const day = '20260829';
  const litresByHour = [121, 1717, 1271, 1500, 1428, 0]; // hours 0..5 (hour 5 unseen in the brief's excerpt -> 0)
  const hourly = parseHourly(
    litresByHour.map((cmh, h) => ({ readDateTime: `${day}${String(h).padStart(2, '0')}0000`, cmh, indexVol: null })).concat(
      // A daytime hour that must NOT be counted as "night".
      [{ readDateTime: `${day}120000`, cmh: 9999, indexVol: null }],
    ),
  );
  const night = nightLitresFromHourly(hourly);
  assert.equal(night, 121 + 1717 + 1271 + 1500 + 1428 + 0);
  // Matches the captured timeslot figure (6,036 L) within a small rounding tolerance.
  assert.ok(Math.abs(night - 6036) <= 2, `expected ~6036, got ${night}`);
});

test('nightLitresFromHourly excludes hour 06 (the slot is 00:00-05:59, not 00:00-06:59)', () => {
  const hourly = parseHourly([
    { readDateTime: '20260829050000', cmh: 100, indexVol: null },
    { readDateTime: '20260829060000', cmh: 5000, indexVol: null }, // must be excluded
  ]);
  assert.equal(nightLitresFromHourly(hourly), 100);
});

// ---- Litres parsing -------------------------------------------------------------

test('parseSubscriberInfo extracts meters + notification thresholds', () => {
  const info = parseSubscriberInfo({
    userName: 'Joris',
    userEmail: 'j.kroese@levante.nl',
    notificationsConfig: { pushEnabled: true, lang: 'es', monthlyConsumption: 80, nightlyConsumption: 100 },
    subscriberMeters: [
      {
        idCustomer: 1,
        customerName: 'Kroese',
        idSubscriber: 2,
        serialNumber: 'P23EA822644C',
        address: 'Calle X',
        indexVol: 123456.7,
        lastReading: '20260830060000',
        model: 'CZ3000',
      },
    ],
  });
  assert.ok(info);
  assert.equal(info!.meters.length, 1);
  assert.equal(info!.meters[0].serialNumber, 'P23EA822644C');
  assert.equal(info!.meters[0].indexVol, 123456.7);
  assert.equal(info!.notificationsConfig?.monthlyConsumption, 80);
});

test('parseDaily reads the cmd field (consumption/daily)', () => {
  const rows = parseDaily([
    { readDate: '20260828', indexVol: 100, cmd: 250 },
    { readDate: '20260829', indexVol: 350, cmd: 250 },
  ]);
  assert.deepEqual(rows, [
    { day: '2026-08-28', litres: 250, indexVol: 100 },
    { day: '2026-08-29', litres: 250, indexVol: 350 },
  ]);
});

test('parseDaily reads the volume field (accumulatedDaily) when asked', () => {
  const rows = parseDaily([{ readDate: '20260828', volume: 90000 }], 'volume');
  assert.equal(rows[0].litres, 90000);
});

test('parseHourly reads cmh and is sorted by time', () => {
  const rows = parseHourly([
    { readDateTime: '20260829020000', cmh: 50, indexVol: null },
    { readDateTime: '20260829010000', cmh: 30, indexVol: null },
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].epochSec < rows[1].epochSec);
  assert.equal(rows[0].hour, 1);
  assert.equal(rows[1].hour, 2);
});

test('parseHourly drops unparseable points instead of throwing', () => {
  const rows = parseHourly([{ readDateTime: 'garbage', cmh: 5 }, { readDateTime: '20260829010000', cmh: 5 }]);
  assert.equal(rows.length, 1);
});

test('parseTimeslot merges the four daypart arrays by day', () => {
  const rows = parseTimeslot({
    morning: [{ readDate: '20260829', volume: 100 }],
    afternoon: [{ readDate: '20260829', volume: 200 }],
    evening: [{ readDate: '20260829', volume: 300 }],
    night: [{ readDate: '20260829', volume: 6036 }],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { day: '2026-08-29', morning: 100, afternoon: 200, evening: 300, night: 6036 });
});

// ---- Timestamp parsing (Madrid local -> epoch) ---------------------------------

test('parseMeterTimestamp parses YYYYMMDDHHmmss and rejects garbage', () => {
  const ok = parseMeterTimestamp('20260829143000');
  assert.ok(ok);
  assert.equal(ok!.hour, 14);
  assert.equal(ok!.dayKey, '2026-08-29');
  assert.equal(parseMeterTimestamp('not-a-timestamp'), null);
  assert.equal(parseMeterTimestamp('202608291430'), null); // too short
});

test('madridLocalToEpochSec round-trips through Date (CEST, August)', () => {
  const sec = madridLocalToEpochSec(2026, 8, 29, 14, 30, 0);
  const d = new Date(sec * 1000);
  // August in Madrid is CEST = UTC+2, so 14:30 local = 12:30 UTC.
  assert.equal(d.getUTCHours(), 12);
  assert.equal(d.getUTCMinutes(), 30);
});

// ---- Diagnose (full read chain) -------------------------------------------------

test('diagnose() reports meter details end-to-end on a healthy chain', async () => {
  resetTokenForTest();
  setFetchForTest(async (url) => {
    const u = String(url);
    if (u.includes('/token')) return jsonResponse({ access_token: 'TOK', expires_in: 599 });
    if (u.includes('/subscribers/info')) {
      return jsonResponse({
        subscriberMeters: [{ serialNumber: CFG.serial, address: 'Casa', indexVol: 5000, model: 'CZ3000' }],
      });
    }
    if (u.includes('/consumption/hourly')) {
      return jsonResponse([{ readDateTime: '20260829010000', cmh: 10, indexVol: null }]);
    }
    return jsonResponse({});
  });
  const result = await diagnose(CFG);
  assert.equal(result.ok, true);
  assert.match(result.detail, /login OK/);
  assert.equal(result.meter?.serialNumber, CFG.serial);
  setFetchForTest(fetch);
});

test('diagnose() fails soft with a clear stage when login fails', async () => {
  resetTokenForTest();
  setFetchForTest(async () => jsonResponse({}, false, 401));
  const result = await diagnose(CFG);
  assert.equal(result.ok, false);
  assert.match(result.detail, /login failed/);
  setFetchForTest(fetch);
});
