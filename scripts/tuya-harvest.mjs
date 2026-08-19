// Tuya credential harvest + fleet reconciliation (docs/44 Phase 1.5).
//
// Purpose: convert ONE short window of cloud quota into permanent local (LAN)
// control. It does three things, in this order, and is safe to re-run:
//
//   1) BACKUP    — snapshot .data/state.json into .data/backups/ before anything
//      else. The mini has no other backup of the app's entire configuration
//      (rooms, scenes, schedules, onboarding), so this runs even if the harvest
//      is later skipped for missing creds.
//
//   2) HARVEST   — for every device the cloud lists, capture {id, name, category,
//      ip, localKey, version, sub}. `localKey` is the one secret that makes local
//      control possible; `ip` + `localKey` together are all the LAN transport
//      needs. Written to .data/tuya-local.json (gitignored). Cheap and one-shot:
//      one paged listing plus a per-device detail ONLY for devices still missing
//      an ip — roughly 40-100 calls for a 39-device fleet, against a ~54,000
//      call/month free tier.
//
//   3) RECONCILE — diff the cloud's device ids against the ids the app already
//      has configured in state.json. This answers the question that actually
//      matters after switching Tuya accounts: did the device ids survive? Ids
//      belong to the paired device, not the cloud project, so relinking an
//      EXISTING Smart Life account to a NEW developer project preserves them and
//      all app config reattaches. Re-PAIRING devices mints new ids and orphans
//      every room/scene/schedule that referenced the old ones. The report names
//      exactly which devices fall in each bucket.
//
// Secrets are never printed: local keys are reported only as present/absent.
//
// Run (on the mini, which shares the devices' LAN):
//   node scripts/tuya-harvest.mjs              # backup + harvest + reconcile
//   node scripts/tuya-harvest.mjs --no-harvest # backup + reconcile from cache
//
// Creds are read from .data/state.json (integrations.tuya), falling back to
// TUYA_ACCESS_ID / TUYA_ACCESS_SECRET / TUYA_REGION env vars.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/Users/joris/sites/energy/.data';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CACHE_FILE = path.join(DATA_DIR, 'tuya-local.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const args = process.argv.slice(2);
const NO_HARVEST = args.includes('--no-harvest');

const REGION_HOSTS = {
  eu: 'https://openapi.tuyaeu.com',
  weu: 'https://openapi-weaz.tuyaeu.com',
  us: 'https://openapi.tuyaus.com',
  eus: 'https://openapi-ueaz.tuyaus.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};

const EMPTY_SHA256 = crypto.createHash('sha256').update('', 'utf8').digest('hex');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---- 1) Backup --------------------------------------------------------------

function backupState() {
  if (!fs.existsSync(STATE_FILE)) {
    console.log(`! state.json not found at ${STATE_FILE} — nothing to back up.`);
    return null;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // Sortable, filesystem-safe timestamp: 20260820-143005
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const dest = path.join(BACKUP_DIR, `state-${stamp}.json`);
  fs.copyFileSync(STATE_FILE, dest);
  const kb = (fs.statSync(dest).size / 1024).toFixed(1);
  console.log(`✓ Backed up state.json → ${dest} (${kb} KB)`);
  return dest;
}

// ---- App-side device inventory ---------------------------------------------

/**
 * Device ids the app already knows, with any name/category context available.
 * Mirrors the ops-device-forensics approach: read the structured maps, then
 * sweep every bf-token in the whole state blob so scene/room/schedule-only
 * references are counted too (those are exactly the ones that silently orphan).
 */
function knownDevices(state) {
  const byId = new Map();
  const add = (id, patch = {}) => {
    if (!/^bf[0-9a-z]{15,25}$/.test(id)) return;
    const cur = byId.get(id) || { id, name: '', category: '' };
    byId.set(id, { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v)) });
  };

  const configured = state?.deviceOnboarding?.configured || {};
  for (const [id, v] of Object.entries(configured)) {
    add(id, { name: v?.name || v?.label, category: v?.category || v?.type });
  }
  const settings = state?.deviceSettings || {};
  for (const [id, v] of Object.entries(settings)) add(id, { name: v?.name, category: v?.category });

  const txt = JSON.stringify(state ?? {});
  for (const m of txt.matchAll(/bf[0-9a-z]{15,25}/g)) add(m[0]);

  return [...byId.values()];
}

/** Count how many times an id is referenced outside the device maps — a proxy
 *  for "how much configuration would orphan if this id disappeared". */
function referenceCount(state, id) {
  const txt = JSON.stringify(state ?? {});
  return (txt.match(new RegExp(id, 'g')) || []).length;
}

