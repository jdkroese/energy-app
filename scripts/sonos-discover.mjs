#!/usr/bin/env node
// Sonos discovery probe — run ON THE MINI (same LAN as the speakers). Prints every
// discovered player (name, uuid, host, group, volume), then exits.
//
// Usage (from repo root or apps/api):
//   node scripts/sonos-discover.mjs [seedIp]
//
//   - With a seed IP (RECOMMENDED on a multi-NIC host): topology-based discovery from
//     that one speaker — reliably finds ALL zones even when SSDP multicast is blocked.
//       node scripts/sonos-discover.mjs 192.168.1.149
//   - Without args: SSDP multicast discovery (zero-config; works on a simple LAN).
//
// Requires @svrooij/sonos (installed in apps/api). Resolve it from there.

import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../apps/api/package.json'));
const { SonosManager } = require('@svrooij/sonos');

const seedIp = process.argv[2];

async function main() {
  const m = new SonosManager();
  let ok = false;
  if (seedIp) {
    console.log(`Discovering via topology from seed ${seedIp} …`);
    ok = await m.InitializeFromDevice(seedIp);
  } else {
    console.log('Discovering via SSDP multicast (5s) …  (pass a seed IP if nothing is found)');
    ok = await m.InitializeWithDiscovery(5);
  }

  if (!ok || m.Devices.length === 0) {
    console.error('No Sonos devices found.');
    if (!seedIp) console.error('Tip: on a multi-NIC host pass a seed IP, e.g. node scripts/sonos-discover.mjs 192.168.1.149');
    process.exit(1);
  }

  console.log(`\nFound ${m.Devices.length} player(s):\n`);
  for (const d of m.Devices) {
    let vol = null;
    try {
      const r = await d.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' });
      vol = r.CurrentVolume;
    } catch { /* ignore */ }
    let coord = '?';
    try { coord = d.Coordinator?.Uuid === d.Uuid ? 'COORDINATOR' : `→ ${d.Coordinator?.Name ?? '?'}`; } catch { /* ignore */ }
    console.log(`  • ${d.Name.padEnd(18)} uuid=${d.Uuid}  host=${d.Host.padEnd(15)}  group=${(d.GroupName ?? '').padEnd(16)}  vol=${vol ?? '?'}  ${coord}`);
  }

  // Distinct group coordinators = how many PlayNotification calls the siren makes.
  const coords = new Set();
  for (const d of m.Devices) {
    try { coords.add(d.Coordinator?.Uuid ?? d.Uuid); } catch { coords.add(d.Uuid); }
  }
  console.log(`\n${coords.size} group coordinator(s) — the siren fires one notification per group.`);

  try { m.CancelSubscription(); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((e) => {
  console.error('Discovery failed:', e.message);
  process.exit(1);
});
