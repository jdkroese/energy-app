// Tuya LAN discovery + read-only local probe (docs/44 Phase 1, second half).
//
// WHY THIS EXISTS: the cloud harvest (scripts/tuya-harvest.mjs) gives us every
// device's `local_key` — the one secret only the cloud can provide — but the `ip`
// field it returns is the device's PUBLIC/WAN address as seen by Tuya's servers,
// not its address on our network. Those are useless for local control. The real
// LAN address has to come from the devices themselves.
//
// Every Tuya Wi-Fi device UDP-broadcasts an announcement on port 6666 (v3.1) and
// 6667 (v3.3+). Crucially that broadcast is encrypted with a WELL-KNOWN STATIC
// key (md5 of "yGAdlopoPVldABfn") — not the per-device local_key — so anyone on
// the LAN can decode it. That yields {id -> lan ip, protocol version} for free,
// with no cloud call, and it self-heals when DHCP moves a device.
//
// Steps:
//   1) LISTEN   — passively collect broadcasts on 6666+6667 for a window.
//                 Receive-only: nothing is transmitted, nothing is actuated.
//   2) MERGE    — join discovered LAN ips against the harvested local_keys and
//                 write the enriched map back to .data/tuya-local.json (adding
//                 `lanIp` and `version`; the cloud's WAN `ip` is kept separate so
//                 the two are never confused again).
//   3) PROBE    — for each device with local_key + LAN ip, open a local session
//                 and READ its datapoints. Strictly read-only; no device is ever
//                 written to by this script. Needs `tuyapi` on NODE_PATH; if it
//                 is absent, discovery and merge still run and the probe is
//                 reported as skipped.
//
// Run (on the mini, which shares the devices' LAN):
//   node scripts/tuya-lan-discover.mjs             # ~75s listen, then probe
//   LISTEN_SEC=120 node scripts/tuya-lan-discover.mjs

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DATA_DIR = process.env.DATA_DIR || '/Users/joris/sites/energy/.data';
const CACHE_FILE = path.join(DATA_DIR, 'tuya-local.json');
const LISTEN_SEC = Number(process.env.LISTEN_SEC || 75);
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 8000);

// The static key every Tuya device uses to encrypt its discovery broadcast.
const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pad(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str.padEnd(n);
}

// ---- 1) Discovery -----------------------------------------------------------

/**
 * Pull the JSON announcement out of a Tuya discovery datagram.
 * Tolerant by design: firmware varies in whether the payload is plaintext (older
 * 3.1 on 6666) or AES-ECB encrypted (3.3+ on 6667), and in whether a 4-byte
 * return code sits between the 16-byte header and the body. Try the cheap
 * plaintext read first, then both header offsets for the encrypted case.
 */
function parseDiscovery(buf) {
  // (a) Plaintext JSON somewhere in the frame (older v3.1 broadcasts).
  const open = buf.indexOf(0x7b); // '{'
  const close = buf.lastIndexOf(0x7d); // '}'
  if (open !== -1 && close > open) {
    try {
      return JSON.parse(buf.subarray(open, close + 1).toString('utf8'));
    } catch {
      /* fall through to the encrypted paths */
    }
  }

  // (b) AES-128-ECB with the static UDP key. Offset 20 covers frames carrying a
  //     return code; offset 16 covers those that don't.
  for (const start of [20, 16]) {
    if (buf.length <= start + 8) continue;
    const body = buf.subarray(start, buf.length - 8);
    if (body.length === 0 || body.length % 16 !== 0) continue;
    try {
      const d = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, null);
      d.setAutoPadding(true);
      const out = Buffer.concat([d.update(body), d.final()]).toString('utf8');
      return JSON.parse(out);
    } catch {
      /* try the next offset */
    }
  }
  return null;
}

function listen(seconds) {
  return new Promise((resolve) => {
    const found = new Map(); // id -> { lanIp, version, active, encrypt, productKey, hits }
    const sockets = [];

    for (const port of [6666, 6667]) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', (e) => {
        console.log(`  ! UDP ${port} error: ${e.message}`);
        try {
          sock.close();
        } catch {
          /* already closed */
        }
      });
      sock.on('message', (msg) => {
        const info = parseDiscovery(msg);
        const id = info?.gwId || info?.devId;
        if (!info || !id) return;
        const prev = found.get(id);
        found.set(id, {
          lanIp: info.ip || prev?.lanIp || '',
          version: info.version || prev?.version || '',
          // Tuya's own firmware ships this field name misspelled.
          ability: info.ablilty ?? info.ability ?? prev?.ability,
          active: info.active ?? prev?.active,
          encrypt: info.encrypt ?? prev?.encrypt,
          productKey: info.productKey || prev?.productKey || '',
          hits: (prev?.hits || 0) + 1,
        });
        if (!prev) {
          console.log(`  + ${pad(id, 28)} ${pad(info.ip || '?', 16)} v${info.version || '?'} (port ${port})`);
        }
      });
      sock.bind(port, () => {
        try {
          sock.setBroadcast(true);
        } catch {
          /* not fatal — we only ever receive */
        }
      });
      sockets.push(sock);
    }

    setTimeout(() => {
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          /* already closed */
        }
      }
      resolve(found);
    }, seconds * 1000).unref?.();
  });
}

