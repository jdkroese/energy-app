// Unit tests for the free stock-photo provider cascade (docs/47 §3b, hardened docs/48 §4a):
// the query builder, the relevance guard (incl. the teriyaki/miso-cod fixture that must
// REJECT), the throttle/backoff pure math (injected clock — no real timers), the Commons/
// Pexels/Openverse response parsing from fixture JSON via a fake fetch, the cascade order,
// and the persisted Openverse daily-budget rollover. NO live network call anywhere in this file.
//   node --import tsx --test src/kitchen/photo-providers.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  backoffDelayMs,
  buildPhotoQueries,
  candidateIsRelevant,
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
import { update as updateAppStore } from '../store';

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
  updateAppStore((s) => {
    s.kitchen.openverseBudget = { day: '', used: 0 };
  });
}

const commonsNoHit = () => fakeResponse(200, { query: { pages: {} } });

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

test('buildPhotoQueries: fallback + fallbackGuardText come from the first non-pantry ingredient', () => {
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
  assert.equal(q.fallbackGuardText, 'Salmon', 'the guard text is the bare ingredient — no cuisine/food suffix noise');
});

test('buildPhotoQueries: fallback + fallbackGuardText are both null when every ingredient is a pantry staple', () => {
  const q = buildPhotoQueries({
    title: 'Anything',
    cuisine: 'dutch',
    ingredients: [{ name: 'Salt', pantryStaple: true }, { name: 'Pepper', pantryStaple: true }],
  });
  assert.equal(q.fallback, null);
  assert.equal(q.fallbackGuardText, null);
});

test('preferredProvider: pexels when a key is present, commons+openverse otherwise', () => {
  assert.equal(preferredProvider('some-key'), 'pexels');
  assert.equal(preferredProvider(null), 'commons+openverse');
  assert.equal(preferredProvider(''), 'commons+openverse');
});

// ---- relevance guard (docs/48 §4a) -------------------------------------------------------------

test('candidateIsRelevant: REJECTS the miso-cod candidate for a teriyaki query (the live-probed failure case)', () => {
  assert.equal(candidateIsRelevant('Amuse-bouche of miso cod', ['Chicken teriyaki']), false);
});

test('candidateIsRelevant: accepts a candidate whose title shares a significant word with the recipe title', () => {
  assert.equal(candidateIsRelevant('Chicken teriyaki plate', ['Chicken teriyaki']), true);
});

test('candidateIsRelevant: also accepts via the fallback ingredient guard text', () => {
  assert.equal(candidateIsRelevant('Fresh salmon fillet', ['Obscure Dish Name', 'Salmon']), true);
});

test('candidateIsRelevant: a candidate with no title (or no word over 3 chars) is always rejected', () => {
  assert.equal(candidateIsRelevant('', ['Chicken teriyaki']), false);
  assert.equal(candidateIsRelevant('Ok', ['Chicken teriyaki']), false);
});

test('candidateIsRelevant: is diacritic/case-insensitive and does a basic EN/ES plural strip', () => {
  assert.equal(candidateIsRelevant('PAELLAS valencianas', ['paëlla valenciana']), true);
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

// ---- searchFoodPhoto: Commons response parsing (docs/48 §4a) -----------------------------------

test('Commons: parses a found result — skips a GIF, strips HTML from Artist, captures LicenseShortName + descriptionurl', async () => {
  reset();
  _setFetchForTests(async (url) => {
    assert.match(url, /commons\.wikimedia\.org/);
    return fakeResponse(200, {
      query: {
        pages: {
          '1': {
            title: 'File:Teriyaki Chicken.gif',
            imageinfo: [{ url: 'https://upload.wikimedia.org/teriyaki.gif', width: 900, height: 600 }],
          },
          '2': {
            title: 'File:Teriyaki Chicken.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/teriyaki.jpg',
                thumburl: 'https://upload.wikimedia.org/thumb/960px-teriyaki.jpg',
                width: 3000,
                height: 2000,
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Teriyaki_Chicken.jpg',
                extmetadata: {
                  Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Someone">Someone</a>' },
                  LicenseShortName: { value: 'CC BY-SA 4.0' },
                },
              },
            ],
          },
        },
      },
    });
  });

  const outcome = await searchFoodPhoto({
    recipeTitle: 'Teriyaki Chicken',
    primaryQuery: 'Teriyaki Chicken food dish',
    fallbackQuery: null,
    fallbackGuardText: null,
    pexelsApiKey: null,
  });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind === 'found') {
    assert.equal(outcome.result.url, 'https://upload.wikimedia.org/thumb/960px-teriyaki.jpg', 'the GIF was skipped, the jpg thumb was picked');
    assert.equal(outcome.result.credit, 'Someone', 'HTML stripped from the Artist field');
    assert.equal(outcome.result.license, 'CC BY-SA 4.0');
    assert.equal(outcome.result.creditUrl, 'https://commons.wikimedia.org/wiki/File:Teriyaki_Chicken.jpg');
    assert.equal(outcome.result.provider, 'commons');
  }
});

