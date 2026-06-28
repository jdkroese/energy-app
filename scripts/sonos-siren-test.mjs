#!/usr/bin/env node
// Sonos siren smoke-test — run ON THE MINI. Plays the bundled alarm clip on ONE speaker
// for ~5s via PlayNotification, then lets it restore prior playback. Confirms discovery +
// the LAN media URL + PlayNotification all work end-to-end before trusting the whole-house
// alarm.
//
// Usage (from repo root):
//   node scripts/sonos-siren-test.mjs <uuid-or-ip> [mediaUrl] [seedIp]
//
//   <uuid-or-ip>  the target speaker — its UUID (RINCON_…) or its host IP.
//   [mediaUrl]    URL the speaker fetches the clip from. Defaults to LAN_BASE_URL +
//                 /api/media/alarm.wav, else http://<this-host-LAN-ip>:3002/api/media/alarm.wav.
//                 MUST be reachable from the speaker (the mini's LAN IP:port, not localhost).
//   [seedIp]      optional seed IP for topology discovery on a multi-NIC host.
//
// Examples:
//   node scripts/sonos-siren-test.mjs 192.168.1.150
//   node scripts/sonos-siren-test.mjs RINCON_XXXX http://192.168.1.149:3002/api/media/alarm.wav 192.168.1.149

import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../apps/api/package.json'));
const { SonosManager } = require('@svrooij/sonos');

const target = process.argv[2];
let mediaUrl = process.argv[3];
const seedIp = process.argv[4] || process.argv[2]; // if target is an IP it can seed too

if (!target) {
  console.error('Usage: node scripts/sonos-siren-test.mjs <uuid-or-ip> [mediaUrl] [seedIp]');
  process.exit(1);
}

function lanIp() {
  for (const ifs of Object.values(networkInterfaces())) {
    for (const i of ifs ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

if (!mediaUrl) {
  const base = (process.env.LAN_BASE_URL || `http://${lanIp()}:${process.env.API_PORT || 3002}`).replace(/\/+$/, '');
  mediaUrl = `${base}/api/media/alarm.wav`;
}

const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(target);

async function main() {
  const m = new SonosManager();
  // Topology discovery from a seed IP is the robust path; fall back to multicast.
  const ok = isIp ? await m.InitializeFromDevice(target) : (seedIp ? await m.InitializeFromDevice(seedIp) : await m.InitializeWithDiscovery(5));
  if (!ok || m.Devices.length === 0) {
    console.error('No Sonos devices found. Pass a seed IP as the 3rd arg on a multi-NIC host.');
    process.exit(1);
  }

  const device = m.Devices.find((d) => d.Uuid === target || d.Host === target) ?? m.Devices[0];
  console.log(`Target: ${device.Name} (uuid=${device.Uuid}, host=${device.Host})`);
  console.log(`Media:  ${mediaUrl}`);
  console.log('Playing siren for ~5s …');

  const played = await device.PlayNotification({
    trackUri: mediaUrl,
    onlyWhenPlaying: false,
    volume: 35,
    timeout: 5,
    delayMs: 100,
  });

  console.log(played ? '✓ Notification played and playback restored.' : '✗ Notification did not confirm — check the media URL is reachable from the speaker.');
  try { m.CancelSubscription(); } catch { /* ignore */ }
  process.exit(played ? 0 : 2);
}

main().catch((e) => {
  console.error('Siren test failed:', e.message);
  process.exit(1);
});
