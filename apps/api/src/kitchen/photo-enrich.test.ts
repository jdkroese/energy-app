// Unit tests for the photo-enrichment coordinator (docs/47 §3b, hardened docs/48 §4b): one
// tick searches → guards → downloads + validates → atomically stores photo+credit on a found
// result; a download failure NEVER marks photo_tried_at (retryable); a definitive no-hit does;
// throttled/error outcomes leave the candidate untouched; photo-present recipes are skipped;
// the backfill queue picks up provider-hotlinked and og:image-import photos (in that priority
// order) and downloads them into the local cache without re-searching. NO live network —
// photo-providers' AND photo-cache's fetch/clock seams are both swapped out.
//   node --import tsx --test src/kitchen/photo-enrich.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tick } from './photo-enrich';
import * as recipesRepo from './recipes-repo';
import { update as updateAppStore } from '../store';
import {
  _resetThrottleForTests as _resetProviderThrottle,
  _setClockForTests as _setProviderClock,
  _setFetchForTests as _setProviderFetch,
} from './photo-providers';
import { _resetThrottleForTests as _resetCacheThrottle, _setClockForTests as _setCacheClock, _setFetchForTests as _setCacheFetch } from './photo-cache';
import type { Recipe } from './types';

function freshEnv(): void {
  const dir = mkdtempSync(join(tmpdir(), 'photo-enrich-test-'));
  process.env.RECIPES_DB_FILE = join(dir, 'recipes.db');
  process.env.KITCHEN_FILE = join(dir, 'kitchen.json');
  process.env.STATE_FILE = join(dir, 'state.json');
  recipesRepo._resetForTests();
  _resetProviderThrottle();
  _resetCacheThrottle();
  _setProviderClock();
  _setCacheClock();
  _setProviderFetch();
  _setCacheFetch();
  updateAppStore((s) => {
    s.kitchen.intelligence.pexelsApiKey = null;
    s.kitchen.openverseBudget = { day: '', used: 0 };
  });
}

function recipe(id: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    id,
    title: id,
    source: 'ai',
    photo: null,
    servingsBase: 4,
    prepMin: 10,
    cookMin: 15,
    tags: [],
    cuisine: 'spanish',
    tools: [],
    ingredients: [{ name: 'Rice', es: 'arroz redondo', qty: 300, unit: 'g' }],
    steps: [{ phase: 'cook', text: 'Cook it.' }],
    lastCookedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const BIG_ENOUGH = Buffer.alloc(11 * 1024, 7);

type Handler = (url: string) => { status: number; json?: unknown; bytes?: Buffer; contentType?: string };

/** One fake fetch implementation wired into BOTH photo-providers.ts (search) and
 *  photo-cache.ts (download) — they hit different URLs so a single URL-dispatching handler
 *  can stand in for both real HTTP surfaces. */
function installFakeFetch(handler: Handler): void {
  const impl = async (url: string) => {
    const h = handler(url);
    const bytes = h.bytes ?? Buffer.from(JSON.stringify(h.json ?? {}));
    return {
      ok: h.status >= 200 && h.status < 300,
      status: h.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? h.contentType ?? 'application/json' : null) },
      json: async () => h.json ?? {},
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  };
  _setProviderFetch(impl);
  _setCacheFetch(impl);
}

/** Commons is always tried first in the cascade (docs/48 §4a) — a no-hit stub for it, plus
 *  the given Openverse `results` (skipped over if a Pexels key routes elsewhere), plus a
 *  valid-image response for any other URL (the download step). */
function stubSearchAndDownload(openverseResults: unknown[]): void {
  installFakeFetch((url) => {
    if (url.includes('commons.wikimedia.org')) return { status: 200, json: { query: { pages: {} } } };
    if (url.includes('api.openverse.org')) return { status: 200, json: { results: openverseResults } };
    if (url.includes('api.pexels.com')) return { status: 200, json: { photos: [] } };
    return { status: 200, bytes: BIG_ENOUGH, contentType: 'image/jpeg' }; // the image download itself
  });
}

// ---- search -> guard -> download -> atomic set -------------------------------------------------

test('tick: a found + downloaded photo is stored as the LOCAL cache route, with its credit', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1', { title: 'Tortilla de patatas' }));
  stubSearchAndDownload([
    { url: 'https://example.com/tortilla.jpg', title: 'Tortilla de patatas plate', creator: 'Ana', foreign_landing_url: 'https://x.test/ana', width: 800, height: 600 },
  ]);

  await tick();

  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photo, '/api/kitchen/photos/r1', 'photo is the LOCAL route, never the provider hotlink directly');
  assert.deepEqual(full?.photoCredit, { name: 'Ana', url: 'https://x.test/ana', provider: 'openverse' });
  assert.equal(full?.photoTriedAt, null, 'a found+cached photo clears any stale tried marker');
});

