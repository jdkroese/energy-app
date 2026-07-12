// Free stock-photo providers for recipe photo enrichment (docs/47 §3b). Two backends behind
// one composed searchFoodPhoto() call:
//   - Openverse (default, keyless) — GET api.openverse.org/v1/images/, anonymous per their
//     docs but throttled to be a good citizen (>=20s between requests, identifying User-Agent,
//     honors 429 Retry-After with exponential backoff).
//   - Pexels (optional fast path) — GET api.pexels.com/v1/search, requires a free API key
//     (Settings > Intelligence "Pexels API key (photos)"), paced <=180/hour (>=20s apart is
//     comfortably under that). Preferred over Openverse whenever a key is configured.
//
// Everything here is a plain fetch (same idiom as connectors/claude.ts / claude-batch.ts) —
// no SDK dependency. NEVER exercised against the live providers in tests: photo-providers.test.ts
// swaps in a fake fetch (_setFetchForTests) and an injected clock (_setClockForTests) so the
// throttle/backoff/parsing logic is fully deterministic with zero live network calls.

export interface PhotoResult {
  url: string;
  credit: string;
  creditUrl: string;
  provider: 'openverse' | 'pexels';
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
}

/** Primary = title + " food dish"; fallback = first non-pantry ingredient + cuisine + "food"
 *  (only used when the primary search comes back empty). */
