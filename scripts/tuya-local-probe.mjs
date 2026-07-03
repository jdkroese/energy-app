// Tuya LOCAL (LAN) control probe — Phase 1, READ-ONLY by default (docs/44).
//
// Validates how much of the Tuya fleet we can read/control over the LAN with ZERO
// cloud calls, so we can stop burning the free-tier quota on polling. It has two
// steps:
//
//   1) HARVEST  — for every device id known to the app, gather {id,name,category,
//      ip,localKey}. `ip` comes from the cloud per-device detail and `localKey`
//      from the cloud device listing, IF cloud creds exist and the quota allows.
//      Results are cached to .data/tuya-local.json so later runs (and the local
//      step) work even when the cloud is quota-blocked. Cloud failure is tolerated
//      — it just reuses whatever was cached and reports "harvest skipped".
//
//   2) LOCAL PROBE — for each device with an ip + localKey, open a LAN connection
//      with `tuyapi`, auto-detecting the protocol version (3.3 → 3.4 → 3.5), and
//      READ the status DPS. Never writes/toggles unless `--write-test <id>` is
//      passed AND the id matches a benign device. Default is strictly read-only.
//
// It uses the SAME HMAC signing as apps/api/src/connectors/tuya.ts but imports
// nothing from the app — only `node:*` and (for the local step) the `tuyapi`
// package, mirroring how scripts/tuya-check.mjs stays app-independent.
//
// Run (on the mini, same LAN as the devices):
//   node scripts/tuya-local-probe.mjs                 # harvest + read-only probe
//   node scripts/tuya-local-probe.mjs --no-harvest    # use cached creds only
//   node scripts/tuya-local-probe.mjs --write-test bfXXXX   # opt-in single toggle
//
// Cloud creds are read from .data/state.json (integrations.tuya) or, as a
// fallback, TUYA_ACCESS_ID / TUYA_ACCESS_SECRET / TUYA_REGION env vars.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// ---- Paths ------------------------------------------------------------------
// Prod .data on the mini; override with DATA_DIR for local testing.
const DATA_DIR = process.env.DATA_DIR || '/Users/joris/sites/energy/.data';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CACHE_FILE = path.join(DATA_DIR, 'tuya-local.json'); // gitignored (.data/)

// ---- Args -------------------------------------------------------------------
const args = process.argv.slice(2);
const NO_HARVEST = args.includes('--no-harvest');
const writeIdx = args.indexOf('--write-test');
const WRITE_TEST_ID = writeIdx >= 0 ? (args[writeIdx + 1] || '').trim() : '';

// ---- Region hosts (mirror of the connector) ---------------------------------
const REGION_HOSTS = {
  eu: 'https://openapi.tuyaeu.com',
  weu: 'https://openapi-weaz.tuyaeu.com',
  us: 'https://openapi.tuyaus.com',
  eus: 'https://openapi-ueaz.tuyaus.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};

const EMPTY_SHA256 = crypto.createHash('sha256').update('', 'utf8').digest('hex');

// ---- State / cache IO -------------------------------------------------------
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Cloud creds: app store first (integrations.tuya), env as a fallback. */
function loadCreds(state) {
  const t = state?.integrations?.tuya || {};
  const accessId = (t.accessId || process.env.TUYA_ACCESS_ID || '').trim();
  const accessSecret = t.accessSecret || process.env.TUYA_ACCESS_SECRET || '';
  const region = (t.region || process.env.TUYA_REGION || 'eu').trim().toLowerCase();
  if (!accessId || !accessSecret || !REGION_HOSTS[region]) return null;
  return { accessId, accessSecret, region, host: REGION_HOSTS[region] };
}

/**
 * Device ids the app knows about, with any name/category context we can glean
 * from state.json. We scan for bf… tokens (same approach as ops-device-forensics)
 * so we don't couple to every store shape, then enrich names from deviceSettings /
 * deviceOnboarding.configured where present.
 */
function knownDevices(state) {
  const byId = new Map();
  const add = (id, patch = {}) => {
    if (!/^bf[0-9a-z]{15,25}$/.test(id)) return;
    const cur = byId.get(id) || { id, name: '', category: '' };
    byId.set(id, { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v)) });
  };

  // Names/categories from onboarding + settings where available.
  const configured = state?.deviceOnboarding?.configured || {};
  for (const [id, v] of Object.entries(configured)) {
    add(id, { name: v?.name || v?.label, category: v?.category || v?.type });
  }
  const settings = state?.deviceSettings || {};
  for (const [id, v] of Object.entries(settings)) add(id, { name: v?.name, category: v?.category });

  // Sweep every bf-token anywhere in state so we don't miss scene/room-only ids.
  const txt = JSON.stringify(state ?? {});
  for (const m of txt.matchAll(/bf[0-9a-z]{15,25}/g)) add(m[0]);

  return [...byId.values()];
}

