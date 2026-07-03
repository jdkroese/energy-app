// Unit tests for the iSolarCloud region-host allowlist (FIX 3): `region` is interpolated
// straight into the signed request URL, so it must be constrained to known gateway hosts;
// an unknown/typo/hostile region disables the cloud (fail-soft) rather than redirecting
// credential-bearing requests. Run with:
//   node --import tsx --test src/runtime-config-region.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedIsolarcloudRegion } from './runtime-config';

test('the known EU / global / HK / CN / AU gateways are allowed', () => {
  for (const host of [
    'gateway.isolarcloud.eu',
    'gateway.isolarcloud.com',
    'gateway.isolarcloud.com.hk',
    'gateway.isolarcloud.com.cn',
    'augateway.isolarcloud.com',
  ]) {
    assert.equal(isAllowedIsolarcloudRegion(host), true, host);
  }
});

test('allowlist is case-insensitive and trims surrounding whitespace', () => {
  assert.equal(isAllowedIsolarcloudRegion('  GATEWAY.ISOLARCLOUD.EU  '), true);
});

test('an unknown / typo / hostile host is rejected', () => {
  assert.equal(isAllowedIsolarcloudRegion('evil.example.com'), false);
  assert.equal(isAllowedIsolarcloudRegion('gateway.isolarcloud.eu.evil.com'), false);
  assert.equal(isAllowedIsolarcloudRegion('gateway.isolarcloud.ru'), false);
  assert.equal(isAllowedIsolarcloudRegion(''), false);
  // No scheme/path smuggling — must be the bare host.
  assert.equal(isAllowedIsolarcloudRegion('gateway.isolarcloud.eu/../evil'), false);
});