// ---- 2) Harvest -------------------------------------------------------------

function loadCreds(state) {
  const t = state?.integrations?.tuya || {};
  const accessId = (t.accessId || process.env.TUYA_ACCESS_ID || '').trim();
  const accessSecret = t.accessSecret || process.env.TUYA_ACCESS_SECRET || '';
  const region = (t.region || process.env.TUYA_REGION || 'eu').trim().toLowerCase();
  if (!accessId || !accessSecret || !REGION_HOSTS[region]) return null;
  return { accessId, accessSecret, region, host: REGION_HOSTS[region] };
}

function makeCloud(creds) {
  const hmac = (str) =>
    crypto.createHmac('sha256', creds.accessSecret).update(str, 'utf8').digest('hex').toUpperCase();
  let token = '';
  let calls = 0;

  async function signedGet(p, withToken) {
    calls += 1;
    const t = Date.now().toString();
    const stringToSign = ['GET', EMPTY_SHA256, '', p].join('\n');
    const signStr = withToken
      ? creds.accessId + token + t + stringToSign
      : creds.accessId + t + stringToSign;
    const headers = {
      client_id: creds.accessId,
      sign: hmac(signStr),
      t,
      sign_method: 'HMAC-SHA256',
      nonce: '',
    };
    if (withToken) headers.access_token = token;
    const res = await fetch(creds.host + p, { headers, signal: AbortSignal.timeout(15_000) });
    return res.json();
  }

  return {
    callCount: () => calls,
    async connect() {
      const tok = await signedGet('/v1.0/token?grant_type=1', false);
      if (!tok.success) throw new Error(`token: ${tok.msg} (code ${tok.code})`);
      token = tok.result.access_token;
    },
    /** Paged associated-users listing — the cheapest source of local_key. */
    async listDevices() {
      const out = [];
      let lastRowKey = '';
      for (let page = 0; page < 25; page++) {
        const q = lastRowKey ? `?last_row_key=${encodeURIComponent(lastRowKey)}` : '';
        const r = await signedGet(`/v1.0/iot-01/associated-users/devices${q}`, true);
        if (!r.success) throw new Error(`listDevices: ${r.msg} (code ${r.code})`);
        for (const d of r.result?.devices ?? []) out.push(d);
        if (!r.result?.has_more || !r.result?.last_row_key) break;
        lastRowKey = r.result.last_row_key;
      }
      return out;
    },
    /** Per-device detail — used only to fill in a missing ip. */
    async deviceDetail(id) {
      const r = await signedGet(`/v1.0/devices/${id}`, true);
      return r.success ? r.result : null;
    },
  };
}

function normalize(raw) {
  return {
    id: raw.id,
    name: raw.name || '',
    category: raw.category || '',
    ip: raw.ip || '',
    localKey: raw.local_key || '',
    // Zigbee/BLE sub-devices sit behind a gateway and are never reachable at
    // TCP 6668 — they must stay cloud-controlled regardless of key/ip.
    sub: raw.sub === true,
    online: raw.online === true,
    productId: raw.product_id || '',
  };
}

// ---- 3) Report --------------------------------------------------------------

function pad(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str.padEnd(n);
}

