// Standalone Tuya Cloud connection check — proves the generic connection works
// (token + device discovery) before we wire it into the app UI or deploy.
//
// It uses the SAME signing protocol as apps/api/src/connectors/tuya.ts but has
// zero dependencies on the app, so it runs anywhere with just Node 18+.
//
// Run it WITHOUT putting your secret in a file or chat — pass via env vars:
//   PowerShell:
//     $env:TUYA_ACCESS_ID="gcrar9f3whagnkf3xq3a"
//     $env:TUYA_ACCESS_SECRET="<your client secret>"
//     $env:TUYA_REGION="eu"        # eu | us | cn | in  (must match the project's Data Center)
//     node scripts/tuya-check.mjs
//   bash:
//     TUYA_ACCESS_ID=... TUYA_ACCESS_SECRET=... TUYA_REGION=eu node scripts/tuya-check.mjs

import crypto from 'node:crypto';

const REGION_HOSTS = {
  eu: 'https://openapi.tuyaeu.com', // Central Europe
  weu: 'https://openapi-weaz.tuyaeu.com', // Western Europe (Azure)
  us: 'https://openapi.tuyaus.com', // Western America
  eus: 'https://openapi-ueaz.tuyaus.com', // Eastern America (Azure)
  cn: 'https://openapi.tuyacn.com', // China
  in: 'https://openapi.tuyain.com', // India
};

const accessId = process.env.TUYA_ACCESS_ID?.trim();
const accessSecret = process.env.TUYA_ACCESS_SECRET?.trim();
const region = (process.env.TUYA_REGION || 'eu').trim().toLowerCase();
const host = REGION_HOSTS[region];

if (!accessId || !accessSecret) {
  console.error('✗ Set TUYA_ACCESS_ID and TUYA_ACCESS_SECRET env vars first (see the header of this file).');
  process.exit(1);
}
if (!host) {
  console.error(`✗ TUYA_REGION must be one of: ${Object.keys(REGION_HOSTS).join(', ')}`);
  process.exit(1);
}

const EMPTY_SHA256 = crypto.createHash('sha256').update('', 'utf8').digest('hex');
const hmac = (str) => crypto.createHmac('sha256', accessSecret).update(str, 'utf8').digest('hex').toUpperCase();

async function signedGet(path, token) {
  const t = Date.now().toString();
  const stringToSign = ['GET', EMPTY_SHA256, '', path].join('\n');
  const signStr = token ? accessId + token + t + stringToSign : accessId + t + stringToSign;
  const headers = { client_id: accessId, sign: hmac(signStr), t, sign_method: 'HMAC-SHA256', nonce: '' };
  if (token) headers.access_token = token;
  const res = await fetch(host + path, { headers });
  return res.json();
}

// Friendly hints for the most common Tuya error codes.
function hint(code) {
  const m = {
    1004: 'sign invalid — Client Secret or Data Center (region) is wrong.',
    1010: 'token expired — transient; re-run.',
    1106: 'permission denied — your project is missing an API product. In the IoT console open the project → Service API → authorize "IoT Core" + "Authorization" + "Smart Home Basic Service".',
    1100: 'missing/empty parameter.',
    2406: 'skill/service not subscribed — authorize the API products (see code 1106).',
    28841002: 'no API permissions — authorize the API products (see code 1106).',
    28841105: 'no devices for this account — the app account is not linked, or it lives in a different Data Center than this region.',
  };
  return m[code] ? `\n   → ${m[code]}` : '';
}

console.log(`\nTuya check · region=${region} · ${host}\nClient ID: ${accessId}\n`);

// 1) Token — validates Client ID + Secret + region.
const tok = await signedGet('/v1.0/token?grant_type=1');
if (!tok.success) {
  console.error(`✗ Token request failed: ${tok.msg} (code ${tok.code})${hint(tok.code)}`);
  process.exit(1);
}
console.log('✓ Token OK — Client ID, Secret and region are valid.');
const token = tok.result.access_token;

// 2) Device discovery — validates the app-account link + API authorizations.
let lastRowKey = '';
const devices = [];
for (let page = 0; page < 20; page++) {
  const q = lastRowKey ? `?last_row_key=${encodeURIComponent(lastRowKey)}` : '';
  const r = await signedGet(`/v1.0/iot-01/associated-users/devices${q}`, token);
  if (!r.success) {
    console.error(`✗ Device discovery failed: ${r.msg} (code ${r.code})${hint(r.code)}`);
    process.exit(1);
  }
  for (const d of r.result?.devices ?? []) devices.push(d);
  if (!r.result?.has_more || !r.result?.last_row_key) break;
  lastRowKey = r.result.last_row_key;
}

if (devices.length === 0) {
  console.log('\n⚠ Token works but NO devices were returned.');
  console.log('   This almost always means the app account is not linked yet, or it is in a');
  console.log('   different Data Center than this region. Link it: IoT console → your project →');
  console.log('   Devices → Link App Account → Add App Account → scan the QR with Smart Life app.');
  process.exit(0);
}

const byCat = new Map();
for (const d of devices) byCat.set(d.category || '?', (byCat.get(d.category || '?') ?? 0) + 1);
console.log(`✓ Discovered ${devices.length} device(s):`);
for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${cat.padEnd(6)} × ${n}`);
}
console.log('\nSample:');
for (const d of devices.slice(0, 8)) {
  console.log(`   [${d.category}] ${d.name}  ${d.online ? 'online' : 'offline'}  (${d.id})`);
}
console.log('\nDone. The generic Tuya connection works end-to-end.\n');
