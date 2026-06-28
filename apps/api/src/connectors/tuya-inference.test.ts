// Unit tests for Tuya onboarding inference — run with the Node built-in test
// runner via tsx:  node --import tsx --test src/connectors/tuya-inference.test.ts
// (apps/api has no formal test-runner script; tsx is a devDependency.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveCapabilities, deriveConfidence } from './tuya-inference';
import type { TuyaDevice, TuyaSpec } from './tuya';

function device(partial: Partial<TuyaDevice>): TuyaDevice {
  return {
    id: 'dev1',
    name: 'Ceiling fan',
    category: 'fsd',
    online: true,
    status: [],
    ...partial,
  };
}

test('fsd fan spec yields switch / range / enum capabilities', () => {
  const spec: TuyaSpec = {
    category: 'fsd',
    functions: [
      { code: 'fan_switch', type: 'Boolean', values: '{}' },
      { code: 'fan_speed', type: 'Integer', values: '{"min":1,"max":5}' },
      { code: 'fan_direction', type: 'Enum', values: '{"range":["forward","reverse"]}' },
    ],
    status: [],
  };
  const caps = deriveCapabilities(device({}), spec);

  assert.equal(caps.length, 3, 'all three DPs become capabilities');

  const power = caps.find((c) => c.dp === 'fan_switch');
  assert.ok(power, 'fan_switch present');
  assert.equal(power.kind, 'switch');
  assert.equal(power.readOnly, false);

  const speed = caps.find((c) => c.dp === 'fan_speed');
  assert.ok(speed, 'fan_speed present');
  assert.equal(speed.kind, 'range');
  assert.equal(speed.min, 1);
  assert.equal(speed.max, 5);

  const dir = caps.find((c) => c.dp === 'fan_direction');
  assert.ok(dir, 'fan_direction present');
  assert.equal(dir.kind, 'enum');
  assert.deepEqual(dir.options, ['forward', 'reverse'], 'direction carries enum options');

  // fsd confidence: a recognized switch → high.
  assert.equal(deriveConfidence('fsd', caps), 'high');
});

test('an unknown WRITABLE DP is never dropped — becomes a switch', () => {
  const spec: TuyaSpec = {
    category: 'fsd',
    functions: [
      { code: 'fan_switch', type: 'Boolean', values: '{}' },
      { code: 'mystery_thing', type: 'Boolean', values: '{}' },
    ],
    status: [],
  };
  const caps = deriveCapabilities(device({}), spec);

  const mystery = caps.find((c) => c.dp === 'mystery_thing');
  assert.ok(mystery, 'unrecognized writable DP is surfaced, not dropped');
  assert.equal(mystery.kind, 'switch', 'Boolean writable DP synthesizes a switch');
  assert.equal(mystery.readOnly, false);
});

test('unknown writable Enum/Integer DPs synthesize enum/range; opaque types stay read-only', () => {
  const spec: TuyaSpec = {
    category: 'xx',
    functions: [
      { code: 'weird_mode_x', type: 'Enum', values: '{"range":["a","b"]}' },
      { code: 'odd_count', type: 'Integer', values: '{"min":0,"max":9}' },
      { code: 'blob_dp', type: 'Json', values: '{}' },
    ],
    status: [],
  };
  const caps = deriveCapabilities(device({ category: 'xx' }), spec);

  const en = caps.find((c) => c.dp === 'weird_mode_x');
  // `weird_mode_x` matches the existing `_mode` enum matcher OR synth — either way enum.
  assert.ok(en && en.kind === 'enum');
  assert.deepEqual(en.options, ['a', 'b']);

  const lvl = caps.find((c) => c.dp === 'odd_count');
  assert.ok(lvl, 'odd_count present');
  assert.equal(lvl.kind, 'range');

  const blob = caps.find((c) => c.dp === 'blob_dp');
  assert.ok(blob, 'opaque DP present');
  assert.equal(blob.kind, 'status');
  assert.equal(blob.readOnly, true, 'opaque writable type is surfaced read-only');
});

test('unrecognized READ-ONLY status DPs become measure (numeric) or status', () => {
  const spec: TuyaSpec = {
    category: 'fsd',
    functions: [{ code: 'fan_switch', type: 'Boolean', values: '{}' }],
    status: [
      { code: 'some_counter', type: 'Integer', values: '{}' },
      { code: 'odd_flag', type: 'String', values: '{}' },
    ],
  };
  const caps = deriveCapabilities(device({}), spec);

  const counter = caps.find((c) => c.dp === 'some_counter');
  assert.ok(counter && counter.kind === 'measure' && counter.readOnly === true);

  const flag = caps.find((c) => c.dp === 'odd_flag');
  assert.ok(flag && flag.kind === 'status' && flag.readOnly === true);
});

test('no-spec device folds in live status as read-only, inferring number→measure', () => {
  const d = device({
    status: [
      { code: 'fan_switch', value: true },
      { code: 'random_num', value: 42 },
      { code: 'random_str', value: 'hi' },
    ],
  });
  const caps = deriveCapabilities(d, null);

  // fan_switch is recognized as a control even without a spec.
  const power = caps.find((c) => c.dp === 'fan_switch');
  assert.ok(power && power.kind === 'switch' && power.readOnly === false);

  const num = caps.find((c) => c.dp === 'random_num');
  assert.ok(num && num.kind === 'measure' && num.readOnly === true);

  const str = caps.find((c) => c.dp === 'random_str');
  assert.ok(str && str.kind === 'status' && str.readOnly === true);
});