// ---- 2b) TCP sweep + key identification -------------------------------------
//
// UDP discovery misses devices whose broadcast never reaches us — common on
// mesh/multi-AP networks, where the AP does not forward the device's broadcast
// to our segment even though TCP routes fine. Those devices look identical to
// "powered off" from discovery alone, so we sweep the subnet for open 6668 and
// then identify each responder by trying the local_keys we hold: a key only
// completes the handshake with its own device, so a successful read IS the
// identification. Read-only throughout.

/** Every /24 this host sits on (usually one). */
function localSubnets() {
  const nets = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) nets.add(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...nets];
}

function tcpOpen(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
    s.connect(port, ip);
  });
}

/** Run tasks with bounded concurrency so a /24 sweep stays fast but polite. */
async function pooled(items, limit, worker) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx], idx);
      }
    }),
  );
  return out;
}

async function sweepForOpenPorts(claimed) {
  const subnets = localSubnets();
  if (!subnets.length) return [];
  const candidates = [];
  for (const base of subnets) {
    for (let h = 1; h <= 254; h++) {
      const ip = `${base}.${h}`;
      if (!claimed.has(ip)) candidates.push(ip);
    }
  }
  console.log(`  sweeping ${candidates.length} address(es) across ${subnets.join(', ')}.0/24 for port 6668…`);
  const results = await pooled(candidates, 64, async (ip) => ((await tcpOpen(ip, 6668, 3000)) ? ip : null));
  return results.filter(Boolean);
}

/**
 * Match unidentified devices to unclaimed ips by attempting an authenticated
 * read: a local_key only completes the handshake with its own device, so a
 * successful read IS the identification.
 *
 * Addresses are tested CONCURRENTLY — serially this is ips x devices x versions
 * attempts, which for a real fleet overruns the CI job timeout. A device id is
 * claimed the instant it matches so two addresses can never adopt the same
 * device, and each attempt uses a short timeout since a wrong key fails fast.
 */
async function identifyByKey(TuyAPI, ips, devices) {
  const found = new Map(); // ip -> device
  const claimed = new Set(); // device ids already matched
  const ID_TIMEOUT_MS = Number(process.env.IDENTIFY_TIMEOUT_MS || 3500);

  await pooled(ips, 8, async (ip) => {
    for (const dev of devices) {
      if (claimed.has(dev.id)) continue;
      // The broadcast never reached us, so the protocol version is unknown —
      // try both versions this fleet actually runs.
      for (const version of ['3.4', '3.3']) {
        if (claimed.has(dev.id)) break;
        const r = await probeDevice(TuyAPI, { ...dev, lanIp: ip, version }, ID_TIMEOUT_MS);
        if (r.ok) {
          claimed.add(dev.id);
          found.set(ip, { ...dev, lanIp: ip, version });
          return;
        }
      }
    }
  });
  return found;
}

// ---- 3) Read-only local probe ----------------------------------------------

function loadTuyapi() {
  try {
    // tuyapi is CommonJS and lives in a scratch dir exposed via NODE_PATH, which
    // a bare ESM `import` ignores — createRequire is what actually honours it.
    const require = createRequire(import.meta.url);
    return require('tuyapi');
  } catch {
    return null;
  }
}

async function probeDevice(TuyAPI, dev, timeoutMs = PROBE_TIMEOUT_MS) {
  const device = new TuyAPI({
    id: dev.id,
    key: dev.localKey,
    ip: dev.lanIp,
    version: dev.version || '3.3',
    issueGetOnConnect: false,
  });
  // tuyapi throws an unhandled 'error' on socket timeout unless a listener exists.
  device.on('error', () => {});

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), timeoutMs),
  );
  try {
    await Promise.race([device.connect(), timeout]);
    const status = await Promise.race([device.get({ schema: true }), timeout]);
    const dps = status?.dps ?? status;
    const count = dps && typeof dps === 'object' ? Object.keys(dps).length : 0;
    return { ok: true, dpCount: count };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    try {
      device.disconnect();
    } catch {
      /* already down */
    }
  }
}

// ---- Main -------------------------------------------------------------------

