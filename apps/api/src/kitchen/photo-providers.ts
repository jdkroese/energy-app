// Free stock-photo providers for recipe photo enrichment (docs/47 §3b, hardened docs/48 §4a).
// A CASCADE behind one composed searchFoodPhoto() call, in this order:
//   1. Pexels (optional fast path) — GET api.pexels.com/v1/search, requires a free API key
//      (Settings > Intelligence "Pexels API key (photos)"), paced <=180/hour.
//   2. Wikimedia Commons (keyless default) — GET commons.wikimedia.org/w/api.php, exact dish
//      matches with license + artist metadata; paced >=15s/search (etiquette — no published
//      rate limit, but bursty image fetches from upload.wikimedia.org 429 per docs/48's live
//      probe, so this stays gentle even though it's the search endpoint not the image one).
//   3. Openverse (long-tail filler) — GET api.openverse.org/v1/images/, anonymous per their
//      docs but LIVE-PROBED at 200 requests/day (docs/48 finding #1); a persisted daily
//      counter (state.json kitchen.openverseBudget) hard-stops at 180/day, well under that,
//      because the cascade means Openverse only ever sees what Commons missed.
//
// RELEVANCE GUARD (docs/48 §4a): every candidate from every provider is checked against the
// recipe's own identity (its title, and — for a fallback-query hit — the ingredient that
// drove the fallback) before being accepted. Without this, "Chicken teriyaki food dish" can
// come back with an amuse-bouche-of-miso-cod photo (first plausible hit != relevant hit) and
// P3 stored it blindly. A candidate with no usable title (Pexels sometimes has no `alt`) is
// rejected rather than guessed at.
//
// Everything here is a plain fetch (same idiom as connectors/claude.ts / claude-batch.ts) —
// no SDK dependency. NEVER exercised against the live providers in tests: photo-providers.test.ts
// swaps in a fake fetch (_setFetchForTests) and an injected clock (_setClockForTests) so the
// throttle/backoff/cascade/guard logic is fully deterministic with zero live network calls.

import * as store from '../store';

export interface PhotoResult {
  url: string;
  credit: string;
  creditUrl: string;
  provider: 'openverse' | 'pexels' | 'commons';
  /** Short license name (e.g. "CC BY-SA 4.0") — Commons (and some Openverse hits) carry one;
   *  Pexels doesn't have an SPDX-style short name for its own free license. */
  license?: string;
}

export type SearchOutcome =
  | { kind: 'found'; result: PhotoResult }
  | { kind: 'no-hit' }
  | { kind: 'throttled' }
  | { kind: 'error'; detail: string };

// ---- Query builder (docs/47 §3b) ------------------------------------------------------------

/** Strip diacritics so the query is plain ASCII-ish — recipe titles/ingredient names are
 *  already English (see generate.ts's GENERATE_SYSTEM) but may carry accents (e.g. "Pastel"). */
export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export interface QueryableRecipe {
  title: string;
  cuisine: string;
  ingredients: Array<{ name: string; pantryStaple?: boolean }>;
}

export interface PhotoQueries {
  primary: string;
  fallback: string | null;
  /** Bare (diacritic-stripped) ingredient name used by the relevance guard when a fallback-
   *  query hit is being evaluated — distinct from `fallback` itself, which has
   *  " {cuisine} food" appended for the actual search text. */
  fallbackGuardText: string | null;
}

/** Primary = title + " food dish"; fallback = first non-pantry ingredient + cuisine + "food"
 *  (only used when the primary search comes back empty/irrelevant). */
export function buildPhotoQueries(recipe: QueryableRecipe): PhotoQueries {
  const primary = `${stripDiacritics(recipe.title)} food dish`.trim();
  const main = recipe.ingredients.find((i) => !i.pantryStaple);
  const fallback = main ? `${stripDiacritics(main.name)} ${recipe.cuisine} food`.trim() : null;
  const fallbackGuardText = main ? stripDiacritics(main.name) : null;
  return { primary, fallback, fallbackGuardText };
}

