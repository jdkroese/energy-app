// Mercadona READ-ONLY connector (docs/38 §3, docs/39 P0). Unofficial API — treat with care:
//  - Base https://tienda.mercadona.es/api/ (Django-style trailing slashes, anonymous reads).
//  - Always a realistic browser User-Agent (Akamai bot manager) + ?lang=es&wh=<warehouse>.
//  - Warehouse resolved ONCE via PUT /api/postal-codes/actions/change-pc/ → x-customer-wh
//    header (03730 → alc1). Cached in state.json (kitchen.mercadona); NEVER hardcoded.
//  - Search: Algolia index products_prod_{wh}_es with PUBLIC app-id/key scraped from the
//    tienda JS bundle; keys rotate → re-scrape + retry once on 401/403/404. Mercadona is
//    mid-migration off Algolia, so search sits behind searchProducts() with a
//    category-walk fallback — a dead Algolia degrades, never breaks.
//  - All reads cached ≥30 min (their own Cache-Control is 1800s). Low concurrency
//    (max 2 in flight), 1 retry max, 8s timeout.
//  - EVERYTHING degrades gracefully: if Mercadona is unreachable the app still fully
//    works minus prices/photos — callers get nulls, never throws into a request path.
//  - NO cart writes, NO auth. Cart fill is P2 (token bootstrap, Tesla pattern).

import * as store from '../store';

const BASE = 'https://tienda.mercadona.es';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// Timeout is env-overridable ONLY so the degraded-latency unit test can shrink it —
// production always runs the 8 s default.
const TIMEOUT_MS = Number(process.env.MERCADONA_TIMEOUT_MS) > 0 ? Number(process.env.MERCADONA_TIMEOUT_MS) : 8_000;
const CACHE_TTL_MS = 30 * 60_000; // ≥30 min per the brief
const MAX_IN_FLIGHT = 2;
const NEG_CACHE_MS = 5 * 60_000; // docs/41 hardening #2: unreachability negative cache

// ---- Public product shapes ------------------------------------------------------

export interface MercadonaProduct {
  id: string;
  name: string;
  /** imgix URL already resized for UI thumbs. */
  photo: string | null;
  /** Unit (sell) price in EUR. */
  unitPrice: number | null;
  /** e.g. "1 kg", "6 x 1 L" — Mercadona's packaging description. */
  packSizeDisplay: string | null;
  /** Parsed pack size when derivable (drives the pack math). */
  packSize: { qty: number; unit: string } | null;
  /** Reference price ("1,10 €/kg") for the suggestion strip later. */
  referencePrice: string | null;
  categoryId?: string | null;
  shareUrl?: string | null;
}

export interface MercadonaCategory {
  id: string;
  name: string;
  categories?: MercadonaCategory[];
}

export interface MercadonaStatus {
  ok: boolean;
  warehouse: string | null;
  products: number | null;
  searchOk: boolean;
  latencyMs: number;
  detail?: string;
}

// ---- Tiny cache + concurrency gate ----------------------------------------------

const cache = new Map<string, { at: number; value: unknown }>();

function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  if (hit) cache.delete(key);
  return null;
}

function cacheSet(key: string, value: unknown): void {
  cache.set(key, { at: Date.now(), value });
  // Bound the cache — this is a household app, not a crawler.
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) cache.delete(k);
  }
}

// ---- Unreachability negative cache (docs/41 hardening #2) -----------------------
// A hard network failure (timeout / DNS / refused) marks the whole connector
// unreachable for 5 min: every queued/subsequent call short-circuits to null instead
// of burning its own 8 s timeout, so a 30-line draft enrich can't stall for minutes
// while Mercadona is down. Any successful response clears the mark early.

let unreachableUntil = 0;

export function isUnreachable(): boolean {
  return Date.now() < unreachableUntil;
}

function markUnreachable(reason: string): void {
  if (Date.now() < unreachableUntil) return; // already marked — don't spam the log
  unreachableUntil = Date.now() + NEG_CACHE_MS;
  console.error(`[mercadona] unreachable — negative-cached for 5 min (${reason})`);
}

function markReachable(): void {
  unreachableUntil = 0;
}

/** Test-only reset. */
export function clearUnreachableForTests(): void {
  unreachableUntil = 0;
}

let inFlight = 0;
const waiters: Array<() => void> = [];

async function gate<T>(fn: () => Promise<T> | T): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((res) => waiters.push(res));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiters.shift()?.();
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

