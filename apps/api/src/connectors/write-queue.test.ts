// Unit tests for the per-key write serializer — run with the Node built-in test
// runner via tsx:  node --import tsx --test src/connectors/write-queue.test.ts
// (apps/api has no formal test-runner script; tsx is a devDependency.)
//
// These prove the property the climate connectors rely on: writes sharing a key
// never overlap (so concurrent toggles can't collide on a single-session backend),
// a failing task doesn't stall the queue, and distinct keys stay concurrent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serialize } from './write-queue';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('same key: tasks run strictly one-at-a-time, in call order', async () => {
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];

  const run = (n: number) =>
    serialize('k', async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      order.push(n);
      active--;
      return n;
    });

  // Fire all at once; the queue must serialize them.
  const results = await Promise.all([run(1), run(2), run(3)]);

  assert.equal(maxActive, 1, 'no two same-key tasks should overlap');
  assert.deepEqual(order, [1, 2, 3], 'tasks run in FIFO call order');
  assert.deepEqual(results, [1, 2, 3], 'each caller gets its own result');
});

test('same key: a rejecting task does not break the chain', async () => {
  const order: string[] = [];

  const p1 = serialize('k2', async () => {
    await delay(5);
    order.push('a');
    throw new Error('boom');
  });
  const p2 = serialize('k2', async () => {
    order.push('b');
    return 'ok';
  });

  await assert.rejects(p1, /boom/);
  assert.equal(await p2, 'ok', 'next task still runs after a failure');
  assert.deepEqual(order, ['a', 'b'], 'failure does not reorder or skip');
});

test('different keys run concurrently', async () => {
  let active = 0;
  let maxActive = 0;

  const run = (key: string) =>
    serialize(key, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active--;
    });

  await Promise.all([run('a'), run('b'), run('c')]);

  assert.equal(maxActive, 3, 'independent keys are not serialized against each other');
});
