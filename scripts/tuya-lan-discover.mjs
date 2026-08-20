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

async function probeDevice(TuyAPI, dev) {
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
    setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS),
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

  // ---- 3) Probe ------------------------------------------------------------
  const TuyAPI = loadTuyapi();
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