test('Commons: an Artist-less/GIF-only page yields no-hit, not a crash', async () => {
  reset();
  _setFetchForTests(async () =>
    fakeResponse(200, {
      query: { pages: { '1': { title: 'File:Only.gif', imageinfo: [{ url: 'https://upload.wikimedia.org/only.gif', width: 900, height: 600 }] } } },
    }),
  );
  const outcome = await searchFoodPhoto({
    recipeTitle: 'x',
    primaryQuery: 'x',
    fallbackQuery: null,
    fallbackGuardText: null,
    pexelsApiKey: null,
  });
  assert.equal(outcome.kind, 'no-hit');
});

// ---- searchFoodPhoto: cascade order (docs/48 §4a) -----------------------------------------------

test('cascade: keyless search tries Commons before Openverse', async () => {
  reset();
  const seen: string[] = [];
  _setFetchForTests(async (url) => {
    seen.push(url);
    if (url.includes('commons.wikimedia.org')) return commonsNoHit();
    return fakeResponse(200, {
      results: [{ url: 'https://example.com/salmon.jpg', title: 'Grilled salmon teriyaki', creator: 'X', width: 900, height: 600 }],
    });
  });
  const outcome = await searchFoodPhoto({
    recipeTitle: 'Salmon teriyaki',
    primaryQuery: 'Salmon teriyaki food dish',
    fallbackQuery: null,
    fallbackGuardText: null,
    pexelsApiKey: null,
  });
  assert.equal(outcome.kind, 'found');
  assert.ok(seen[0].includes('commons.wikimedia.org'), 'Commons is queried first');
  assert.ok(seen.some((u) => u.includes('api.openverse.org')), 'Openverse is queried after Commons comes back empty');
  assert.ok(!seen.some((u) => u.includes('api.pexels.com')), 'no Pexels key configured — it is never called');
});

test('cascade: a configured Pexels key is tried FIRST — Commons/Openverse are never touched on a Pexels hit', async () => {
  reset();
  const seen: string[] = [];
  _setFetchForTests(async (url, init) => {
    seen.push(url);
    assert.match(url, /api\.pexels\.com/);
    assert.equal(init?.headers?.Authorization, 'test-pexels-key');
    return fakeResponse(200, {
      photos: [
        {
          src: { large: 'https://images.pexels.com/paella-large.jpg' },
          photographer: 'Jane Doe',
          alt: 'Paella Valenciana dish',
          url: 'https://www.pexels.com/photo/123',
          width: 1200,
          height: 800,
        },
      ],
    });
  });
  const outcome = await searchFoodPhoto({
    recipeTitle: 'Paella Valenciana',
    primaryQuery: 'Paella Valenciana food dish',
    fallbackQuery: null,
    fallbackGuardText: null,
    pexelsApiKey: 'test-pexels-key',
  });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind === 'found') {
    assert.equal(outcome.result.provider, 'pexels');
    assert.equal(outcome.result.credit, 'Jane Doe');
  }
  assert.equal(seen.length, 1, 'the Pexels hit ended the cascade immediately');
});