test('tick: a found photo carries its license through to photoCredit when the provider has one', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1', { title: 'Tortilla de patatas' }));
  stubSearchAndDownload([
    {
      url: 'https://example.com/tortilla.jpg',
      title: 'Tortilla de patatas plate',
      creator: 'Ana',
      foreign_landing_url: 'https://x.test/ana',
      width: 800,
      height: 600,
      license: 'by-sa',
    },
  ]);
  await tick();
  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photoCredit?.license, 'BY-SA');
});

test('tick: a relevance-guard-rejected candidate does not get stored — recipe stays photo-null and untried (still 429-free retry)', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1', { title: 'Chicken teriyaki' }));
  // Every candidate is completely unrelated to "Chicken teriyaki" or its "Rice" ingredient —
  // the guard rejects everything on every provider, so this ends in a definitive no-hit.
  stubSearchAndDownload([{ url: 'https://example.com/x.jpg', title: 'Amuse-bouche of miso cod', width: 800, height: 600 }]);
  await tick();
  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photo, null);
  assert.ok(full?.photoTriedAt, 'no relevant candidate anywhere in the cascade is a definitive no-hit');
});

test('tick: a definitive no-hit (no candidates anywhere) marks the recipe tried but does not touch its photo', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1'));
  stubSearchAndDownload([]);
  await tick();
  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photo, null);
  assert.ok(full?.photoTriedAt, 'no-hit records a tried timestamp');
});

test('tick: a DOWNLOAD failure (search found a URL, but the fetch of the image itself fails) never marks photo_tried_at', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1', { title: 'Tortilla de patatas' }));
  installFakeFetch((url) => {
    if (url.includes('commons.wikimedia.org')) return { status: 200, json: { query: { pages: {} } } };
    if (url.includes('api.openverse.org')) {
      return { status: 200, json: { results: [{ url: 'https://example.com/tortilla.jpg', title: 'Tortilla de patatas plate', width: 800, height: 600 }] } };
    }
    return { status: 404, bytes: Buffer.alloc(0) }; // the image download itself fails
  });

  await tick();

  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photo, null, 'download failed — recipe is left exactly as it was, no hotlink stored either');
  assert.equal(full?.photoTriedAt, null, 'a download hiccup is NEVER a definitive no-hit — it must stay retryable');
});

test('tick: photo-present recipes are skipped entirely — never queried', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1', { photo: '/recipes/r1.jpg' }));
  let calls = 0;
  installFakeFetch(() => {
    calls++;
    return { status: 200, json: { results: [] } };
  });
  await tick();
  assert.equal(calls, 0, 'a recipe that already has a photo is never a candidate');
});

test('tick: a recipe tried recently (< 30 days) is not retried; one tried > 30 days ago is', async () => {
  freshEnv();
  const now = Date.now();
  const recent = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
  const stale = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
  recipesRepo.insertRecipe(recipe('recent', { photoTriedAt: recent }));
  recipesRepo.insertRecipe(recipe('stale', { photoTriedAt: stale }));
  stubSearchAndDownload([]);

  await tick();
  const staleAfter = recipesRepo.getFull('stale');
  assert.ok(staleAfter?.photoTriedAt && staleAfter.photoTriedAt !== stale, 'stale recipe got a fresh tried timestamp');
  const recentAfter = recipesRepo.getFull('recent');
  assert.equal(recentAfter?.photoTriedAt, recent, 'recent no-hit is left completely untouched');
});

test('tick: throttled/error search outcomes leave the candidate exactly as-is (retried later, not marked tried)', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1'));
  // 429 on every provider -> the whole search is 'error', not 'no-hit'.
  installFakeFetch(() => ({ status: 429, json: {} }));
  await tick();
  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photo, null);
  assert.equal(full?.photoTriedAt, null, 'a transient error must never be recorded as a definitive no-hit');
});

test('tick: nothing to do is a clean no-op (no fetch call, no throw)', async () => {
  freshEnv();
  recipesRepo.insertRecipe(recipe('r1', { photo: '/recipes/r1.jpg' }));
  let calls = 0;
  installFakeFetch(() => {
    calls++;
    return { status: 200, json: { results: [] } };
  });
  await tick();
  assert.equal(calls, 0);
});

test('tick: picks up a Pexels key from settings and routes the search to Pexels first', async () => {
  freshEnv();
  updateAppStore((s) => {
    s.kitchen.intelligence.pexelsApiKey = 'test-key';
  });
  recipesRepo.insertRecipe(recipe('r1', { title: 'Salmon teriyaki' }));
  let sawPexelsUrl = false;
  installFakeFetch((url) => {
    if (url.includes('api.pexels.com')) {
      sawPexelsUrl = true;
      return { status: 200, json: { photos: [{ src: { large: 'https://images.pexels.com/x.jpg' }, alt: 'Salmon teriyaki bowl', width: 900, height: 600 }] } };
    }
    return { status: 200, bytes: BIG_ENOUGH, contentType: 'image/jpeg' };
  });

  await tick();
  assert.equal(sawPexelsUrl, true, 'a configured Pexels key routes the search to Pexels first');
  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photoCredit?.provider, 'pexels');
});