export function buildPhotoQueries(recipe: QueryableRecipe): PhotoQueries {
  const primary = `${stripDiacritics(recipe.title)} food dish`.trim();
  const main = recipe.ingredients.find((i) => !i.pantryStaple);
  const fallback = main ? `${stripDiacritics(main.name)} ${recipe.cuisine} food`.trim() : null;
  return { primary, fallback };
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
// a manual/browser verification session point at a tiny local stub server instead of the
// real providers without touching any code, e.g. OPENVERSE_BASE_URL=http://localhost:4321/images/.
const OPENVERSE_BASE_URL = process.env.OPENVERSE_BASE_URL || 'https://api.openverse.org/v1/images/';
const PEXELS_BASE_URL = process.env.PEXELS_BASE_URL || 'https://api.pexels.com/v1/search';

const OPENVERSE_MIN_INTERVAL_MS = 20_000;
// Pexels allows <=180/hour (one every 20s); using the same cadence as Openverse keeps both
// paths comfortably under their limits without needing a separate constant to tune.
const PEXELS_MIN_INTERVAL_MS = 20_000;
const USER_AGENT = 'EnergyApp-KitchenRecipes/1.0 (self-hosted household app; recipe photo enrichment)';

let openverseState = freshThrottleState();
let pexelsState = freshThrottleState();

/** Test-only: reset both providers' throttle/backoff state between test cases. */
export function _resetThrottleForTests(): void {
  openverseState = freshThrottleState();
  pexelsState = freshThrottleState();
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

/** Reject implausible aspect ratios/sizes when the provider reports them; when it doesn't
 *  (Openverse doesn't always), don't over-filter — a miss here just means a slightly odd
 *  photo, not a broken one. */
function plausibleSize(w?: number, h?: number): boolean {
  if (!w || !h) return true;
  if (w < 300 || h < 200) return false;
  const ratio = w / h;
  return ratio > 0.4 && ratio < 3;
}

interface RawOutcome {
  kind: 'found' | 'no-hit' | 'rate-limited' | 'network-error';
  result?: PhotoResult;
  retryAfterHeader?: string | null;
  detail?: string;
}

interface OpenverseResult {
  url?: string;
  creator?: string;
  creator_url?: string;
  foreign_landing_url?: string;
  width?: number;
  height?: number;
}

async function rawOpenverseCall(query: string): Promise<RawOutcome> {
  try {
    const url = `${OPENVERSE_BASE_URL}?q=${encodeURIComponent(query)}&license_type=commercial&per_page=5`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 429) return { kind: 'rate-limited', retryAfterHeader: res.headers.get('retry-after') };
    if (!res.ok) return { kind: 'network-error', detail: String(res.status) };
    const json = (await res.json()) as { results?: OpenverseResult[] };
    const pick = (json.results ?? []).find((r) => r.url && plausibleSize(r.width, r.height));
    if (!pick?.url) return { kind: 'no-hit' };
    return {
      kind: 'found',
      result: {
        url: pick.url,
        credit: pick.creator || 'Openverse',
        creditUrl: pick.foreign_landing_url || pick.creator_url || 'https://openverse.org',
        provider: 'openverse',
      },
    };
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
}

async function rawPexelsCall(query: string, apiKey: string): Promise<RawOutcome> {
  try {
    const url = `${PEXELS_BASE_URL}?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape`;
    const res = await fetchImpl(url, { headers: { Authorization: apiKey, 'User-Agent': USER_AGENT } });
    if (res.status === 429) return { kind: 'rate-limited', retryAfterHeader: res.headers.get('retry-after') };
    if (!res.ok) return { kind: 'network-error', detail: String(res.status) };
    const json = (await res.json()) as { photos?: PexelsPhoto[] };
    const pick = (json.photos ?? []).find((p) => (p.src?.large || p.src?.medium) && plausibleSize(p.width, p.height));
    const photoUrl = pick?.src?.large || pick?.src?.medium;
    if (!pick || !photoUrl) return { kind: 'no-hit' };
    return {
      kind: 'found',
      result: { url: photoUrl, credit: pick.photographer || 'Pexels', creditUrl: pick.url || 'https://www.pexels.com', provider: 'pexels' },
    };
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

/**
 * Search for a food photo: Pexels when a key is configured (preferred fast path), Openverse
 * otherwise (keyless default). One throttle check gates the start of the turn, and every
 * request the turn actually makes advances `lastRequestAt` — so a two-request turn (primary
 * no-hit → one fallback query) delays the NEXT allowed request by a full interval from the
 * SECOND request, keeping the sustained pace at <=1 request per interval (<=180/hr) even
 * when every candidate needs the fallback. Any non-429 completion resets the 429 streak so
 * intermittent rate-limits spread across days don't keep escalating the backoff. Never
 * throws; network/parse failures surface as 'error' so the caller (photo-enrich.ts) can
 * just retry next tick without marking the recipe as a definitive no-hit.
 */
export async function searchFoodPhoto(opts: {
  primaryQuery: string;
  fallbackQuery: string | null;
  pexelsApiKey: string | null;
}): Promise<SearchOutcome> {
  const usePexels = Boolean(opts.pexelsApiKey);
  const state = usePexels ? pexelsState : openverseState;
  const minInterval = usePexels ? PEXELS_MIN_INTERVAL_MS : OPENVERSE_MIN_INTERVAL_MS;
  const now = clock();
  if (!canRequestNow(state, now, minInterval)) return { kind: 'throttled' };
  state.lastRequestAt = now;

  const call = (q: string) => (usePexels ? rawPexelsCall(q, opts.pexelsApiKey as string) : rawOpenverseCall(q));
  // N1 (review): any completed request that ISN'T a 429 ends the 429 streak — found, no-hit,
  // and plain network errors all count. Without this, occasional 429s spread across days
  // would keep doubling the backoff (20s→40s→…→10min) despite hundreds of successes between.
  const endStreak = () => {
    state.consecutive429 = 0;
  };

  const first = await call(opts.primaryQuery);
  if (first.kind === 'rate-limited') {
    applyBackoff(state, first.retryAfterHeader);
    return { kind: 'error', detail: '429' };
  }
  endStreak();
  if (first.kind === 'found' && first.result) return { kind: 'found', result: first.result };

  if (opts.fallbackQuery) {
    const second = await call(opts.fallbackQuery);
    // N2 (review): the fallback is a SECOND real request against the provider — advance the
    // throttle clock again so the next turn waits a full interval from THIS request, not from
    // the turn's start. Otherwise a fallback-heavy stretch runs 2 requests per window
    // (360/hr — over Pexels' limit and double the intended Openverse pace).
    state.lastRequestAt = clock();
    if (second.kind === 'rate-limited') {
      applyBackoff(state, second.retryAfterHeader);
      return { kind: 'error', detail: '429' };
    }
    endStreak();
    if (second.kind === 'found' && second.result) return { kind: 'found', result: second.result };
    if (second.kind === 'no-hit' || first.kind === 'no-hit') return { kind: 'no-hit' };
    return { kind: 'error', detail: second.detail ?? first.detail ?? 'network' };
  }

  if (first.kind === 'no-hit') return { kind: 'no-hit' };
  return { kind: 'error', detail: first.detail ?? 'network' };
}

/** Provider currently preferred — for the library card's "Openverse - free" / "Pexels - fast"
 *  status line. Pure function of whether a key is configured. */
export function preferredProvider(pexelsApiKey: string | null): 'openverse' | 'pexels' {
  return pexelsApiKey ? 'pexels' : 'openverse';
}
