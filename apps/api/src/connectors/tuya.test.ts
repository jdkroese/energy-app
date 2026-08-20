// Unit tests for the Tuya cloud connector's pure helpers. Run from apps/api:
//   node --import tsx --test src/connectors/tuya.test.ts
//
// Importing tuya.ts pulls in tuya-local.ts, which at import time reads the store and (when
// local is enabled) starts a UDP discovery listener. So — exactly like tuya-local.test.ts —
// we point the store at a scratch file and hard-disable local via the env kill-switch BEFORE
// the dynamic import, so this suite never opens sockets or touches the real state.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuya-test-'));
process.env.DATA_DIR = scratchDir;
process.env.STATE_FILE = path.join(scratchDir, 'state.json');
process.env.TUYA_LOCAL_ENABLED = '0';

const { parseThingModelDpMap, normCode } = await import('./tuya');

// A real Tuya thing-model payload (trimmed) for a `cz` metering plug — the `model` field is
// itself a JSON string, and each property carries `abilityId` (the local dp number).
const REAL_MODEL = JSON.stringify({
  services: [
    {
      properties: [
        { abilityId: 1, code: 'switch_1', typeSpec: { type: 'bool' } },
        { abilityId: 9, code: 'countdown_1', typeSpec: { type: 'value' } },
        { abilityId: 19, code: 'cur_power', typeSpec: { type: 'value' } },
        { abilityId: 20, code: 'cur_voltage', typeSpec: { type: 'value' } },
        { abilityId: 51, code: 'overcharge_switch', typeSpec: { type: 'bool' } },
      ],
    },
  ],
});

test('parseThingModelDpMap maps each code to its abilityId (the local dp)', () => {
  const map = parseThingModelDpMap(REAL_MODEL);
  assert.equal(map.get('switch_1'), 1);
  assert.equal(map.get('cur_power'), 19);
  assert.equal(map.get('cur_voltage'), 20);
  assert.equal(map.get('overcharge_switch'), 51);
  assert.equal(map.size, 5);
});

test('parseThingModelDpMap flattens properties across multiple services', () => {
  const model = JSON.stringify({
    services: [
      { properties: [{ abilityId: 1, code: 'switch_led' }] },
      { properties: [{ abilityId: 22, code: 'bright_value' }] },
    ],
  });
  const map = parseThingModelDpMap(model);
  assert.equal(map.get('switch_led'), 1);
  assert.equal(map.get('bright_value'), 22);
});

test('parseThingModelDpMap tolerates junk without throwing', () => {
  assert.equal(parseThingModelDpMap('not json').size, 0);
  assert.equal(parseThingModelDpMap('{}').size, 0);
  assert.equal(parseThingModelDpMap(JSON.stringify({ services: [] })).size, 0);
  assert.equal(parseThingModelDpMap(JSON.stringify({ services: [{}] })).size, 0);
});

test('parseThingModelDpMap skips properties missing code or a numeric abilityId', () => {
  const model = JSON.stringify({
    services: [
      {
        properties: [
          { abilityId: 1, code: 'switch_1' }, // kept
          { code: 'no_ability' }, // no abilityId -> skipped
          { abilityId: 7 }, // no code -> skipped
          { abilityId: '3', code: 'string_ability' }, // abilityId not a number -> skipped
        ],
      },
    ],
  });
  const map = parseThingModelDpMap(model);
  assert.equal(map.size, 1);
  assert.equal(map.get('switch_1'), 1);
});

test('normCode collapses transposed code spellings for the same datapoint', () => {
  // The exact real-world mismatch: cloud spec says switch_led_1, thing model says led_switch_1.
  assert.equal(normCode('switch_led_1'), normCode('led_switch_1'));
  assert.equal(normCode('switch_led_1'), '1_led_switch');
});

test('normCode is case- and separator-insensitive but keeps distinct codes distinct', () => {
  assert.equal(normCode('Bright_Value_1'), normCode('bright value 1'));
  assert.notEqual(normCode('switch_1'), normCode('switch_2'));
  assert.notEqual(normCode('switch_led_1'), normCode('bright_value_1'));
});