// ---- Cloud signing (HMAC-SHA256, mirror of the connector) -------------------
function makeCloud(creds) {
  const hmac = (str) =>
    crypto.createHmac('sha256', creds.accessSecret).update(str, 'utf8').digest('hex').toUpperCase();
  let token = '';

  async function signedGet(p, withToken) {
    const t = Date.now().toString();
    const stringToSign = ['GET', EMPTY_SHA256, '', p].join('\n');
    const signStr = withToken ? creds.accessId + token + t + stringToSign : creds.accessId + t + stringToSign;
    const headers = { client_id: creds.accessId, sign: hmac(signStr), t, sign_method: 'HMAC-SHA256', nonce: '' };
    if (withToken) headers.access_token = token;
    const res = await fetch(creds.host + p, { headers, signal: AbortSignal.timeout(12_000) });
    return res.json();
  }

  return {
    async connect() {
      const tok = await signedGet('/v1.0/token?grant_type=1', false);
      if (!tok.success) throw new Error(`token: ${tok.msg} (code ${tok.code})`);
      token = tok.result.access_token;
    },
    // Full associated-users listing → id -> local_key + name/category.
    async listDevices() {
      const out = [];
      let lastRowKey = '';
      for (let page = 0; page < 20; page++) {
        const q = lastRowKey ? `?last_row_key=${encodeURIComponent(lastRowKey)}` : '';
        const r = await signedGet(`/v1.0/iot-01/associated-users/devices${q}`, true);
        if (!r.success) throw new Error(`listDevices: ${r.msg} (code ${r.code})`);
        for (const d of r.result?.devices ?? []) out.push(d);
        if (!r.result?.has_more || !r.result?.last_row_key) break;
        lastRowKey = r.result.last_row_key;
      }
      return out;
    },
    // Per-device detail → LAN ip.
    async detail(id) {
      const r = await signedGet(`/v1.0/devices/${id}`, true);
      if (!r.success) throw new Error(`detail ${id}: ${r.msg} (code ${r.code})`);
      return r.result || {};
    },
  };
}

// ---- Harvest ----------------------------------------------------------------
async function harvest(state, devices) {
  const cache = readJson(CACHE_FILE) || { devices: {} };
  cache.devices = cache.devices || {};

  // Seed from what we know locally (names/categories) without overwriting cached ip/key.
  for (const d of devices) {
    const prev = cache.devices[d.id] || {};
    cache.devices[d.id] = {
      id: d.id,
      name: d.name || prev.name || '',
      category: d.category || prev.category || '',
      ip: prev.ip || '',
      localKey: prev.localKey || '',
      version: prev.version || '',
    };
  }

  if (NO_HARVEST) return { cache, note: 'harvest skipped: --no-harvest' };

  const creds = loadCreds(state);
  if (!creds) return { cache, note: 'harvest skipped: no cloud creds (state integrations.tuya / TUYA_* env)' };

  const cloud = makeCloud(creds);
  try {
    await cloud.connect();
  } catch (e) {
    return { cache, note: `harvest skipped: cloud auth failed — ${e.message}` };
  }

  // local_key in one page-walk.
  let keyById = new Map();
  try {
    const list = await cloud.listDevices();
    for (const d of list) keyById.set(d.id, { localKey: d.local_key, name: d.name, category: d.category });
  } catch (e) {
    return { cache, note: `harvest partial: listDevices failed — ${e.message}` };
  }

  // ip per device (only for ones the app knows about; cheap + bounded).
  let ipOk = 0;
  let ipFail = 0;
  for (const d of devices) {
    const k = keyById.get(d.id);
    const entry = cache.devices[d.id];
    if (k) {
      if (k.localKey) entry.localKey = k.localKey;
      if (!entry.name && k.name) entry.name = k.name;
      if (!entry.category && k.category) entry.category = k.category;
    }
    try {
      const det = await cloud.detail(d.id);
      if (det.ip) {
        entry.ip = det.ip;
        ipOk++;
      }
    } catch {
      ipFail++;
    }
  }

  cache.harvestedAt = new Date().toISOString();
  return { cache, note: `harvest ok: ${keyById.size} keys, ip ${ipOk} ok / ${ipFail} fail` };
}

