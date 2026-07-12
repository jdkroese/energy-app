// Unit tests for the free stock-photo providers (docs/47 §3b): the query builder, the
// throttle/backoff pure math (injected clock — no real timers), and both providers' response
// parsing from fixture JSON via a fake fetch. NO live network call anywhere in this file.
//   node --import tsx --test src/kitchen/photo-providers.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  backoffDelayMs,
  buildPhotoQueries,
  canRequestNow,
  freshThrottleState,
  parseRetryAfterMs,
  preferredProvider,
  searchFoodPhoto,
  stripDiacritics,
  _resetThrottleForTests,
  _setClockForTests,
  _setFetchForTests,
} from './photo-providers';

// ---- fake fetch / clock helpers -------------------------------------------------------------

type FakeHeaders = Record<string, string>;

function fakeResponse(status: number, body: unknown, headers: FakeHeaders = {}) {
  const lower: FakeHeaders = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function reset(): void {
  _resetThrottleForTests();
  _setClockForTests();
  _setFetchForTests();
}

// ---- query builder ---------------------------------------------------------------------------

test('stripDiacritics removes accents but keeps the rest of the text', () => {
  assert.equal(stripDiacritics('Pastel de Nata à la Española'), 'Pastel de Nata a la Espanola');
});

test('buildPhotoQueries: primary is the EN-ified title + "food dish"', () => {
  const q = buildPhotoQueries({
    title: 'Paëlla Valenciana',
    cuisine: 'spanish',
    ingredients: [{ name: 'Olive oil', pantryStaple: true }, { name: 'Rabbit', pantryStaple: false }],
  });
  assert.equal(q.primary, 'Paella Valenciana food dish');
});

test('buildPhotoQueries: fallback is the first non-pantry ingredient + cuisine + "food"', () => {
  const q = buildPhotoQueries({
    title: 'Anything',
    cuisine: 'japanese',
    ingredients: [
      { name: 'Salt', pantryStaple: true },
      { name: 'Salmon', pantryStaple: false },
      { name: 'Rice', pantryStaple: false },
    ],
  });
  assert.equal(q.fallback, 'Salmon japanese food');
});

test('buildPhotoQueries: fallback is null when every ingredient is a pantry staple', () => {
  const q = buildPhotoQueries({
    title: 'Anything',
    cuisine: 'dutch',
    ingredients: [{ name: 'Salt', pantryStaple: true }, { name: 'Pepper', pantryStaple: true }],
  });
  assert.equal(q.fallback, null);
});

test('preferredProvider: pexels when a key is present, openverse otherwise', () => {
  assert.equal(preferredProvider('some-key'), 'pexels');
  assert.equal(preferredProvider(null), 'openverse');
  assert.equal(preferredProvider(''), 'openverse');
});

// ---- throttle / backoff (pure, injected clock) -----------------------------------------------

test('canRequestNow: false before minInterval has elapsed, true after', () => {
  const state = freshThrottleState();
  state.lastRequestAt = 1000;
  assert.equal(canRequestNow(state, 1000 + 19_000, 20_000), false);
  assert.equal(canRequestNow(state, 1000 + 20_000, 20_000), true);
  assert.equal(canRequestNow(state, 1000 + 25_000, 20_000), true);
});

test('canRequestNow: false while inside a backoff window regardless of minInterval', () => {
  const state = freshThrottleState();
  state.lastRequestAt = 0;
  state.backoffUntil = 100_000;
  assert.equal(canRequestNow(state, 99_999, 20_000), false);
  assert.equal(canRequestNow(state, 100_000, 20_000), true);
});

test('parseRetryAfterMs: numeric seconds', () => {
  assert.equal(parseRetryAfterMs('30', 1_000_000), 30_000);
  assert.equal(parseRetryAfterMs('0', 1_000_000), 0);
});

test('parseRetryAfterMs: HTTP-date form', () => {
  const now = Date.parse('2026-07-12T10:00:00.000Z');
  const future = 'Sun, 12 Jul 2026 10:00:30 GMT';
  assert.equal(parseRetryAfterMs(future, now), 30_000);
});

test('parseRetryAfterMs: absent/unparseable header returns 0', () => {
  assert.equal(parseRetryAfterMs(null, 1000), 0);
  assert.equal(parseRetryAfterMs('not-a-date-or-number', 1000), 0);
});

test('backoffDelayMs: doubles each consecutive 429, capped at 10 minutes', () => {
  assert.equal(backoffDelayMs(0), 20_000);
  assert.equal(backoffDelayMs(1), 40_000);
  assert.equal(backoffDelayMs(2), 80_000);
  assert.equal(backoffDelayMs(10), 10 * 60 * 1000, 'capped, not 20s * 2^10');
});

// ---- searchFoodPhoto: Openverse fixture parsing -----------------------------------------------

test('searchFoodPhoto (Openverse): parses a found result from fixture JSON', async () => {
  reset();
  let calls = 0;
  _setFetchForTests(async (url) => {
    calls++;
    assert.match(url, /api\.openverse\.org/);
    return fakeResponse(200, {
      results: [
        {
          url: 'https://example.com/paella.jpg',
          creator: 'Jane Doe',
          creator_url: 'https://openverse.org/jane',
          foreign_landing_url: 'https://flickr.com/photos/jane/123',
          width: 800,
          height: 600,
        },
      ],
    });
  });

  const outcome = await searchFoodPhoto({ primaryQuery: 'paella food dish', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind === 'found') {
    assert.equal(outcome.result.url, 'https://example.com/paella.jpg');
    assert.equal(outcome.result.credit, 'Jane Doe');
    assert.equal(outcome.result.creditUrl, 'https://flickr.com/photos/jane/123');
    assert.equal(outcome.result.provider, 'openverse');
  }
  assert.equal(calls, 1, 'primary query found a result — no fallback call needed');
});

test('searchFoodPhoto (Openverse): empty results on primary falls back to the second query', async () => {
  reset();
  const seen: string[] = [];
  _setFetchForTests(async (url) => {
    seen.push(url);
    if (seen.length === 1) return fakeResponse(200, { results: [] });
    return fakeResponse(200, {
      results: [{ url: 'https://example.com/fallback.jpg', creator: 'Bob', width: 640, height: 480 }],
    });
  });

  const outcome = await searchFoodPhoto({
    primaryQuery: 'obscure dish food dish',
    fallbackQuery: 'chicken spanish food',
    pexelsApiKey: null,
  });
  assert.equal(outcome.kind, 'found');
  assert.equal(seen.length, 2, 'primary no-hit triggers exactly one fallback attempt');
  if (outcome.kind === 'found') assert.equal(outcome.result.url, 'https://example.com/fallback.jpg');
});

test('searchFoodPhoto: both primary and fallback empty -> no-hit (never a fake "found")', async () => {
  reset();
  _setFetchForTests(async () => fakeResponse(200, { results: [] }));
  const outcome = await searchFoodPhoto({ primaryQuery: 'a', fallbackQuery: 'b', pexelsApiKey: null });
  assert.equal(outcome.kind, 'no-hit');
});

test('searchFoodPhoto: no fallback query configured -> only the primary is ever called', async () => {
  reset();
  let calls = 0;
  _setFetchForTests(async () => {
    calls++;
    return fakeResponse(200, { results: [] });
  });
  const outcome = await searchFoodPhoto({ primaryQuery: 'a', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(outcome.kind, 'no-hit');
  assert.equal(calls, 1);
});

test('searchFoodPhoto: implausible image sizes are skipped in favour of a plausible one', async () => {
  reset();
  _setFetchForTests(async () =>
    fakeResponse(200, {
      results: [
        { url: 'https://example.com/tiny.jpg', width: 40, height: 40 }, // too small
        { url: 'https://example.com/banner.jpg', width: 2000, height: 100 }, // extreme ratio
        { url: 'https://example.com/good.jpg', creator: 'Ok', width: 900, height: 600 },
      ],
    }),
  );
  const outcome = await searchFoodPhoto({ primaryQuery: 'x', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind === 'found') assert.equal(outcome.result.url, 'https://example.com/good.jpg');
});

// ---- searchFoodPhoto: Pexels fixture parsing (preferred when a key is present) ----------------

test('searchFoodPhoto (Pexels): used instead of Openverse when a key is present, parses fixture JSON', async () => {
  reset();
  let calls = 0;
  _setFetchForTests(async (url, init) => {
    calls++;
    assert.match(url, /api\.pexels\.com/);
    assert.equal(init?.headers?.Authorization, 'test-pexels-key');
    return fakeResponse(200, {
      photos: [
        {
          src: { large: 'https://images.pexels.com/photo1-large.jpg', medium: 'https://images.pexels.com/photo1-m.jpg' },
          photographer: 'John Doe',
          url: 'https://www.pexels.com/photo/123',
          width: 1200,
          height: 800,
        },
      ],
    });
  });

  const outcome = await searchFoodPhoto({ primaryQuery: 'salmon food dish', fallbackQuery: null, pexelsApiKey: 'test-pexels-key' });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind === 'found') {
    assert.equal(outcome.result.url, 'https://images.pexels.com/photo1-large.jpg');
    assert.equal(outcome.result.credit, 'John Doe');
    assert.equal(outcome.result.provider, 'pexels');
  }
  assert.equal(calls, 1);
});

// ---- throttle + backoff wired through searchFoodPhoto ------------------------------------------

test('searchFoodPhoto: a second call inside the 20s window is throttled — no network call at all', async () => {
  reset();
  let now = 1_000_000;
  _setClockForTests(() => now);
  let calls = 0;
  _setFetchForTests(async () => {
    calls++;
    return fakeResponse(200, { results: [{ url: 'https://example.com/a.jpg', width: 800, height: 600 }] });
  });

  const first = await searchFoodPhoto({ primaryQuery: 'a', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(first.kind, 'found');
  assert.equal(calls, 1);

  now += 5_000; // well under the 20s minimum interval
  const second = await searchFoodPhoto({ primaryQuery: 'b', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(second.kind, 'throttled');
  assert.equal(calls, 1, 'the throttled call made no network request');

  now += 20_000; // now past the window
  const third = await searchFoodPhoto({ primaryQuery: 'c', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(third.kind, 'found');
  assert.equal(calls, 2);
});

test('searchFoodPhoto: a 429 with Retry-After backs off for exactly that long, then recovers', async () => {
  reset();
  let now = 0;
  _setClockForTests(() => now);
  let calls = 0;
  _setFetchForTests(async () => {
    calls++;
    if (calls === 1) return fakeResponse(429, {}, { 'Retry-After': '60' });
    return fakeResponse(200, { results: [{ url: 'https://example.com/a.jpg', width: 800, height: 600 }] });
  });

  const first = await searchFoodPhoto({ primaryQuery: 'a', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(first.kind, 'error');
  assert.equal(calls, 1);

  now += 20_000; // past the plain throttle interval, but still inside the 60s Retry-After
  const second = await searchFoodPhoto({ primaryQuery: 'b', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(second.kind, 'throttled', 'still backing off — no second network call yet');
  assert.equal(calls, 1);

  now += 60_000; // fully past the Retry-After window (80s total since the 429)
  const third = await searchFoodPhoto({ primaryQuery: 'c', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(third.kind, 'found');
  assert.equal(calls, 2);
});

test('searchFoodPhoto: a 429 with no Retry-After falls back to exponential backoff', async () => {
  reset();
  let now = 0;
  _setClockForTests(() => now);
  _setFetchForTests(async () => fakeResponse(429, {}));

  const first = await searchFoodPhoto({ primaryQuery: 'a', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(first.kind, 'error');

  now += 19_999; // just under the first backoff step (20s)
  const second = await searchFoodPhoto({ primaryQuery: 'b', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(second.kind, 'throttled');

  now += 1; // exactly at 20s
  const third = await searchFoodPhoto({ primaryQuery: 'c', fallbackQuery: null, pexelsApiKey: null });
  assert.equal(third.kind, 'error', 'the 20s mark just clears backoff, then a fresh 429 doubles it again');
});