async function main() {
  console.log(`\nTuya harvest · DATA_DIR=${DATA_DIR}\n${'='.repeat(72)}\n`);

  backupState();

  const state = readJson(STATE_FILE);
  if (!state) {
    console.error(`✗ Could not read ${STATE_FILE} — aborting.`);
    process.exit(1);
  }

  const known = knownDevices(state);
  console.log(`  App knows ${known.length} device id(s) from state.json.`);

  const cache = readJson(CACHE_FILE) || { devices: [] };
  let harvested = Array.isArray(cache.devices) ? cache.devices : [];
  let harvestNote = 'cache only (--no-harvest)';

  if (!NO_HARVEST) {
    const creds = loadCreds(state);
    if (!creds) {
      harvestNote = 'SKIPPED — no Tuya credentials in state.json or env';
      console.log(`\n! Harvest ${harvestNote}.`);
      console.log('  Enter them in Settings → Connections → Tuya, then re-run.');
    } else {
      console.log(`\n  Cloud: region=${creds.region} client_id=${creds.accessId}`);
      const cloud = makeCloud(creds);
      try {
        await cloud.connect();
        const raw = await cloud.listDevices();
        harvested = raw.map(normalize);

        // Fill in any missing ip via the per-device detail (skip sub-devices,
        // which have no LAN ip of their own).
        const needIp = harvested.filter((d) => !d.ip && !d.sub);
        for (const d of needIp) {
          const detail = await cloud.deviceDetail(d.id);
          if (detail?.ip) d.ip = detail.ip;
          if (!d.localKey && detail?.local_key) d.localKey = detail.local_key;
        }

        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(
          CACHE_FILE,
          JSON.stringify({ harvestedAt: new Date().toISOString(), devices: harvested }, null, 2),
        );
        harvestNote = `OK — ${harvested.length} device(s), ${cloud.callCount()} cloud call(s)`;
        console.log(`✓ Harvest ${harvestNote}`);
        console.log(`✓ Cached → ${CACHE_FILE}`);
      } catch (e) {
        harvestNote = `FAILED — ${e.message}`;
        console.log(`✗ Harvest ${harvestNote}`);
        console.log('  Falling back to any previously cached credentials.');
      }
    }
  }

  // ---- Reconciliation ------------------------------------------------------
  const cloudById = new Map(harvested.map((d) => [d.id, d]));
  const knownIds = new Set(known.map((d) => d.id));

  const matched = harvested.filter((d) => knownIds.has(d.id));
  const newInCloud = harvested.filter((d) => !knownIds.has(d.id));
  const orphaned = known.filter((d) => !cloudById.has(d.id));

  console.log(`\n${'='.repeat(72)}\nRECONCILIATION\n${'='.repeat(72)}`);
  console.log(`  matched (app ↔ cloud) : ${matched.length}`);
  console.log(`  new in cloud only     : ${newInCloud.length}  → need onboarding`);
  console.log(`  in app, missing cloud : ${orphaned.length}  → config would orphan`);

  if (harvested.length) {
    const withKey = harvested.filter((d) => d.localKey).length;
    const withIp = harvested.filter((d) => d.ip).length;
    const lanReady = harvested.filter((d) => d.localKey && d.ip && !d.sub).length;
    const subs = harvested.filter((d) => d.sub).length;
    console.log(`\n  local_key present     : ${withKey}/${harvested.length}`);
    console.log(`  ip present            : ${withIp}/${harvested.length}`);
    console.log(`  LAN-ready (key+ip)    : ${lanReady}`);
    console.log(`  gateway sub-devices   : ${subs}  → stay cloud-controlled by design`);
  }

  if (orphaned.length) {
    console.log(`\n-- In app but NOT in the cloud account (ordered by config impact) --`);
    const ranked = orphaned
      .map((d) => ({ ...d, refs: referenceCount(state, d.id) }))
      .sort((a, b) => b.refs - a.refs);
    for (const d of ranked) {
      console.log(`   ${pad(d.name || d.id, 34)} ${pad(d.category, 8)} ${d.id}  refs=${d.refs}`);
    }
  }

  if (newInCloud.length) {
    console.log(`\n-- In the cloud but NOT yet known to the app --`);
    for (const d of newInCloud) {
      const flags = [d.sub ? 'sub' : '', d.localKey ? 'key' : 'NOKEY', d.ip ? d.ip : 'no-ip']
        .filter(Boolean)
        .join(' ');
      console.log(`   ${pad(d.name || d.id, 34)} ${pad(d.category, 8)} ${d.id}  ${flags}`);
    }
  }

  if (matched.length) {
    console.log(`\n-- Matched devices (LAN readiness) --`);
    for (const d of matched) {
      const status = d.sub ? 'gateway sub-device' : d.localKey && d.ip ? `LAN-ready @ ${d.ip}` : d.localKey ? 'key, no ip' : 'NO KEY';
      console.log(`   ${pad(d.name || d.id, 34)} ${pad(d.category, 8)} ${status}`);
    }
  }

  // The headline: did the ids survive the account switch?
  console.log(`\n${'='.repeat(72)}`);
  if (harvested.length && orphaned.length === 0) {
    console.log('VERDICT: every app-known device id exists in the cloud account —');
    console.log('         rooms, scenes, schedules and automations all reattach. Nothing lost.');
  } else if (harvested.length && matched.length === 0) {
    console.log('VERDICT: NO app-known id exists in the cloud account — the devices were');
    console.log('         re-paired, so every id changed. App config needs remapping by name.');
  } else if (harvested.length) {
    console.log(`VERDICT: PARTIAL — ${matched.length} id(s) preserved, ${orphaned.length} missing.`);
    console.log('         Review the orphan list above before re-onboarding anything.');
  } else {
    console.log('VERDICT: no cloud data this run — backup completed, reconciliation skipped.');
  }
  console.log(`${'='.repeat(72)}\n`);
}

await main();
