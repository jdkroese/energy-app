// Prove the LOCAL WRITE path works against real hardware — safely.
//
// Reads and the v3.5 framing math are already proven (live tinytuya probe + unit
// tests), but the CONTROL_NEW *write* envelope was ported by hand-tracing Python
// and has never touched a device. That is the one piece that could silently be
// wrong, so it needs a real test — but a home-automation fleet is a bad place to
// experiment.
//
// The trick: write a datapoint back with the value it ALREADY HAS. That is a
// genuine CONTROL_NEW round trip (same envelope, same crypto, same ack path) with
// no observable effect — a light that is on stays on. If the write succeeds the
// envelope is correct; if it throws we learn that without having actuated anything.
//
// Breakers are refused outright: they de-energise real circuits (car charger,
// heat pump), and there is no reason to prove a point on those when any lamp
// answers the same question.
//
// Usage (on the mini): node --import tsx scripts/tuya-local-writetest.mjs <deviceId>

import {
  reloadRegistry,
  readStatus,
  sendCommands,
  isLocalCapable,
} from '../apps/api/src/connectors/tuya-local.ts';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/Users/joris/sites/energy/.data';
// Circuit breakers — never write-tested. 'dlq' is the breaker category.
const BLOCKED_CATEGORIES = new Set(['dlq']);

const id = (process.argv[2] || '').trim();
if (!id) {
  console.error('usage: tuya-local-writetest.mjs <deviceId>');
  process.exit(1);
}

const cache = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tuya-local.json'), 'utf8'));
const dev = (cache.devices || []).find((d) => d.id === id);
if (!dev) {
  console.error(`device ${id} not in the registry`);
  process.exit(1);
}
if (BLOCKED_CATEGORIES.has(dev.category)) {
  console.error(`REFUSED: ${dev.name} is category '${dev.category}' (circuit breaker) — not write-tested.`);
  process.exit(1);
}

reloadRegistry();
console.log(`\nDevice : ${dev.name} (${dev.category})`);
console.log(`Address: ${dev.lanIp}  protocol v${dev.version}`);
console.log(`Local capable: ${isLocalCapable(id)}\n`);

const before = await readStatus(id);
console.log('READ  before:', JSON.stringify(before));

// Prefer a boolean dp (a switch echoes cleanly); fall back to any numeric one.
const entries = Object.entries(before);
let pick = entries.find(([, v]) => typeof v === 'boolean') || entries.find(([, v]) => typeof v === 'number');
if (!pick) {
  console.error('no boolean/numeric datapoint to safely echo — aborting');
  process.exit(1);
}
const [dpIndex, currentValue] = pick;

console.log(`\nWRITE : dp ${dpIndex} = ${JSON.stringify(currentValue)}  (its CURRENT value — no change)`);
const code = 'echo_probe';
await sendCommands(id, [{ code, value: currentValue }], new Map([[code, Number(dpIndex)]]));
console.log('WRITE : accepted by the device');

const after = await readStatus(id);
console.log('READ  after :', JSON.stringify(after));

const unchanged = JSON.stringify(after[dpIndex]) === JSON.stringify(currentValue);
console.log(`\n${unchanged ? 'PASS' : 'FAIL'} — dp ${dpIndex} is ${JSON.stringify(after[dpIndex])}, expected ${JSON.stringify(currentValue)}`);
console.log(unchanged
  ? 'Local CONTROL_NEW write path works end to end, and nothing was actuated.'
  : 'Write round-tripped but the value moved — investigate before enabling the flag.');
process.exit(unchanged ? 0 : 1);