// ---- Warehouse resolution ---------------------------------------------------------

/**
 * Resolve the warehouse for the configured postal code via the change-pc endpoint
 * (response header x-customer-wh; 03730 → alc1) and cache it in state. Never
 * hardcoded — a different postal code (env MERCADONA_POSTAL_CODE) re-resolves.
 */
export async function resolveWarehouse(force = false): Promise<string | null> {
  const cfg = store.get().kitchen.mercadona;
  if (cfg.warehouse && !force) return cfg.warehouse;
  if (isUnreachable()) return cfg.warehouse ?? null;
  try {
    const res = await gate(() =>
      fetchWithTimeout(`${BASE}/api/postal-codes/actions/change-pc/`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_postal_code: cfg.postalCode }),
      }),
    );
    markReachable();
    const wh = res.headers.get('x-customer-wh');
    if (wh) {
      store.update((s) => {
        s.kitchen.mercadona.warehouse = wh;
      });
      return wh;
    }
  } catch (e) {
    markUnreachable(`warehouse resolve: ${(e as Error).message}`);
    console.error('[mercadona] warehouse resolve failed:', (e as Error).message);
  }
  return cfg.warehouse ?? null;
}

async function apiGet<T>(path: string): Promise<T | null> {
  const wh = await resolveWarehouse();
  if (!wh) return null;
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}/api/${path}${sep}lang=es&wh=${encodeURIComponent(wh)}`;
  const hit = cacheGet<T>(url);
  if (hit !== null) return hit;
  if (isUnreachable()) return null; // negative cache — fail fast, callers degrade
  try {
    // Re-check INSIDE the gate: with a parallel enrich, dozens of calls queue up
    // before the first one times out — they must short-circuit when their turn comes.
    const res = await gate(() => (isUnreachable() ? null : fetchWithTimeout(url)));
    if (res === null) return null;
    markReachable();
    if (!res.ok) return null;
    const json = (await res.json()) as T;
    cacheSet(url, json);
    return json;
  } catch (e) {
    markUnreachable(`GET ${path}: ${(e as Error).message}`);
    console.error(`[mercadona] GET ${path} failed:`, (e as Error).message);
    return null;
  }
}

// ---- Catalog ----------------------------------------------------------------------

interface RawCategoryList {
  results?: Array<{ id: number; name: string; categories?: Array<{ id: number; name: string }> }>;
}

export async function getCategories(): Promise<MercadonaCategory[] | null> {
  const raw = await apiGet<RawCategoryList>('categories/');
  if (!raw?.results) return null;
  return raw.results.map((c) => ({
    id: String(c.id),
    name: c.name,
    categories: (c.categories ?? []).map((s) => ({ id: String(s.id), name: s.name })),
  }));
}

interface RawPriceInstructions {
  unit_price?: string | number;
  bulk_price?: string | number;
  reference_price?: string | number;
  reference_format?: string;
  unit_size?: number;
  size_format?: string;
  unit_name?: string | null;
  total_units?: number | null;
}

export interface RawProduct {
  id: string | number;
  display_name?: string;
  packaging?: string | null;
  price_instructions?: RawPriceInstructions;
  photos?: Array<{ regular?: string; thumbnail?: string }>;
  thumbnail?: string;
  share_url?: string | null;
  categories?: Array<{ id: number }>;
}

function num(v: string | number | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Resize an imgix photo URL for UI thumbs (docs/39: ?fit=crop&h=300&w=300). */
function thumb(url: string | undefined | null): string | null {
  if (!url) return null;
  const base = url.split('?')[0];
  return `${base}?fit=crop&h=300&w=300`;
}

/** Exported for the P2 myregulars mapping (mercadona-auth returns raw product rows). */
export function normalizeProduct(p: RawProduct): MercadonaProduct {
  const pi = p.price_instructions ?? {};
  const sizeQty = num(pi.unit_size);
  const sizeUnit = (pi.size_format ?? '').toLowerCase() || null;
  const totalUnits = num(pi.total_units ?? undefined);
  // Pack display: "6 x 1 L" for multipacks, else "1 kg" style.
  let display: string | null = null;
  let pack: { qty: number; unit: string } | null = null;
  if (sizeQty && sizeUnit) {
    if (totalUnits && totalUnits > 1) {
      display = `${totalUnits} x ${sizeQty} ${sizeUnit}`;
      pack = { qty: sizeQty * totalUnits, unit: sizeUnit };
    } else {
      display = `${sizeQty} ${sizeUnit}`;
      pack = { qty: sizeQty, unit: sizeUnit };
    }
  } else if (p.packaging) {
    display = p.packaging;
  }
  const refPrice = num(pi.reference_price);
  return {
    id: String(p.id),
    name: p.display_name ?? '',
    photo: thumb(p.photos?.[0]?.regular ?? p.thumbnail),
    unitPrice: num(pi.unit_price),
    packSizeDisplay: display,
    packSize: pack,
    referencePrice: refPrice != null && pi.reference_format ? `${refPrice.toFixed(2)} €/${pi.reference_format}` : null,
    categoryId: p.categories?.[0]?.id != null ? String(p.categories[0].id) : null,
    shareUrl: p.share_url ?? null,
  };
}

/** Products of one (leaf) category. */
export async function getCategoryProducts(categoryId: string): Promise<MercadonaProduct[] | null> {
  const raw = await apiGet<{ categories?: Array<{ products?: RawProduct[] }> }>(`categories/${categoryId}/`);
  if (!raw?.categories) return null;
  const out: MercadonaProduct[] = [];
  for (const sub of raw.categories) for (const p of sub.products ?? []) out.push(normalizeProduct(p));
  return out;
}

/** Product detail (full price_instructions + photos). */
export async function getProduct(productId: string): Promise<MercadonaProduct | null> {
  const raw = await apiGet<RawProduct>(`products/${productId}/`);
  return raw ? normalizeProduct(raw) : null;
}

// ---- Search (Algolia, behind an interface, with category-walk fallback) ------------

// Last-known-good public keys (baked into Mercadona's JS bundle; they ROTATE — used
// only until the first scrape, and re-scraped automatically on any 4xx).
const FALLBACK_ALGOLIA = { appId: '7UZJKL1DJ0', apiKey: '9d8f2e39e90df472b4f2e559a116fe17' };

async function getAlgoliaKeys(forceScrape = false): Promise<{ appId: string; apiKey: string }> {
  const cfg = store.get().kitchen.mercadona;
  if (cfg.algolia && !forceScrape) return { appId: cfg.algolia.appId, apiKey: cfg.algolia.apiKey };
  if (forceScrape || !cfg.algolia) {
    const scraped = await scrapeAlgoliaKeys();
    if (scraped) {
      store.update((s) => {
        s.kitchen.mercadona.algolia = { ...scraped, scrapedAt: new Date().toISOString() };
      });
      return scraped;
    }
  }
  return cfg.algolia ? { appId: cfg.algolia.appId, apiKey: cfg.algolia.apiKey } : FALLBACK_ALGOLIA;
}

/** Scrape the public Algolia app-id + search key from the tienda JS bundle. */
async function scrapeAlgoliaKeys(): Promise<{ appId: string; apiKey: string } | null> {
  try {
    const home = await gate(() => fetchWithTimeout(`${BASE}/`, { headers: { Accept: 'text/html' } }));
    if (!home.ok) return null;
    const html = await home.text();
    // Try inline first, then each referenced bundle (main app chunk usually carries it).
    const found = extractAlgolia(html);
    if (found) return found;
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]).slice(0, 6);
    for (const src of scripts) {
      const url = src.startsWith('http') ? src : `${BASE}${src.startsWith('/') ? '' : '/'}${src}`;
      try {
        const res = await gate(() => fetchWithTimeout(url, { headers: { Accept: '*/*' } }));
        if (!res.ok) continue;
        const js = await res.text();
        const keys = extractAlgolia(js);
        if (keys) return keys;
      } catch {
        /* try the next bundle */
      }
    }
  } catch (e) {
    console.error('[mercadona] algolia key scrape failed:', (e as Error).message);
  }
  return null;
}

/** Exported for unit tests (docs/41 hardening #4). */
export function extractAlgolia(text: string): { appId: string; apiKey: string } | null {
  // App id: 10 chars upper/num next to an "algolia" mention.
  const idMatch =
    text.match(/algolia[^"']{0,40}["']([A-Z0-9]{10})["']/i) ?? text.match(/["']([A-Z0-9]{10})["'][^"']{0,40}algolia/i);
  if (!idMatch) return null;
  // Key: 32-hex, but ONLY when an algolia/apiKey/searchKey token sits within ~200
  // chars — a bare 32-hex match anywhere in a bundle happily grabs a webpack chunk
  // hash (docs/41 hardening #4).
  for (const m of text.matchAll(/["']([a-f0-9]{32})["']/gi)) {
    const at = m.index ?? 0;
    const around = text.slice(Math.max(0, at - 200), Math.min(text.length, at + m[0].length + 200));
    if (/algolia|api[-_]?key|search[-_]?key/i.test(around)) return { appId: idMatch[1], apiKey: m[1] };
  }
  return null;
}

async function algoliaSearch(query: string, wh: string, retryOnAuthFail = true): Promise<MercadonaProduct[] | null> {
  const keys = await getAlgoliaKeys();
  const index = `products_prod_${wh}_es`;
  const url = `https://${keys.appId}-dsn.algolia.net/1/indexes/${index}/query`;
  try {
    const res = await gate(() =>
      fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'X-Algolia-Application-Id': keys.appId,
          'X-Algolia-API-Key': keys.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, hitsPerPage: 12 }),
      }),
    );
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      // Keys rotated (or the index moved). Re-scrape from the JS bundle and retry ONCE.
      if (retryOnAuthFail) {
        await getAlgoliaKeys(true);
        return algoliaSearch(query, wh, false);
      }
      return null;
    }
    if (!res.ok) return null;
    const json = (await res.json()) as { hits?: RawProduct[] };
    if (!json.hits) return null;
    return json.hits.map(normalizeProduct);
  } catch (e) {
    console.error('[mercadona] algolia search failed:', (e as Error).message);
    return null;
  }
}