async function main() {
  console.log(`\nTuya LAN discovery · DATA_DIR=${DATA_DIR}\n${'='.repeat(72)}\n`);

  const cache = readJson(CACHE_FILE);
  const devices = Array.isArray(cache?.devices) ? cache.devices : [];
  if (!devices.length) {
    console.error(`✗ No harvested devices in ${CACHE_FILE}. Run scripts/tuya-harvest.mjs first.`);
    process.exit(1);
  }
  const byId = new Map(devices.map((d) => [d.id, d]));
  console.log(`  ${devices.length} harvested device(s); ${devices.filter((d) => d.localKey).length} with a local_key.`);
  console.log(`\nListening on UDP 6666 + 6667 for ${LISTEN_SEC}s (receive-only)…\n`);

  const found = await listen(LISTEN_SEC);

  console.log(`\n${'='.repeat(72)}\nDISCOVERY\n${'='.repeat(72)}`);
  console.log(`  devices heard on the LAN : ${found.size}`);

  // ---- 2) Merge back into the cache ---------------------------------------
  let enriched = 0;
  let unknown = 0;
  for (const [id, info] of found) {
    const dev = byId.get(id);
    if (!dev) {
      unknown += 1;
      continue;
    }
    dev.lanIp = info.lanIp;
    dev.version = info.version;
    dev.productKey = dev.productKey || info.productKey;
    enriched += 1;
  }
  console.log(`  matched to harvested keys: ${enriched}`);
  console.log(`  heard but not harvested  : ${unknown}`);

  const versions = new Map();
  for (const info of found.values()) versions.set(info.version || '?', (versions.get(info.version || '?') || 0) + 1);
  if (versions.size) {
    console.log(`  protocol versions        : ${[...versions.entries()].map(([v, n]) => `v${v}×${n}`).join(', ')}`);
  }

  fs.writeFileSync(
    CACHE_FILE,
    JSON.stringify({ ...cache, discoveredAt: new Date().toISOString(), devices }, null, 2),
  );
  console.log(`\n✓ Cache updated with LAN ips → ${CACHE_FILE}`);

  // Devices we hold a key for but never heard from.
  const silent = devices.filter((d) => d.localKey && !d.lanIp && !d.sub);
  if (silent.length) {
    console.log(`\n-- Harvested but silent on the LAN (${silent.length}) --`);
    for (const d of silent) console.log(`   ${pad(d.name || d.id, 34)} ${pad(d.category, 8)} ${d.id}`);
  }

  const TuyAPI = loadTuyapi();

  // ---- 2b) Sweep for devices UDP never reached -----------------------------
  const stillMissing = devices.filter((d) => d.localKey && !d.lanIp && !d.sub);
  if (TuyAPI && stillMissing.length && process.env.SKIP_SWEEP !== '1') {
    console.log(`\n${'='.repeat(72)}\nTCP SWEEP (devices UDP did not reach)\n${'='.repeat(72)}`);
    const claimed = new Set(devices.map((d) => d.lanIp).filter(Boolean));
    const openIps = await sweepForOpenPorts(claimed);
    console.log(`  ${openIps.length} unclaimed host(s) with port 6668 open.`);
    if (openIps.length) {
      console.log(`  identifying by local_key against ${stillMissing.length} unlocated device(s)…`);
      const identified = await identifyByKey(TuyAPI, openIps, stillMissing);
      for (const [ip, dev] of identified) {
        const target = byId.get(dev.id);
        if (target) {
          target.lanIp = ip;
          target.version = dev.version;
        }
        console.log(`   ✓ ${pad(dev.name || dev.id, 32)} → ${pad(ip, 16)} v${dev.version}`);
      }
      console.log(`\n  identified ${identified.size}/${openIps.length} swept host(s).`);
      fs.writeFileSync(
        CACHE_FILE,
        JSON.stringify({ ...cache, sweptAt: new Date().toISOString(), devices }, null, 2),
      );
      console.log(`✓ Cache updated with swept ips → ${CACHE_FILE}`);
    }
  }

  // ---- 3) Probe ------------------------------------------------------------
  const probeable = devices.filter((d) => d.localKey && d.lanIp && !d.sub);
  console.log(`\n${'='.repeat(72)}\nLOCAL READ PROBE (read-only)\n${'='.repeat(72)}`);
  if (!TuyAPI) {
    console.log('  SKIPPED — tuyapi not on NODE_PATH. Discovery + merge completed above.');
  } else if (!probeable.length) {
    console.log('  SKIPPED — no device has both a local_key and a discovered LAN ip.');
  } else {
    let ok = 0;
    for (const d of probeable) {
      const r = await probeDevice(TuyAPI, d);
      if (r.ok) ok += 1;
      const verdict = r.ok ? `OK   ${r.dpCount} datapoints` : `FAIL ${r.error}`;
      console.log(`   ${pad(d.name || d.id, 30)} ${pad(d.lanIp, 16)} v${pad(d.version || '?', 4)} ${verdict}`);
    }
    console.log(`\n  locally readable: ${ok}/${probeable.length}`);
  }

  console.log(`\n${'='.repeat(72)}`);
  const lanReady = devices.filter((d) => d.localKey && d.lanIp && !d.sub).length;
  console.log(`VERDICT: ${lanReady}/${devices.length} device(s) have local_key + LAN ip — the pair`);
  console.log('         local control needs. Anything silent above is powered off, on another');
  console.log('         subnet, or a gateway sub-device that is cloud-only by design.');
  console.log(`${'='.repeat(72)}\n`);
}

await main();
