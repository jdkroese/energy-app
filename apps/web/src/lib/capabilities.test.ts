// Unit tests for the card/detail capability triage. apps/web has no formal test
// runner; mirror the API pattern and run with the Node built-in test runner via
// tsx (a workspace devDependency):
//   node --import tsx --test apps/web/src/lib/capabilities.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { primaryCapabilities, secondaryCapabilities } from './capabilities';
import type { Capability } from './types';

function cap(partial: Partial<Capability> & { dp: string; kind: Capability['kind'] }): Capability {
  return {
    key: partial.dp,
    label: partial.dp,
    readOnly: partial.kind === 'measure' || partial.kind === 'status',
    ...partial,
  };
}

test('fan: primary == power switch + fan speed (direction + countdown excluded)', () => {
  const caps: Capability[] = [
    cap({ dp: 'fan_switch', kind: 'switch' }),
    cap({ dp: 'fan_speed', kind: 'range', min: 1, max: 5 }),
    cap({ dp: 'fan_direction', kind: 'enum', options: ['forward', 'reverse'] }),
    cap({ dp: 'countdown_left_fan', kind: 'range', min: 0, max: 540 }),
  ];
  const primary = primaryCapabilities(caps);
  assert.deepEqual(primary.map((c) => c.dp), ['fan_switch', 'fan_speed']);

  const secondary = secondaryCapabilities(caps);
  assert.deepEqual(secondary.map((c) => c.dp), ['fan_direction', 'countdown_left_fan']);
});

test('plug: primary == the bare switch (measures excluded)', () => {
  const caps: Capability[] = [
    cap({ dp: 'switch', kind: 'switch' }),
    cap({ dp: 'cur_power', kind: 'measure', unit: 'W' }),
    cap({ dp: 'cur_voltage', kind: 'measure', unit: 'V' }),
    cap({ dp: 'cur_current', kind: 'measure', unit: 'mA' }),
    cap({ dp: 'countdown_1', kind: 'range', min: 0, max: 86400 }),
  ];
  const primary = primaryCapabilities(caps);
  assert.deepEqual(primary.map((c) => c.dp), ['switch']);
});

test('sensor-only device: primary falls back to (up to 3) measures', () => {
  const caps: Capability[] = [
    cap({ dp: 'va_temperature', kind: 'measure', unit: '°C' }),
    cap({ dp: 'va_humidity', kind: 'measure', unit: '%' }),
    cap({ dp: 'battery_percentage', kind: 'measure', unit: '%' }),
    cap({ dp: 'pm25_value', kind: 'measure', unit: 'µg/m³' }),
    cap({ dp: 'online', kind: 'status' }),
  ];
  const primary = primaryCapabilities(caps);
  assert.equal(primary.length, 3);
  assert.ok(primary.every((c) => c.kind === 'measure'));
});

test('no primary, no measures: falls back to controllable then original', () => {
  // An enum-only device (e.g. a mode selector) has no primary switch/range and no
  // measures → controllable fallback returns the enum.
  const caps: Capability[] = [cap({ dp: 'work_mode', kind: 'enum', options: ['white', 'colour'] })];
  assert.deepEqual(primaryCapabilities(caps).map((c) => c.dp), ['work_mode']);
});

test('bright_value / position / dimmer count as primary level ranges', () => {
  const caps: Capability[] = [
    cap({ dp: 'switch_led', kind: 'switch' }),
    cap({ dp: 'bright_value_v2', kind: 'range', min: 10, max: 1000 }),
    cap({ dp: 'temp_value_v2', kind: 'range', min: 0, max: 1000 }),
  ];
  // switch_led (primary switch) + bright_value_v2 (level) are primary; temp_value is not.
  assert.deepEqual(primaryCapabilities(caps).map((c) => c.dp), ['switch_led', 'bright_value_v2']);
});