test('relevance guard integrated into the cascade: an irrelevant Commons hit is rejected, Openverse supplies the real match', async () => {
  reset();
  _setFetchForTests(async (url) => {
    if (url.includes('commons.wikimedia.org')) {
      // A plausible-looking but WRONG Commons result (the live-probed failure case).
      return fakeResponse(200, {
        query: {
          pages: {
            '1': {
              title: 'File:Amuse-bouche of miso cod.jpg',
              imageinfo: [
                {
                  url: 'https://upload.wikimedia.org/miso-cod.jpg',
                  thumburl: 'https://upload.wikimedia.org/thumb/960px-miso-cod.jpg',
                  width: 960,
                  height: 640,
                  descriptionurl: 'https://commons.wikimedia.org/wiki/File:Amuse-bouche_of_miso_cod.jpg',
                  extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } },
                },
              ],
            },
          },
        },
      });
    }
    return fakeResponse(200, {
      results: [{ url: 'https://example.com/teriyaki.jpg', title: 'Chicken teriyaki plate', creator: 'Ana', width: 900, height: 600 }],
    });
  });
  const outcome = await searchFoodPhoto({
    recipeTitle: 'Chicken teriyaki',
    primaryQuery: 'Chicken teriyaki food dish',
    fallbackQuery: null,
    fallbackGuardText: null,
    pexelsApiKey: null,
  });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind === 'found') {
    assert.equal(outcome.result.provider, 'openverse', 'Commons hit failed the guard (miso cod != teriyaki); Openverse supplied the real match');
    assert.equal(outcome.result.url, 'https://example.com/teriyaki.jpg');
  }
});

test('cascade: a no-hit primary query tries the fallback query on the SAME provider before moving on', async () => {
  reset();
  const openverseCalls: string[] = [];
  _setFetchForTests(async (url) => {
    if (url.includes('commons.wikimedia.org')) return commonsNoHit();
    openverseCalls.push(url);
    if (openverseCalls.length === 1) return fakeResponse(200, { results: [] }); // primary miss
    return fakeResponse(200, { results: [{ url: 'https://example.com/salmon.jpg', title: 'Grilled salmon fillet', width: 900, height: 600 }] });
  });
  const outcome = await searchFoodPhoto({
    recipeTitle: 'Mystery dish',
    primaryQuery: 'Mystery dish food dish',
    fallbackQuery: 'Salmon spanish food',
    fallbackGuardText: 'Salmon',
    pexelsApiKey: null,
  });
  assert.equal(outcome.kind, 'found');
  assert.equal(openverseCalls.length, 2, 'primary miss on Openverse triggered exactly one fallback attempt');
  if (outcome.kind === 'found') assert.equal(outcome.result.url, 'https://example.com/salmon.jpg');
});

test('cascade: both primary and fallback empty on every provider -> no-hit (never a fake "found")', async () => {
  reset();
  _setFetchForTests(async (url) => (url.includes('commons.wikimedia.org') ? commonsNoHit() : fakeResponse(200, { results: [] })));
  const outcome = await searchFoodPhoto({
    recipeTitle: 'a',
    primaryQuery: 'a',
    fallbackQuery: 'b',
    fallbackGuardText: null,
    pexelsApiKey: null,
  });
  assert.equal(outcome.kind, 'no-hit');
});

// ---- Openverse daily budget (docs/48 §4a) -------------------------------------------------------