/** Fallback when Algolia is dead: walk the category tree and substring-match names. */
async function categoryWalkSearch(query: string): Promise<MercadonaProduct[] | null> {
  const cats = await getCategories();
  if (!cats) return null;
  const q = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  // Rank leaf categories by name match, probe the top few (cached → cheap on repeats).
  const leaves = cats.flatMap((c) => c.categories ?? []);
  const ranked = leaves
    .map((l) => ({ l, hit: q.split(/\s+/).some((w) => w.length > 2 && norm(l.name).includes(w)) }))
    .sort((a, b) => Number(b.hit) - Number(a.hit))
    .slice(0, 4);
  const out: MercadonaProduct[] = [];
  for (const { l } of ranked) {
    const prods = await getCategoryProducts(l.id);
    for (const p of prods ?? []) {
      if (q.split(/\s+/).some((w) => w.length > 2 && norm(p.name).includes(w))) out.push(p);
      if (out.length >= 12) return out;
    }
  }
  return out.length ? out : null;
}

/**
 * THE search interface (docs/39): Algolia first, category-walk fallback, 30-min cache.
 * Returns null when Mercadona is fully unreachable — callers render "prices unavailable".
 */
export async function searchProducts(query: string): Promise<MercadonaProduct[] | null> {
  const q = query.trim();
  if (!q) return [];
  const wh = await resolveWarehouse();
  if (!wh) return null;
  const cacheKey = `search:${wh}:${q.toLowerCase()}`;
  const hit = cacheGet<MercadonaProduct[]>(cacheKey);
  if (hit) return hit;
  const viaAlgolia = await algoliaSearch(q, wh);
  const results = viaAlgolia ?? (await categoryWalkSearch(q));
  if (results) cacheSet(cacheKey, results);
  return results;
}

// ---- Status probe (admin; the P0 go/no-go check) -----------------------------------

/** Live category fetch + one search — verifies Akamai lets this host in. */
export async function getStatus(): Promise<MercadonaStatus> {
  const started = Date.now();
  const wh = await resolveWarehouse();
  if (!wh) {
    return { ok: false, warehouse: null, products: null, searchOk: false, latencyMs: Date.now() - started, detail: 'warehouse unresolved (postal-code endpoint unreachable)' };
  }
  const cats = await getCategories();
  let products: number | null = null;
  if (cats?.length) {
    const firstLeaf = cats[0]?.categories?.[0];
    if (firstLeaf) {
      const prods = await getCategoryProducts(firstLeaf.id);
      products = prods ? prods.length : null;
    }
  }
  const search = await searchProducts('arroz');
  return {
    ok: Boolean(cats && products != null),
    warehouse: wh,
    products,
    searchOk: Boolean(search && search.length > 0),
    latencyMs: Date.now() - started,
    ...(cats ? {} : { detail: 'category fetch failed' }),
  };
}