function writeCache(cache) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    return true;
  } catch (e) {
    console.log(`  ! could not write cache ${CACHE_FILE}: ${e.message}`);
    return false;
  }
}

// ---- Local probe (READ-ONLY unless --write-test) ----------------------------
async function loadTuyapi() {
  // tuyapi is CommonJS. Bare ESM `import` ignores NODE_PATH, so resolve via a
  // CJS require() (which DOES honour NODE_PATH) — that's how the workflow exposes
  // the scratch-installed copy. Fall back to a normal dynamic import for local dev
  // where tuyapi may sit in a nearby node_modules.
  const req = createRequire(import.meta.url);
  const dirs = [
    ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : []),
    path.join(process.cwd(), 'node_modules'),
  ].filter(Boolean);
  for (const dir of dirs) {
    try {
      const mod = req(path.join(dir, 'tuyapi'));
      return mod.default || mod;
    } catch {
      /* try next */
    }
  }
  try {
    const mod = req('tuyapi');
    return mod.default || mod;
  } catch {
    /* not found via require */
  }
  try {
    const mod = await import('tuyapi');
    return mod.default || mod;
  } catch {
    return null;
  }
}

/** Build a TuyAPI device with an 'error' listener attached — tuyapi is an
 *  EventEmitter and emits 'error' on socket timeout/reset; an unhandled 'error'
 *  event would crash the whole process, so we always swallow it here. */
function makeDevice(TuyAPI, dev, version) {
  const device = new TuyAPI({ id: dev.id, key: dev.localKey, ip: dev.ip, version, issueGetOnConnect: false });
  device.on('error', () => {
    /* swallowed — the awaited connect/get/set already rejects with the reason */
  });
  return device;
}

/** Try to connect + read status, auto-detecting protocol version. */
async function probeOne(TuyAPI, dev) {
  const versions = ['3.3', '3.4', '3.5'];
  let lastErr = '';
  for (const version of versions) {
    let device;
    try {
      device = makeDevice(TuyAPI, dev, version);
      // Bounded connect: tuyapi's connect resolves on the socket; guard with a timeout.
      await withTimeout(device.connect(), 6000, 'connect');
      const status = await withTimeout(device.get({ schema: true }), 5000, 'get');
      await safeDisconnect(device);
      const dps = status && typeof status === 'object' && status.dps ? status.dps : status;
      return { reachable: true, version, statusOk: dps != null, dpsCount: dps ? Object.keys(dps).length : 0 };
    } catch (e) {
      lastErr = `${version}: ${e.message}`;
      await safeDisconnect(device);
    }
  }
  return { reachable: false, error: lastErr };
}