// ---- backfill queue (docs/48 §4b priorities 2/3) -----------------------------------------------

test('tick: priority order — a photo-null recipe is worked before a provider-hotlinked backfill candidate', async () => {
  freshEnv();
  recipesRepo.insertRecipe(
    recipe('hotlinked', {
      title: 'Zebra dish', // sorts after "apple", proving priority (not just title order) drives the pick
      photo: 'https://images.example.com/hotlink.jpg',
      photoCredit: { name: 'Ana', url: 'https://x.test', provider: 'openverse' },
    }),
  );
  recipesRepo.insertRecipe(recipe('null-photo', { title: 'Apple dish' }));
  stubSearchAndDownload([{ url: 'https://example.com/apple.jpg', title: 'Apple dish plate', width: 800, height: 600 }]);

  await tick();

  const hotlinked = recipesRepo.getFull('hotlinked');
  assert.equal(hotlinked?.photo, 'https://images.example.com/hotlink.jpg', 'untouched this tick — the photo-null recipe took priority');
  const nullPhoto = recipesRepo.getFull('null-photo');
  assert.equal(nullPhoto?.photo, '/api/kitchen/photos/null-photo');
});

test('tick: backfill — a provider-hotlinked photo is downloaded into the local cache with no re-search', async () => {
  freshEnv();
  recipesRepo.insertRecipe(
    recipe('r1', {
      photo: 'https://images.example.com/hotlink.jpg',
      photoCredit: { name: 'Ana', url: 'https://x.test', provider: 'openverse' },
    }),
  );
  let searchCalls = 0;
  installFakeFetch((url) => {
    if (url.includes('commons.wikimedia.org') || url.includes('api.openverse.org') || url.includes('api.pexels.com')) {
      searchCalls++;
      return { status: 200, json: { results: [] } };
    }
    assert.equal(url, 'https://images.example.com/hotlink.jpg', 'downloads the EXISTING hotlink url — no new search');
    return { status: 200, bytes: BIG_ENOUGH, contentType: 'image/jpeg' };
  });

  await tick();

  assert.equal(searchCalls, 0, 'backfill never re-searches — it already has a URL');
  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photo, '/api/kitchen/photos/r1');
  assert.deepEqual(full?.photoCredit, { name: 'Ana', url: 'https://x.test', provider: 'openverse' }, 'existing credit is kept as-is');
});

test('tick: backfill priority — og:image imports are LOWEST priority, behind provider-hotlinked photos', async () => {
  freshEnv();
  recipesRepo.insertRecipe(
    recipe('imported', { title: 'Apple dish', photo: 'https://cdn.example.com/og.jpg', source: 'url', sourceUrl: 'https://cook.example.com/recipe' }),
  );
  recipesRepo.insertRecipe(
    recipe('hotlinked', {
      title: 'Zebra dish',
      photo: 'https://images.example.com/hotlink.jpg',
      photoCredit: { name: 'Ana', url: 'https://x.test', provider: 'openverse' },
    }),
  );
  installFakeFetch((url) => {
    if (url.includes('commons.wikimedia.org') || url.includes('api.openverse.org') || url.includes('api.pexels.com')) {
      return { status: 200, json: { results: [] } };
    }
    return { status: 200, bytes: BIG_ENOUGH, contentType: 'image/jpeg' };
  });

  await tick();

  const imported = recipesRepo.getFull('imported');
  assert.equal(imported?.photo, 'https://cdn.example.com/og.jpg', 'untouched — the hotlinked recipe (priority 2) went first');
  const hotlinked = recipesRepo.getFull('hotlinked');
  assert.equal(hotlinked?.photo, '/api/kitchen/photos/hotlinked', 'priority 2 candidate was cached this tick');
});

test('tick: backfill — a download failure on a hotlinked candidate leaves it hotlinked (still renders), retried later', async () => {
  freshEnv();
  recipesRepo.insertRecipe(
    recipe('r1', { photo: 'https://images.example.com/rotten.jpg', photoCredit: { name: 'Ana', url: 'https://x.test', provider: 'openverse' } }),
  );
  installFakeFetch(() => ({ status: 404, bytes: Buffer.alloc(0) }));

  await tick();

  const full = recipesRepo.getFull('r1');
  assert.equal(full?.photo, 'https://images.example.com/rotten.jpg', 'download failed — still hotlinked, not nulled out');
});
