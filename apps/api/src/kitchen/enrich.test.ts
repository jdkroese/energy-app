// Degraded-latency test for the parallel enrich (docs/41 hardening #2 + acceptance:
// "mock 8s timeouts → assert fast return"). The connector timeout is shrunk via
// MERCADONA_TIMEOUT_MS (production keeps 8 s) and global fetch is replaced by one
// that HANGS until the timeout aborts it — the old serial enrich would have burned
// lines × timeout; the parallel version with the unreachability negative cache must
// finish in ~one timeout total.
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/kitchen/enrich.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OrderLine, ProductMapEntry } from './types';

// Env BEFORE the connector/store modules load: static imports hoist above module
// body code, so the connector (which reads MERCADONA_TIMEOUT_MS at init) is loaded
// DYNAMICALLY after the env is set.
const dir = mkdtempSync(join(tmpdir(), 'kitchen-enrich-test-'));
process.env.STATE_FILE = join(dir, 'state.json');
process.env.KITCHEN_FILE = join(dir, 'kitchen.json');
process.env.MERCADONA_TIMEOUT_MS = '150'; // stand-in for the production 8 s

const { enrichLines } = await import('./enrich');
const mercadona = await import('../connectors/mercadona');
const store = await import('../store');

const realFetch = globalThis.fetch;

/** A fetch that never answers — it only rejects when the connector's timeout aborts it. */
function hangingFetch(counter: { calls: number }): typeof fetch {
  return ((_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      counter.calls++;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
    })) as typeof fetch;
}

function mappedLine(i: number): OrderLine {
  return {
    id: `l${i}`,
    source: 'recipe',
    recipeIds: [`r${i}`],
    productId: `prod-${i}`,
    ingredientKey: `ing-${i}`,
    label: `Ingredient ${i}`,
    qty: 500,
    unit: 'g',
    checked: true,
  };
}

test('a 30-line draft returns fast when Mercadona hangs (parallel + negative cache)', async () => {
  mercadona.clearUnreachableForTests();
  // Seed the warehouse so product lookups go straight to (hanging) product GETs.
  store.update((s) => {
    s.kitchen.mercadona.warehouse = 'alc1';
  });
  const counter = { calls: 0 };
  globalThis.fetch = hangingFetch(counter);
  try {
    const lines = Array.from({ length: 30 }, (_, i) => mappedLine(i));
    const productMap: Record<string, ProductMapEntry> = {};
    const started = Date.now();
    const auto = await enrichLines(lines, productMap);
    const elapsed = Date.now() - started;
    // Serial worst case at this timeout would be 30 × 150 ms = 4.5 s (i.e. 4 min at
    // the production 8 s). Parallel through the 2-slot gate + first-failure
    // short-circuit must land near ONE timeout.
    assert.ok(elapsed < 1_500, `enrich took ${elapsed} ms — the degraded path is stalling again`);
    // The first gated fetches burn the timeout; everything queued behind them
    // short-circuits on the negative cache instead of fetching.
    assert.ok(counter.calls <= 4, `${counter.calls} fetches fired — the negative cache is not short-circuiting`);
    // Every line degrades to "price unavailable" — never a throw into the route.
    for (const l of lines) {
      assert.equal(l.priceEur ?? null, null);
      assert.equal(l.needsMapping, false);
    }
    assert.deepEqual(auto, []);
  } finally {
    globalThis.fetch = realFetch;
    mercadona.clearUnreachableForTests();
  }
});

test('the negative cache expires state is test-resettable and reads degrade to null while set', async () => {
  mercadona.clearUnreachableForTests();
  const counter = { calls: 0 };
  globalThis.fetch = hangingFetch(counter);
  try {
    // First call trips the mark (one hanging fetch aborted at the shrunk timeout)…
    const first = await mercadona.getProduct('any-product');
    assert.equal(first, null);
    assert.equal(mercadona.isUnreachable(), true);
    const callsAfterFirst = counter.calls;
    // …then subsequent reads short-circuit without fetching at all.
    const second = await mercadona.getProduct('other-product');
    assert.equal(second, null);
    assert.equal(counter.calls, callsAfterFirst);
  } finally {
    globalThis.fetch = realFetch;
    mercadona.clearUnreachableForTests();
  }
});