async function safeDisconnect(device) {
  try {
    if (device && typeof device.disconnect === 'function') device.disconnect();
  } catch {
    /* ignore */
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

// ---- Main -------------------------------------------------------------------
async function main() {
  console.log('\n=== Tuya LOCAL (LAN) control probe — Phase 1, read-only (docs/44) ===\n');
  console.log(`data dir : ${DATA_DIR}`);
  console.log(`cache    : ${CACHE_FILE}`);
  if (WRITE_TEST_ID) console.log(`WRITE-TEST requested for: ${WRITE_TEST_ID} (single opt-in toggle)`);

  const state = readJson(STATE_FILE);
  if (!state) console.log(`! could not read ${STATE_FILE} — continuing off cache only`);

  const devices = knownDevices(state);
  console.log(`\nknown device ids (from state.json): ${devices.length}`);

  // 1) Harvest.
  const { cache, note } = await harvest(state, devices);
  console.log(`\nHarvest → ${note}`);
  writeCache(cache);

  // 2) Local probe.
  const TuyAPI = await loadTuyapi();
  if (!TuyAPI) {
    console.log('\n! `tuyapi` is not installed — cannot run the local step.');
    console.log('  Install it for the run: `npm install tuyapi` (the workflow does this).');
    console.log('  Harvest cache was still written; re-run with tuyapi present to probe the LAN.');
    printHarvestSummary(cache);
    return;
  }

  const all = Object.values(cache.devices);
  const probeable = all.filter((d) => d.ip && d.localKey);
  const needCloud = all.filter((d) => !(d.ip && d.localKey));

  console.log(`\nLocal probe: ${probeable.length} device(s) have ip+localKey; ${needCloud.length} need cloud (missing ip/key).\n`);

  const results = [];
  for (const dev of probeable) {
    const r = await probeOne(TuyAPI, dev);
    results.push({ dev, r });
    const label = `[${dev.category || '?'}] ${dev.name || dev.id}`.padEnd(34);
    if (r.reachable) {
      console.log(`  ✓ ${label} ${dev.ip.padEnd(15)} v${r.version}  status:${r.statusOk ? 'ok' : 'empty'} (${r.dpsCount} DPs)`);
    } else {
      console.log(`  ✗ ${label} ${(dev.ip || '?').padEnd(15)} unreachable — ${r.error}`);
    }
  }

  // Optional, explicit, single-device write test (opt-in; never default).
  if (WRITE_TEST_ID) await runWriteTest(TuyAPI, cache, results);

  // ---- Summary report (the Phase-1 deliverable) ----
  const reachable = results.filter((x) => x.r.reachable);
  const versions = {};
  for (const x of reachable) versions[x.r.version] = (versions[x.r.version] || 0) + 1;
  const verStr = Object.entries(versions).map(([v, n]) => `v${v}×${n}`).join(', ') || 'none';

  console.log('\n=== SUMMARY ===');
  console.log(`${all.length} devices total, ${reachable.length} locally reachable (${verStr}), ` +
    `${results.length - reachable.length} probe-failed, ${needCloud.length} need cloud (no ip/key).`);
  if (needCloud.length) {
    console.log('\nNeed cloud (missing ip and/or localKey — harvest, or Zigbee/BLE sub-device behind a gateway):');
    for (const d of needCloud) {
      const miss = [!d.ip && 'ip', !d.localKey && 'localKey'].filter(Boolean).join('+');
      console.log(`  - [${d.category || '?'}] ${d.name || d.id} (${d.id}) — missing ${miss}`);
    }
  }
  console.log('');
}

function printHarvestSummary(cache) {
  const all = Object.values(cache.devices);
  const ready = all.filter((d) => d.ip && d.localKey).length;
  console.log(`\nHarvest summary: ${all.length} devices, ${ready} have ip+localKey (ready for a local probe).`);
}

// Opt-in, single-device, benign write test. Guarded hard: id must match a device
// we harvested AND must not look like a breaker/curtain (avoid moving hardware) —
// we only toggle a simple boolean switch DP if one is present, then restore it.
async function runWriteTest(TuyAPI, cache, results) {
  const dev = cache.devices[WRITE_TEST_ID];
  console.log(`\n--- WRITE TEST (${WRITE_TEST_ID}) ---`);
  if (!dev) return console.log('  aborted: id not in harvested cache.');
  if (!dev.ip || !dev.localKey) return console.log('  aborted: device has no ip/localKey.');
  const probe = results.find((x) => x.dev.id === WRITE_TEST_ID);
  if (!probe || !probe.r.reachable) return console.log('  aborted: device was not locally reachable.');
  const cat = (dev.category || '').toLowerCase();
  if (/(cl|curtain|cz.*breaker|breaker|dlq|wk|kg.*gate)/.test(cat)) {
    return console.log(`  aborted: category '${dev.category}' is not benign for a blind toggle test.`);
  }

  const version = probe.r.version;
  let device;
  try {
    device = makeDevice(TuyAPI, dev, version);
    await withTimeout(device.connect(), 6000, 'connect');
    const status = await withTimeout(device.get({ schema: true }), 5000, 'get');
    const dps = (status && status.dps) || {};
    // Find a boolean DP to flip (typically '1' = switch). Prefer DP '1'.
    const boolDp = ['1', ...Object.keys(dps)].find((k) => typeof dps[k] === 'boolean');
    if (!boolDp) {
      await safeDisconnect(device);
      return console.log('  aborted: no boolean switch DP found to toggle safely.');
    }
    const original = dps[boolDp];
    console.log(`  toggling DP ${boolDp}: ${original} -> ${!original} then restoring…`);
    await withTimeout(device.set({ dps: boolDp, set: !original }), 5000, 'set');
    await new Promise((r) => setTimeout(r, 800));
    await withTimeout(device.set({ dps: boolDp, set: original }), 5000, 'restore');
    await safeDisconnect(device);
    console.log('  ✓ write test ok (toggled and restored locally).');
  } catch (e) {
    await safeDisconnect(device);
    console.log(`  ✗ write test failed: ${e.message}`);
  }
}

main().catch((e) => {
  console.error('\nprobe crashed:', e.message);
  process.exit(1);
});