test('Openverse budget: hard-stops at 180/day — Openverse is skipped entirely once spent', async () => {
  reset();
  updateAppStore((s) => {
    s.kitchen.openverseBudget = { day: '2026-07-12', used: 180 };
  });
  let now = Date.parse('2026-07-12T12:00:00.000Z');
  _setClockForTests(() => now);
  const seen: string[] = [];
  _setFetchForTests(async (url) => {
    seen.push(url);
    if (url.includes('commons.wikimedia.org')) return commonsNoHit();
    return fakeResponse(200, { results: [{ url: 'https://example.com/x.jpg', title: 'Chicken teriyaki bowl', width: 900, height: 600 }] });
  });

  const outcome = await searchFoodPhoto({
    recipeTitle: 'Chicken teriyaki',
    primaryQuery: 'Chicken teriyaki food dish',
    fallbackQuery: null,
    fallbackGuardText: null,
    pexelsApiKey: null,
  });
  assert.equal(outcome.kind, 'no-hit', 'Commons missed and Openverse was skipped — the day\'s budget is already spent');
  assert.ok(!seen.some((u) => u.includes('api.openverse.org')), 'Openverse was never even called');

  now = Date.parse('2026-07-13T00:00:05.000Z'); // a new UTC day rolls the counter to 0
  const outcome2 = await searchFoodPhoto({
    recipeTitle: 'Chicken teriyaki',
    primaryQuery: 'Chicken teriyaki food dish',
    fallbackQuery: null,
    fallbackGuardText: null,
    pexelsApiKey: null,
  });
  assert.equal(outcome2.kind, 'found', 'a new UTC day resets the Openverse budget');
  if (outcome2.kind === 'found') assert.equal(outcome2.result.provider, 'openverse');
});

// ---- throttle + backoff wired through the cascade ------------------------------------------------

test('throttle: a provider still inside its own pacing window is skipped, not retried', async () => {
  reset();
  let now = 0;
  _setClockForTests(() => now);
  let commonsCalls = 0;
  _setFetchForTests(async (url) => {
    if (url.includes('commons.wikimedia.org')) {
      commonsCalls++;
      return commonsNoHit();
    }
    return fakeResponse(200, { results: [] });
  });

  await searchFoodPhoto({ recipeTitle: 'x', primaryQuery: 'a', fallbackQuery: null, fallbackGuardText: null, pexelsApiKey: null });
  assert.equal(commonsCalls, 1);

  now += 5_000; // under Commons's 15s AND Openverse's 20s windows
  const second = await searchFoodPhoto({ recipeTitle: 'x', primaryQuery: 'b', fallbackQuery: null, fallbackGuardText: null, pexelsApiKey: null });
  assert.equal(second.kind, 'throttled', 'every provider is still inside its own window');
  assert.equal(commonsCalls, 1, 'no new network call while throttled');
});

test('throttle: a 429 from one provider backs off only that provider — the SAME call still reaches the next one', async () => {
  reset();
  _setFetchForTests(async (url) => {
    if (url.includes('commons.wikimedia.org')) return fakeResponse(429, {}, { 'Retry-After': '60' });
    return fakeResponse(200, { results: [{ url: 'https://example.com/x.jpg', title: 'Chicken teriyaki bowl', width: 900, height: 600 }] });
  });
  const outcome = await searchFoodPhoto({
    recipeTitle: 'Chicken teriyaki',
    primaryQuery: 'Chicken teriyaki food dish',
    fallbackQuery: null,
    fallbackGuardText: null,
    pexelsApiKey: null,
  });
  assert.equal(outcome.kind, 'found');
  if (outcome.kind === 'found') assert.equal(outcome.result.provider, 'openverse', 'Commons 429d — Openverse still supplied the hit in this same call');
});

test('throttle: a provider still backing off from an earlier 429 is skipped on the next call', async () => {
  reset();
  let now = 0;
  _setClockForTests(() => now);
  let commonsCalls = 0;
  _setFetchForTests(async (url) => {
    if (url.includes('commons.wikimedia.org')) {
      commonsCalls++;
      return fakeResponse(429, {}, { 'Retry-After': '60' });
    }
    return fakeResponse(200, { results: [] });
  });

  await searchFoodPhoto({ recipeTitle: 'x', primaryQuery: 'a', fallbackQuery: null, fallbackGuardText: null, pexelsApiKey: null });
  assert.equal(commonsCalls, 1);

  now += 30_000; // past the plain 15s interval, but still inside the 60s Retry-After
  await searchFoodPhoto({ recipeTitle: 'x', primaryQuery: 'a', fallbackQuery: null, fallbackGuardText: null, pexelsApiKey: null });
  assert.equal(commonsCalls, 1, 'Commons is still backing off — skipped, not re-called');
});
