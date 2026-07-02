// Unit tests for isTransientUpstream — the classifier that keeps a flaky-cloud blip
// (e.g. Tesla /site_info -> HTTP 504) from setting a sticky lastError / alarming.
//   node --import tsx --test src/control/execute-transient.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTransientUpstream } from './execute';

test('classifies the live Tesla 504 as transient', () => {
  assert.equal(isTransientUpstream('Tesla /site_info -> HTTP 504'), true);
});

test('other transient upstream shapes', () => {
  for (const d of ['HTTP 502 Bad Gateway', 'HTTP 503', 'request timed out', 'ETIMEDOUT', 'ECONNRESET', 'socket hang up']) {
    assert.equal(isTransientUpstream(d), true, d);
  }
});

test('genuine faults are NOT transient (still a standing error)', () => {
  for (const d of ['AC Cloud set rejected: bad value', 'guardrail: SoC below floor', 'HTTP 401 unauthorized', 'unknown device']) {
    assert.equal(isTransientUpstream(d), false, d);
  }
});