// ---- Relevance guard (docs/48 §4a) ------------------------------------------------------------

/** Basic EN/ES plural strip — "chickens"→"chicken", "salsas"→"salsa". Deliberately crude
 *  (this only needs to widen word overlap a little, not be a real stemmer). */
function stripPluralSuffix(w: string): string {
  if (w.length > 5 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

function significantWords(text: string): Set<string> {
  const words = stripDiacritics(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map(stripPluralSuffix)
    .filter((w) => w.length > 3);
  return new Set(words);
}

/**
 * A candidate is accepted only if its own title shares at least one significant (>3 char,
 * diacritic/case-insensitive, plural-stripped) word with the recipe's identity. `guardTexts`
 * is the recipe title, plus (for a fallback-query attempt) the ingredient that drove it.
 * A candidate with no title at all (or one with zero significant words) is rejected — no
 * signal means no guarantee, and "make sure" means erring toward no photo over a wrong one.
 */
export function candidateIsRelevant(candidateTitle: string, guardTexts: string[]): boolean {
  const candWords = significantWords(candidateTitle);
  if (!candWords.size) return false;
  for (const text of guardTexts) {
    for (const w of significantWords(text)) {
      if (candWords.has(w)) return true;
    }
  }
  return false;
}

// ---- Throttle / backoff (pure, injectable clock) --------------------------------------------

export interface ThrottleState {
  lastRequestAt: number;
  backoffUntil: number;
  consecutive429: number;
}

export function freshThrottleState(): ThrottleState {
  // -Infinity (not 0) so the very first request is always immediately allowed regardless of
  // what the clock happens to read at that point — real Date.now() is always far from 0, but
  // an injected test clock often legitimately starts at 0, which would otherwise collide with
  // a same-instant "last request" and wrongly throttle the first-ever call.
  return { lastRequestAt: -Infinity, backoffUntil: -Infinity, consecutive429: 0 };
}

/** True when a new request may be sent right now: not inside a 429 backoff window AND at
 *  least `minIntervalMs` since the last request. */
export function canRequestNow(state: ThrottleState, now: number, minIntervalMs: number): boolean {
  return now >= state.backoffUntil && now - state.lastRequestAt >= minIntervalMs;
}

/** Parse a Retry-After header (seconds, or an HTTP-date) into a millisecond delay from `now`.
 *  Returns 0 when absent/unparseable — callers fall back to backoffDelayMs(). */
export function parseRetryAfterMs(header: string | null, now: number): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - now);
  return 0;
}

/** Exponential backoff when a provider gives us a 429 with no usable Retry-After: 20s, 40s,
 *  80s, ... capped at 10 minutes. */
export function backoffDelayMs(consecutive429: number): number {
  return Math.min(10 * 60 * 1000, 20_000 * 2 ** Math.max(0, consecutive429));
}

// Overridable base URLs — NOT used by any test (those swap the fetch impl instead), but lets
// a manual/browser verification session point at tiny local stub servers instead of the real
// providers without touching any code, e.g. COMMONS_BASE_URL=http://localhost:4321/commons.
const OPENVERSE_BASE_URL = process.env.OPENVERSE_BASE_URL || 'https://api.openverse.org/v1/images/';
const PEXELS_BASE_URL = process.env.PEXELS_BASE_URL || 'https://api.pexels.com/v1/search';
const COMMONS_BASE_URL = process.env.COMMONS_BASE_URL || 'https://commons.wikimedia.org/w/api.php';

const OPENVERSE_MIN_INTERVAL_MS = 20_000;
// Pexels allows <=180/hour (one every 20s); using the same cadence as Openverse keeps both
// paths comfortably under their limits without needing a separate constant to tune.
const PEXELS_MIN_INTERVAL_MS = 20_000;
// Commons has no published anonymous rate limit, but upload.wikimedia.org 429s bursty IMAGE
// fetches (docs/48 live probe) — pacing the SEARCH endpoint too, a little more gently than
// the 20s stock-photo APIs, is the good-citizen thing to do given we hit it first, every time.
const COMMONS_MIN_INTERVAL_MS = 15_000;
const USER_AGENT = 'EnergyApp-KitchenRecipes/1.0 (self-hosted household app; recipe photo enrichment)';

const OPENVERSE_DAILY_BUDGET = 180; // headroom under the live-probed 200/day anonymous cap

let openverseState = freshThrottleState();
let pexelsState = freshThrottleState();
let commonsState = freshThrottleState();

/** Test-only: reset every provider's throttle/backoff state between test cases. */
export function _resetThrottleForTests(): void {
  openverseState = freshThrottleState();
  pexelsState = freshThrottleState();
  commonsState = freshThrottleState();
}

let clock: () => number = () => Date.now();
/** Test-only: inject a deterministic clock (pass nothing to restore Date.now). */
export function _setClockForTests(fn?: () => number): void {
  clock = fn ?? (() => Date.now());
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

let fetchImpl: FetchLike = fetch as unknown as FetchLike;
/** Test-only: swap the fetch implementation (pass nothing to restore the real one). */
export function _setFetchForTests(fn?: FetchLike): void {
  fetchImpl = fn ?? (fetch as unknown as FetchLike);
}

// ---- Openverse daily budget (docs/48 §4a — persisted in state.json) --------------------------

function todayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function openverseUsedToday(now: number): number {
  const b = store.get().kitchen.openverseBudget;
  return b.day === todayUtc(now) ? b.used : 0;
}

function openverseBudgetOk(now: number): boolean {
  return openverseUsedToday(now) < OPENVERSE_DAILY_BUDGET;
}

function recordOpenverseUse(now: number): void {
  const day = todayUtc(now);
  store.update((s) => {
    if (s.kitchen.openverseBudget.day !== day) {
      s.kitchen.openverseBudget.day = day;
      s.kitchen.openverseBudget.used = 1;
    } else {
      s.kitchen.openverseBudget.used += 1;
    }
  });
}

/** Inspection helper (status line / tests) — how many Openverse searches used up today. */
export function openverseBudgetUsedToday(now = Date.now()): number {
  return openverseUsedToday(now);
}

// ---- Size plausibility (shared by all three providers) ----------------------------------------

/** Reject implausible aspect ratios/sizes when the provider reports them; when it doesn't,
 *  don't over-filter — a miss here just means a slightly odd photo, not a broken one. */
function plausibleSize(w?: number, h?: number): boolean {
  if (!w || !h) return true;
  if (w < 300 || h < 200) return false;
  const ratio = w / h;
  return ratio > 0.4 && ratio < 3;
}

// ---- Per-provider raw calls — each returns a LIST of candidates (title included) so the
// relevance guard can walk every result, not just the first plausible one. --------------------

interface Candidate {
  url: string;
  title: string;
  credit: string;
  creditUrl: string;
  license?: string;
}

interface RawOutcome {
  kind: 'candidates' | 'no-hit' | 'rate-limited' | 'network-error';
  candidates?: Candidate[];
  retryAfterHeader?: string | null;
  detail?: string;
}

interface OpenverseResult {
  title?: string;
  url?: string;
  creator?: string;
  creator_url?: string;
  foreign_landing_url?: string;
  width?: number;
  height?: number;
  license?: string;
}

async function rawOpenverseCall(query: string): Promise<RawOutcome> {
  try {
    const url = `${OPENVERSE_BASE_URL}?q=${encodeURIComponent(query)}&license_type=commercial&per_page=5`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 429) return { kind: 'rate-limited', retryAfterHeader: res.headers.get('retry-after') };
    if (!res.ok) return { kind: 'network-error', detail: String(res.status) };
    const json = (await res.json()) as { results?: OpenverseResult[] };
    const candidates: Candidate[] = (json.results ?? [])
      .filter((r) => r.url && plausibleSize(r.width, r.height))
      .map((r) => ({
        url: r.url as string,
        title: r.title || '',
        credit: r.creator || 'Openverse',
        creditUrl: r.foreign_landing_url || r.creator_url || 'https://openverse.org',
        ...(r.license ? { license: r.license.toUpperCase() } : {}),
      }));
    if (!candidates.length) return { kind: 'no-hit' };
    return { kind: 'candidates', candidates };
  } catch (e) {
    return { kind: 'network-error', detail: (e as Error).message };
  }
}

interface PexelsPhoto {
  src?: { large?: string; medium?: string };
  photographer?: string;
  url?: string;
  width?: number;
  height?: number;
  /** Pexels' description field — often empty, but when present it's the closest thing to a
   *  title for the relevance guard. */
  alt?: string;
}

async function rawPexelsCall(query: string, apiKey: string): Promise<RawOutcome> {
  try {
    const url = `${PEXELS_BASE_URL}?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape`;
    const res = await fetchImpl(url, { headers: { Authorization: apiKey, 'User-Agent': USER_AGENT } });
    if (res.status === 429) return { kind: 'rate-limited', retryAfterHeader: res.headers.get('retry-after') };
    if (!res.ok) return { kind: 'network-error', detail: String(res.status) };
    const json = (await res.json()) as { photos?: PexelsPhoto[] };
    const candidates: Candidate[] = (json.photos ?? [])
      .filter((p) => (p.src?.large || p.src?.medium) && plausibleSize(p.width, p.height))
      .map((p) => ({
        url: (p.src?.large || p.src?.medium) as string,
        title: p.alt || '',
        credit: p.photographer || 'Pexels',
        creditUrl: p.url || 'https://www.pexels.com',
      }));
    if (!candidates.length) return { kind: 'no-hit' };
    return { kind: 'candidates', candidates };
  } catch (e) {
    return { kind: 'network-error', detail: (e as Error).message };
  }
}

// ---- Wikimedia Commons (docs/48 §4a) -----------------------------------------------------------
// GET .../w/api.php?action=query&generator=search&gsrsearch=<q>&gsrnamespace=6&gsrlimit=5&
//     prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=960&format=json
// `filetype:bitmap` is prefixed to the search query itself (a Commons search-syntax filter,
// not a URL param). Response: query.pages is a DICT keyed by page id (order not guaranteed —
// callers must not assume array order == relevance rank beyond what the guard imposes).

interface CommonsImageInfo {
  url?: string;
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  width?: number;
  height?: number;
  /** File description page — the credit/license link. Present whenever iiprop includes 'url';
   *  falls back to a constructed File: page URL on the rare page missing it. */
  descriptionurl?: string;
  extmetadata?: {
    Artist?: { value?: string };
    LicenseShortName?: { value?: string };
  };
}

interface CommonsPage {
  title?: string;
  imageinfo?: CommonsImageInfo[];
}

const COMMONS_ACCEPTED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']); // explicitly NOT gif (probe hit one)

function fileExtension(url: string): string {
  const m = url.match(/\.([a-z0-9]+)(?:\?.*)?$/i);
  return m ? m[1].toLowerCase() : '';
}

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/** "File:Teriyaki_Chicken.jpg" -> "Teriyaki Chicken" — for the relevance guard. */
function commonsCandidateTitle(pageTitle: string): string {
  return pageTitle
    .replace(/^File:/i, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/_/g, ' ')
    .trim();
}

async function rawCommonsCall(query: string): Promise<RawOutcome> {
  try {
    const gsrsearch = `filetype:bitmap ${query}`;
    const params = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch,
      gsrnamespace: '6',
      gsrlimit: '5',
      prop: 'imageinfo',
      iiprop: 'url|size|extmetadata',
      iiurlwidth: '960',
      format: 'json',
    });
    const url = `${COMMONS_BASE_URL}?${params.toString()}`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 429) return { kind: 'rate-limited', retryAfterHeader: res.headers.get('retry-after') };
    if (!res.ok) return { kind: 'network-error', detail: String(res.status) };
    const json = (await res.json()) as { query?: { pages?: Record<string, CommonsPage> } };
    const pages = Object.values(json.query?.pages ?? {});
    const candidates: Candidate[] = [];
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      const imgUrl = info.thumburl || info.url;
      if (!imgUrl) continue;
      if (!COMMONS_ACCEPTED_EXTS.has(fileExtension(imgUrl))) continue; // skip GIFs + anything odd
      if (!plausibleSize(info.thumbwidth ?? info.width, info.thumbheight ?? info.height)) continue;
      const rawArtist = info.extmetadata?.Artist?.value ?? '';
      const artist = stripHtmlTags(rawArtist).trim() || 'Wikimedia Commons';
      const descUrl =
        info.descriptionurl ||
        (page.title ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}` : 'https://commons.wikimedia.org');
      candidates.push({
        url: imgUrl,
        title: commonsCandidateTitle(page.title || ''),
        credit: artist,
        creditUrl: descUrl,
        ...(info.extmetadata?.LicenseShortName?.value ? { license: info.extmetadata.LicenseShortName.value } : {}),
      });
    }
    if (!candidates.length) return { kind: 'no-hit' };
    return { kind: 'candidates', candidates };
  } catch (e) {
    return { kind: 'network-error', detail: (e as Error).message };
  }
}

function applyBackoff(state: ThrottleState, retryAfterHeader: string | null | undefined): void {
  const now = clock();
  // backoffDelayMs(0) is the delay for the FIRST 429 (20s); pass the PRE-increment count so
  // the very first failure gets 20s, the next (if it happens again before recovering) 40s, etc.
  const delay = backoffDelayMs(state.consecutive429);
  state.consecutive429 += 1;
  const explicit = parseRetryAfterMs(retryAfterHeader ?? null, now);
  state.backoffUntil = now + (explicit || delay);
}

// ---- Cascade orchestration (docs/48 §4a) -------------------------------------------------------

type ProviderKind = 'pexels' | 'commons' | 'openverse';

interface ProviderSpec {
  kind: ProviderKind;
  state: ThrottleState;
  minInterval: number;
  call: (query: string) => Promise<RawOutcome>;
  /** Extra gate beyond throttle — only Openverse has one (the daily budget). */
  extraGate?: (now: number) => boolean;
}

function providerCascade(pexelsApiKey: string | null): ProviderSpec[] {
  const specs: ProviderSpec[] = [];
  if (pexelsApiKey) {
    specs.push({ kind: 'pexels', state: pexelsState, minInterval: PEXELS_MIN_INTERVAL_MS, call: (q) => rawPexelsCall(q, pexelsApiKey) });
  }
  specs.push({ kind: 'commons', state: commonsState, minInterval: COMMONS_MIN_INTERVAL_MS, call: rawCommonsCall });
  specs.push({
    kind: 'openverse',
    state: openverseState,
    minInterval: OPENVERSE_MIN_INTERVAL_MS,
    call: rawOpenverseCall,
    extraGate: openverseBudgetOk,
  });
  return specs;
}

type AttemptOutcome =
  | { outcome: 'found'; result: PhotoResult }
  | { outcome: 'no-hit' }
  | { outcome: 'stop'; detail: string } // rate-limited — provider now backing off
  | { outcome: 'error'; detail: string };

async function attemptProviderQuery(
  spec: ProviderSpec,
  query: string,
  guardTexts: string[],
  skipUrls: Set<string> | undefined,
): Promise<AttemptOutcome> {
  const raw = await spec.call(query);
  if (spec.kind === 'openverse') recordOpenverseUse(clock());

  if (raw.kind === 'rate-limited') {
    applyBackoff(spec.state, raw.retryAfterHeader);
    return { outcome: 'stop', detail: '429' };
  }
  // N1 (carried over from P3): any completed request that ISN'T a 429 ends the 429 streak —
  // found, no-hit, and plain network errors all count. Without this, occasional 429s spread
  // across days would keep doubling the backoff despite hundreds of successes between.
  spec.state.consecutive429 = 0;

  if (raw.kind === 'network-error') return { outcome: 'error', detail: raw.detail ?? 'network' };
  if (raw.kind === 'no-hit') return { outcome: 'no-hit' };

  // skipUrls (docs/48 W1 review fix): URLs whose DOWNLOAD came back invalid on an earlier tick
  // (dead link / html error page / <10KB). Without this, the deterministic search + deterministic
  // first-pick would re-choose the same dead top hit forever — one bad URL wedging the entire
  // photo queue. Skipping it here lets the NEXT plausible+relevant candidate get its chance.
  const hit = (raw.candidates ?? []).find((c) => candidateIsRelevant(c.title, guardTexts) && !skipUrls?.has(c.url));
  if (!hit) return { outcome: 'no-hit' }; // candidates existed but none passed the guard (or all known-dead)
  return {
    outcome: 'found',
    result: { url: hit.url, credit: hit.credit, creditUrl: hit.creditUrl, provider: spec.kind, ...(hit.license ? { license: hit.license } : {}) },
  };
}

/**
 * Search for a food photo across the full cascade — Pexels (if a key is configured) →
 * Wikimedia Commons (keyless default) → Openverse (long-tail filler, budget-capped) — trying
 * each provider's primary query, then its fallback query, before moving to the next provider.
 * Every candidate is checked by the relevance guard before being accepted. Each provider keeps
 * its OWN throttle/backoff state, so one provider being mid-backoff never blocks the others —
 * it's simply skipped for this turn. Never throws; network/parse failures surface as 'error'
 * so the caller (photo-enrich.ts) can just retry next tick without marking the recipe as a
 * definitive no-hit.
 */
export async function searchFoodPhoto(opts: {
  recipeTitle: string;
  primaryQuery: string;
  fallbackQuery: string | null;
  fallbackGuardText: string | null;
  pexelsApiKey: string | null;
  /** URLs already proven un-downloadable for this recipe (docs/48 W1) — candidates with these
   *  urls are passed over so a dead top hit can't wedge the recipe (and the queue) forever. */
  skipUrls?: Set<string>;
}): Promise<SearchOutcome> {
  const guardBase = [opts.recipeTitle];
  const specs = providerCascade(opts.pexelsApiKey);
  let anyAttempted = false;
  let lastError: string | null = null;

  for (const spec of specs) {
    const now0 = clock();
    if (spec.extraGate && !spec.extraGate(now0)) continue; // e.g. Openverse daily budget spent
    if (!canRequestNow(spec.state, now0, spec.minInterval)) continue; // this provider not ready — try the next one
    spec.state.lastRequestAt = now0;
    anyAttempted = true;

    const first = await attemptProviderQuery(spec, opts.primaryQuery, guardBase, opts.skipUrls);
    if (first.outcome === 'found') return { kind: 'found', result: first.result };
    if (first.outcome === 'stop') {
      lastError = first.detail;
      continue; // this provider is now backing off — cascade to the next one
    }
    if (first.outcome === 'error') lastError = first.detail;

    if (opts.fallbackQuery) {
      // N2 (carried over from P3): a SECOND real request against the SAME provider — advance
      // its throttle clock again so the next turn waits a full interval from THIS request.
      spec.state.lastRequestAt = clock();
      const guardTexts2 = opts.fallbackGuardText ? [...guardBase, opts.fallbackGuardText] : guardBase;
      const second = await attemptProviderQuery(spec, opts.fallbackQuery, guardTexts2, opts.skipUrls);
      if (second.outcome === 'found') return { kind: 'found', result: second.result };
      if (second.outcome === 'stop') {
        lastError = second.detail;
        continue;
      }
      if (second.outcome === 'error') lastError = second.detail;
    }
    // Neither query on this provider produced a relevant hit — cascade to the next provider.
  }

  if (!anyAttempted) return { kind: 'throttled' };
  if (lastError) return { kind: 'error', detail: lastError };
  return { kind: 'no-hit' };
}

/** Provider currently preferred — for the library card's "Pexels · fast" /
 *  "Commons + Openverse · free" status line. Pure function of whether a key is configured. */
export function preferredProvider(pexelsApiKey: string | null): 'pexels' | 'commons+openverse' {
  return pexelsApiKey ? 'pexels' : 'commons+openverse';
}
