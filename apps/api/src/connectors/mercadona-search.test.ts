// Unit tests for the in-house "tornillos" search path (replaces the retired Algolia
// index that under-covered fresh produce — 0 hits for gambas/pepino, ajo→estropajo).
// Covers: hits→product mapping, non-OK fetch → null → category-walk fallback, and that
// a decimal (variable-weight) id survives.
// Same stubbing seam as enrich.test.ts — env set BEFORE the connector loads (it reads
// MERCADONA_TIMEOUT_MS at init), warehouse seeded via store, global fetch replaced.
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/connectors/mercadona-search.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mercadona-search-test-'));
process.env.STATE_FILE = join(dir, 'state.json');
process.env.KITCHEN_FILE = join(dir, 'kitchen.json');
process.env.MERCADONA_TIMEOUT_MS = '150';

const mercadona = await import('./mercadona');
const store = await import('../store');

const realFetch = globalThis.fetch;

/** A minimal Response-like stub good enough for the connector (ok, status, json()). */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function seedWarehouse(): void {
  store.update((s) => {
    s.kitchen.mercadona.warehouse = 'alc1';
  });
}

test('mapHits maps a tornillos hit to a MercadonaProduct', () => {
  const products = mercadona.mapHits({
    hits: [
      {
        id: '69326',
        display_name: 'Berenjena',
        price_instructions: { unit_price: '0.73' },
        photos: [],
        packaging: 'Pieza',
      },
    ],
  });
  assert.equal(products.length, 1);
  assert.equal(products[0].id, '69326');
  assert.equal(products[0].name, 'Berenjena');
  assert.equal(products[0].unitPrice, 0.73);
  assert.equal(products[0].packSizeDisplay, 'Pieza');
});

test('searchProducts uses tornillos on a 200 (fresh produce now resolves)', async () => {
  mercadona.clearUnreachableForTests();
  mercadona.clearCacheForTests();
  seedWarehouse();
  const seen: string[] = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    seen.push(String(url));
    return jsonResponse({
      hits: [{ id: '69326', display_name: 'Berenjena', price_instructions: { unit_price: '0.73' }, photos: [] }],
    });
  }) as typeof fetch;
  try {
    const res = await mercadona.searchProducts('berenjena');
    assert.ok(res);
    assert.equal(res.length, 1);
    assert.equal(res[0].name, 'Berenjena');
    // Hit the in-house search endpoint with the required `q` param + warehouse.
    assert.ok(
      seen.some((u) => u.startsWith('https://tornillos.mercadona.es/search?') && u.includes('q=berenjena') && u.includes('wh=alc1')),
      `expected a tornillos /search call, saw: ${seen.join(', ')}`,
    );
  } finally {
    globalThis.fetch = realFetch;
    mercadona.clearUnreachableForTests();
  }
});

test('a non-OK search → tornillosSearch null → searchProducts falls back to the category walk', async () => {
  mercadona.clearUnreachableForTests();
  mercadona.clearCacheForTests();
  seedWarehouse();
  let searchCalls = 0;
  let categoryCalls = 0;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    const u = String(url);
    if (u.includes('/search?')) {
      searchCalls++;
      return jsonResponse({}, 500); // in-house search is down → forces the fallback
    }
    if (u.includes('/api/categories/') && !/categories\/\d+\//.test(u)) {
      // Category tree: one leaf named to match the query.
      return jsonResponse({ results: [{ id: 1, name: 'Verduras', categories: [{ id: 11, name: 'Berenjena y calabacín' }] }] });
    }
    if (/categories\/11\//.test(u)) {
      categoryCalls++;
      return jsonResponse({
        categories: [{ products: [{ id: '69326', display_name: 'Berenjena', price_instructions: { unit_price: '0.73' }, photos: [] }] }],
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
  try {
    const res = await mercadona.searchProducts('berenjena');
    assert.equal(searchCalls > 0, true, 'tornillos search should have been attempted');
    assert.equal(categoryCalls > 0, true, 'the category-walk fallback should have been invoked');
    assert.ok(res);
    assert.equal(res[0].name, 'Berenjena');
  } finally {
    globalThis.fetch = realFetch;
    mercadona.clearUnreachableForTests();
  }
});

test('a 0-hit tornillos result FALLS THROUGH to the category walk (empty-array bug fix)', async () => {
  mercadona.clearUnreachableForTests();
  mercadona.clearCacheForTests();
  seedWarehouse();
  let categoryCalls = 0;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    const u = String(url);
    if (u.includes('/search?')) return jsonResponse({ hits: [] }); // reachable but 0 hits
    if (u.includes('/api/categories/') && !/categories\/\d+\//.test(u)) {
      return jsonResponse({ results: [{ id: 1, name: 'Verduras', categories: [{ id: 11, name: 'Berenjena y calabacín' }] }] });
    }
    if (/categories\/11\//.test(u)) {
      categoryCalls++;
      return jsonResponse({
        categories: [{ products: [{ id: '69326', display_name: 'Berenjena', price_instructions: { unit_price: '0.73' }, photos: [] }] }],
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
  try {
    const res = await mercadona.searchProducts('berenjena');
    assert.equal(categoryCalls > 0, true, 'a 0-hit tornillos result must fall through to the category walk');
    assert.ok(res);
    assert.equal(res[0].name, 'Berenjena');
  } finally {
    globalThis.fetch = realFetch;
    mercadona.clearUnreachableForTests();
  }
});

test('when tornillos + category walk both come back empty, Algolia is the last-ditch tier', async () => {
  mercadona.clearUnreachableForTests();
  mercadona.clearCacheForTests();
  seedWarehouse();
  let algoliaCalls = 0;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    const u = String(url);
    if (u.includes('/search?')) return jsonResponse({ hits: [] }); // tornillos: 0 hits
    if (u.includes('algolia.net')) {
      algoliaCalls++;
      return jsonResponse({ hits: [{ id: '55', display_name: 'Ajos morados', price_instructions: { unit_price: '1.10' }, photos: [] }] });
    }
    if (u.includes('/api/categories/') && !/categories\/\d+\//.test(u)) {
      // A category tree with no leaf matching the query → category walk yields nothing.
      return jsonResponse({ results: [{ id: 1, name: 'Bebidas', categories: [{ id: 11, name: 'Agua' }] }] });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
  try {
    const res = await mercadona.searchProducts('ajo');
    assert.equal(algoliaCalls > 0, true, 'Algolia should be the last-ditch fallback when the other two tiers are empty');
    assert.ok(res);
    assert.equal(res[0].name, 'Ajos morados');
  } finally {
    globalThis.fetch = realFetch;
    mercadona.clearUnreachableForTests();
  }
});

test('a decimal (variable-weight) id survives as the product id', () => {
  const products = mercadona.mapHits({
    hits: [{ id: '83202.1', display_name: 'Gambas a granel', price_instructions: { unit_price: '12.50' }, photos: [] }],
  });
  assert.equal(products[0].id, '83202.1');
});
