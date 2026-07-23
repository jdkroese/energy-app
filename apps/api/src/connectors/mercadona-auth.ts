// Mercadona ACCOUNT session + authed endpoints (P2, docs/41). The login endpoint is
// reCAPTCHA-gated, so the session is bootstrapped ONCE by hand (browser login → copy
// the refresh token → paste in Settings, exactly the Tesla-token pattern) and renews
// headlessly from then on.
//
// HARD RULES (docs/41):
//  - Refresh tokens ROTATE ON EVERY USE. The rotated token is persisted atomically
//    (store.update → tmp+rename) THE MOMENT it arrives, BEFORE the access token is
//    used for anything. A lost rotation = the owner must re-bootstrap.
//  - Access tokens live in MEMORY ONLY. Tokens are NEVER logged, and masked in every
//    GET response (see maskToken).
//  - Cart writes are the ceiling: this module has NO code path to checkout, payment,
//    slot BOOKING or order placement (/checkouts/… endpoints are deliberately absent).
//  - Everything degrades gracefully — callers get nulls/readable errors, not crashes.
//
// Endpoint facts (docs/38 §3 + exwyezed/mercadona-cli):
//  - POST /api/auth/tokens/            {refresh_token} → {access_token, refresh_token, customer_id}
//  - GET  /api/customers/{id}/cart/    → {id, version, lines:[{product_id|product, quantity}]}
//  - PUT  /api/customers/{id}/cart/    {id, version, lines:[{product_id, quantity}]}  (flattened, ONE batch)
//  - GET  /api/customers/{id}/addresses/                     → delivery addresses
//  - GET  /api/customers/{id}/addresses/{addr}/slots/        → delivery slots/cutoffs (READ ONLY here)
//  - GET  /api/customers/{id}/orders/                        → placed orders (status tracking)
//  - GET  /api/customers/{id}/recommendations/myregulars/precision/ → "your regulars"

import * as store from '../store';
import type { KitchenMercadonaAccount } from '../store';

const BASE = 'https://tienda.mercadona.es';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;
const ACCESS_FALLBACK_TTL_MS = 10 * 60_000; // when the JWT exp claim is unreadable

// ---- Injectable seams (unit tests exercise rotation persistence without I/O) -------

export interface AuthDeps {
  fetchFn: typeof fetch;
  loadAccount: () => KitchenMercadonaAccount | null;
  /** MUST persist atomically before returning (store.update is tmp+rename). */
  persistAccount: (a: KitchenMercadonaAccount) => void;
}

function defaultDeps(): AuthDeps {
  return {
    fetchFn: fetch,
    loadAccount: () => store.get().kitchen.mercadona.account,
    persistAccount: (a) => {
      store.update((s) => {
        s.kitchen.mercadona.account = a;
      });
    },
  };
}

// ---- Small helpers ------------------------------------------------------------------

/** "eyJhbGciOi…" → "eyJhbGc••••••••Q1x8" — safe for logs/UI. NEVER return raw tokens. */
export function maskToken(token: string | null | undefined): string | null {
  if (!token) return null;
  return token.length > 14 ? `${token.slice(0, 7)}••••••••${token.slice(-4)}` : '••••••••';
}

async function fetchWithTimeout(fetchFn: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetchFn(url, {
      ...init,
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

/** Best-effort JWT payload decode (SimpleJWT carries exp + customer id claims). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null;
}

// ---- Refresh flow (rotation-safe, single-flight) --------------------------------------

interface RefreshedSession {
  accessToken: string;
  customerId: string | null;
  /** The rotated refresh token (may equal the old one if the API didn't rotate). */
  refreshToken: string | null;
  raw: Record<string, unknown>;
}

/**
 * One POST /api/auth/tokens/ with a refresh token. Pure network — persistence is the
 * caller's job (linkAccount / refreshAccessToken persist at the right moment).
 */
async function requestTokens(fetchFn: typeof fetch, refreshToken: string): Promise<RefreshedSession> {
  const res = await fetchWithTimeout(fetchFn, `${BASE}/api/auth/tokens/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' — the token was rejected; re-link the account' : '';
    throw new Error(`Mercadona token refresh -> HTTP ${res.status}${hint}`);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const accessToken = str(json.access_token) ?? str(json.access) ?? str(json.token);
  if (!accessToken) throw new Error('Mercadona token refresh returned no access token');
  const claims = decodeJwtPayload(accessToken) ?? {};
  const customerId =
    str(json.customer_id) ?? str(json.customer_uuid) ?? str(claims.customer_id) ?? str(claims.customer_uuid) ?? str(claims.user_id) ?? null;
  return {
    accessToken,
    customerId,
    refreshToken: str(json.refresh_token) ?? str(json.refresh),
    raw: json,
  };
}

let accessCache: { token: string; exp: number } | null = null;
let refreshInFlight: Promise<string> | null = null;

function accessExp(token: string): number {
  const claims = decodeJwtPayload(token);
  const exp = typeof claims?.exp === 'number' ? claims.exp * 1000 : 0;
  return exp > Date.now() ? exp : Date.now() + ACCESS_FALLBACK_TTL_MS;
}

/**
 * Refresh the session with the STORED refresh token. Persists the rotated refresh
 * token IMMEDIATELY on arrival — before the access token is returned or used —
 * then caches the access token in memory. Single-flight: concurrent callers share
 * one refresh so a rotating token is never spent twice.
 * Exported with injectable deps so the rotation-persistence order is unit-testable.
 */
export async function refreshAccessToken(deps: AuthDeps = defaultDeps()): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const account = deps.loadAccount();
    if (!account) throw new Error('no Mercadona account linked');
    let session: RefreshedSession;
    try {
      session = await requestTokens(deps.fetchFn, account.refreshToken);
    } catch (e) {
      // Record the failure (token health surfaces in Settings) but keep the stored
      // token — a transient network error must not destroy the bootstrap.
      deps.persistAccount({ ...account, lastRefreshAt: new Date().toISOString(), lastRefreshOk: false });
      throw e;
    }
    // CRITICAL ORDER: persist the rotated refresh token FIRST (atomic tmp+rename via
    // the store), THEN hand out the access token. If we crash in between, the stored
    // token is the fresh one and the session survives.
    deps.persistAccount({
      ...account,
      refreshToken: session.refreshToken ?? account.refreshToken,
      customerId: session.customerId ?? account.customerId,
      lastRefreshAt: new Date().toISOString(),
      lastRefreshOk: true,
    });
    accessCache = { token: session.accessToken, exp: accessExp(session.accessToken) };
    return session.accessToken;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function getAccessToken(deps: AuthDeps = defaultDeps()): Promise<string> {
  if (accessCache && accessCache.exp > Date.now() + 60_000) return accessCache.token;
  return refreshAccessToken(deps);
}

/** Drop the in-memory access token (unlink kill switch + tests). */
export function clearSessionCache(): void {
  accessCache = null;
}

// ---- Link / unlink --------------------------------------------------------------------

export interface LinkResult {
  ok: boolean;
  label: string | null;
  customerId: string | null;
  detail?: string;
}

/**
 * Validate a pasted refresh token by performing a real refresh, and ONLY persist on
 * success — a bad paste can never clobber a working account (Tesla reauth pattern).
 * NOTE: validation SPENDS the pasted token (they rotate), so the rotated result is
 * what gets persisted. Customer id comes from the token response/JWT claims, or the
 * explicit `customerId` argument as a fallback.
 */
export async function linkAccount(
  refreshToken: string,
  customerId?: string,
  deps: AuthDeps = defaultDeps(),
): Promise<LinkResult> {
  const pasted = refreshToken.trim();
  if (!pasted) throw new Error('refresh token required');
  const session = await requestTokens(deps.fetchFn, pasted); // throws a readable error on rejection
  const cid = session.customerId ?? ((customerId ?? '').trim() || null);
  if (!cid) {
    throw new Error(
      'the token works but the customer id could not be derived — paste the customer id from the same browser session',
    );
  }
  // Persist the ROTATED token immediately (the pasted one is already spent).
  const account: KitchenMercadonaAccount = {
    refreshToken: session.refreshToken ?? pasted,
    customerId: cid,
    addressId: null,
    label: null,
    linkedAt: new Date().toISOString(),
    lastRefreshAt: new Date().toISOString(),
    lastRefreshOk: true,
  };
  deps.persistAccount(account);
  accessCache = { token: session.accessToken, exp: accessExp(session.accessToken) };
  // Best-effort enrichment: label (name/email) + default delivery address. Failures
  // here never fail the link.
  let label: string | null = null;
  try {
    const detail = await authedGet<Record<string, unknown>>(`customers/${encodeURIComponent(cid)}/`, deps);
    label = accountLabel(detail);
    const addresses = await getAddressesRaw(deps);
    const first = addresses?.[0];
    deps.persistAccount({
      ...(deps.loadAccount() ?? account),
      ...(label ? { label } : {}),
      ...(first?.id ? { addressId: first.id } : {}),
    });
  } catch {
    /* label/address are cosmetic */
  }
  return { ok: true, label, customerId: cid };
}

function accountLabel(detail: Record<string, unknown> | null): string | null {
  if (!detail) return null;
  const name = [str(detail.name), str(detail.last_name)].filter(Boolean).join(' ');
  return name || str(detail.email) || null;
}

/** Kill switch: forget the account, drop the in-memory session, re-arm dry-run. */
export function unlinkAccount(): void {
  store.update((s) => {
    s.kitchen.mercadona.account = null;
    s.kitchen.mercadona.dryRun = true;
  });
  clearSessionCache();
}

// ---- Authed fetch ---------------------------------------------------------------------

async function authedFetch(
  path: string,
  init: RequestInit = {},
  deps: AuthDeps = defaultDeps(),
  retryOn401 = true,
): Promise<Response> {
  const token = await getAccessToken(deps);
  const wh = store.get().kitchen.mercadona.warehouse;
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}/api/${path}${sep}lang=es${wh ? `&wh=${encodeURIComponent(wh)}` : ''}`;
  const res = await fetchWithTimeout(deps.fetchFn, url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (res.status === 401 && retryOn401) {
    accessCache = null; // stale access token — refresh once and retry
    await refreshAccessToken(deps);
    return authedFetch(path, init, deps, false);
  }
  return res;
}

async function authedGet<T>(path: string, deps: AuthDeps = defaultDeps()): Promise<T | null> {
  try {
    const res = await authedFetch(path, {}, deps);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (e) {
    console.error(`[mercadona-auth] GET ${path} failed:`, (e as Error).message);
    return null;
  }
}

// ---- Status (masked — safe for any GET response) ----------------------------------------

export interface MercadonaAccountStatus {
  linked: boolean;
  label: string | null;
  customerIdMasked: string | null;
  tokenMasked: string | null;
  linkedAt: string | null;
  lastRefreshAt: string | null;
  lastRefreshOk: boolean | null;
  dryRun: boolean;
  spendCapEur: number;
  warehouse: string | null;
}

export function getAccountStatus(): MercadonaAccountStatus {
  const cfg = store.get().kitchen.mercadona;
  const a = cfg.account;
  return {
    linked: Boolean(a),
    label: a?.label ?? null,
    customerIdMasked: a ? maskToken(a.customerId) : null,
    tokenMasked: a ? maskToken(a.refreshToken) : null,
    linkedAt: a?.linkedAt ?? null,
    lastRefreshAt: a?.lastRefreshAt ?? null,
    lastRefreshOk: a ? a.lastRefreshOk : null,
    dryRun: cfg.dryRun,
    spendCapEur: cfg.spendCapEur,
    warehouse: cfg.warehouse,
  };
}

// ---- Cart (the ONLY write in this module) -------------------------------------------------

export interface CartLineFlat {
  product_id: string;
  quantity: number;
}

interface RawCart {
  id?: string | number;
  version?: number;
  lines?: Array<{ product_id?: string | number; quantity?: number; product?: { id?: string | number } }>;
}

function flattenCartLines(raw: RawCart | null): CartLineFlat[] {
  const out: CartLineFlat[] = [];
  for (const l of raw?.lines ?? []) {
    const pid = str(l.product_id) ?? str(l.product?.id);
    const qty = typeof l.quantity === 'number' && l.quantity > 0 ? Math.round(l.quantity) : 0;
    if (pid && qty > 0) out.push({ product_id: pid, quantity: qty });
  }
  return out;
}

export interface FillCartResult {
  ok: boolean;
  added: number;
  cartLines: number;
  detail?: string;
}

/**
 * Add items to the account's cart in ONE batched PUT (docs/38 §3: the endpoint wants
 * FLATTENED {product_id, quantity} lines; a single batch also dodges the
 * eventual-consistency race between sequential writes). Existing cart lines are
 * preserved — our quantities merge into them. NEVER touches checkout.
 */
export async function fillCart(items: CartLineFlat[], deps: AuthDeps = defaultDeps()): Promise<FillCartResult> {
  const account = deps.loadAccount();
  if (!account) throw new Error('no Mercadona account linked');
  if (!items.length) throw new Error('nothing to add');
  const cid = encodeURIComponent(account.customerId);
  // Read the current cart first: we need its id/version for the PUT and its lines so
  // the batch MERGES instead of clobbering whatever is already in the basket.
  let raw: RawCart | null = null;
  try {
    const res = await authedFetch(`customers/${cid}/cart/`, {}, deps);
    raw = res.ok ? ((await res.json()) as RawCart) : null;
  } catch {
    raw = null;
  }
  const merged = new Map<string, number>();
  for (const l of flattenCartLines(raw)) merged.set(l.product_id, l.quantity);
  for (const it of items) merged.set(it.product_id, (merged.get(it.product_id) ?? 0) + it.quantity);
  const lines = [...merged.entries()].map(([product_id, quantity]) => ({ product_id, quantity }));
  const body: Record<string, unknown> = { lines };
  if (raw?.id != null) body.id = raw.id;
  if (typeof raw?.version === 'number') body.version = raw.version;
  const res = await authedFetch(
    `customers/${cid}/cart/`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    deps,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`cart write -> HTTP ${res.status}${text ? ` (${text.slice(0, 160)})` : ''}`);
  }
  return { ok: true, added: items.length, cartLines: lines.length };
}

// ---- Addresses + delivery slots (READ ONLY — booking stays human) ---------------------------

export interface MercadonaAddress {
  id: string;
  label: string | null;
  postalCode: string | null;
}

interface RawAddressList {
  results?: Array<Record<string, unknown>>;
  addresses?: Array<Record<string, unknown>>;
}

async function getAddressesRaw(deps: AuthDeps = defaultDeps()): Promise<MercadonaAddress[] | null> {
  const account = deps.loadAccount();
  if (!account) return null;
  const raw = await authedGet<RawAddressList | Array<Record<string, unknown>>>(
    `customers/${encodeURIComponent(account.customerId)}/addresses/`,
    deps,
  );
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : raw.results ?? raw.addresses ?? [];
  return list
    .map((a) => ({
      id: str(a.id) ?? '',
      label: str(a.address) ?? str(a.street) ?? str(a.label) ?? null,
      postalCode: str(a.postal_code) ?? str(a.postalCode) ?? null,
    }))
    .filter((a) => a.id);
}

export interface MercadonaSlot {
  id: string;
  /** ISO start/end when derivable; otherwise the API's raw display strings. */
  start: string | null;
  end: string | null;
  day: string | null;
  available: boolean;
  priceEur: number | null;
}

/** Defensive slot parse — the exact shape is undocumented, so unknown fields degrade to null. */
export function parseSlots(raw: unknown): MercadonaSlot[] {
  const list: Array<Record<string, unknown>> = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>)
    : Array.isArray((raw as { results?: unknown })?.results)
      ? ((raw as { results: Array<Record<string, unknown>> }).results)
      : Array.isArray((raw as { slots?: unknown })?.slots)
        ? ((raw as { slots: Array<Record<string, unknown>> }).slots)
        : [];
  const out: MercadonaSlot[] = [];
  for (const s of list) {
    // Nested day groups: {date, slots:[…]} — flatten one level.
    if (Array.isArray(s.slots)) {
      const day = str(s.date) ?? str(s.day);
      for (const inner of s.slots as Array<Record<string, unknown>>) out.push(parseSlot(inner, day));
      continue;
    }
    out.push(parseSlot(s, null));
  }
  return out.filter((s) => s.id || s.start || s.day);
}

function parseSlot(s: Record<string, unknown>, day: string | null): MercadonaSlot {
  const price = s.price ?? s.price_eur ?? s.cost;
  const n = typeof price === 'number' ? price : typeof price === 'string' ? parseFloat(price) : NaN;
  return {
    id: str(s.id) ?? '',
    start: str(s.start) ?? str(s.starts_at) ?? str(s.start_time) ?? null,
    end: str(s.end) ?? str(s.ends_at) ?? str(s.end_time) ?? null,
    day: day ?? str(s.date) ?? str(s.day) ?? null,
    available: s.available !== false && s.is_available !== false && s.full !== true,
    priceEur: Number.isFinite(n) ? n : null,
  };
}

/** Available delivery slots for the account's default address. READ only — the human
 *  books the slot in Mercadona at checkout. */
export async function getSlots(deps: AuthDeps = defaultDeps()): Promise<MercadonaSlot[] | null> {
  const account = deps.loadAccount();
  if (!account) return null;
  let addressId = account.addressId;
  if (!addressId) {
    const addresses = await getAddressesRaw(deps);
    addressId = addresses?.[0]?.id ?? null;
    if (addressId) {
      deps.persistAccount({ ...(deps.loadAccount() ?? account), addressId });
    }
  }
  if (!addressId) return null;
  const raw = await authedGet<unknown>(
    `customers/${encodeURIComponent(account.customerId)}/addresses/${encodeURIComponent(addressId)}/slots/`,
    deps,
  );
  return raw == null ? null : parseSlots(raw);
}

// ---- Orders (status tracking — read only) ---------------------------------------------------

export interface MercadonaOrder {
  id: string;
  status: string | null;
  createdAt: string | null;
  slotStart: string | null;
  slotEnd: string | null;
  totalEur: number | null;
}

export async function getOrders(deps: AuthDeps = defaultDeps()): Promise<MercadonaOrder[] | null> {
  const account = deps.loadAccount();
  if (!account) return null;
  const raw = await authedGet<{ results?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
    `customers/${encodeURIComponent(account.customerId)}/orders/`,
    deps,
  );
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : raw.results ?? [];
  return list.map((o) => {
    const slot = (o.slot ?? {}) as Record<string, unknown>;
    const price = o.total ?? o.price ?? o.total_price;
    const n = typeof price === 'number' ? price : typeof price === 'string' ? parseFloat(price) : NaN;
    return {
      id: str(o.id) ?? str(o.order_id) ?? '',
      status: str(o.status) ?? str(o.status_ui) ?? null,
      createdAt: str(o.created_at) ?? str(o.created) ?? null,
      slotStart: str(slot.start) ?? str(o.starts_at) ?? str(o.slot_start) ?? null,
      slotEnd: str(slot.end) ?? str(o.ends_at) ?? str(o.slot_end) ?? null,
      totalEur: Number.isFinite(n) ? n : null,
    };
  });
}

// ---- "My regulars" (staples seeding) ---------------------------------------------------------

export async function getMyRegulars(deps: AuthDeps = defaultDeps()): Promise<Array<Record<string, unknown>> | null> {
  const account = deps.loadAccount();
  if (!account) return null;
  const cid = encodeURIComponent(account.customerId);
  // Two published variants ("precision" = high-confidence). Try precision, fall back.
  for (const variant of ['precision', 'recall']) {
    const raw = await authedGet<{ results?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
      `customers/${cid}/recommendations/myregulars/${variant}/`,
      deps,
    );
    if (raw) return Array.isArray(raw) ? raw : raw.results ?? [];
  }
  return null;
}

// ---- Warehouse guard (docs/41 §2: the cart must land on the account's own store) --------------

/**
 * Verify the linked account delivers from the same warehouse the app prices against.
 * Uses the account's default address postal code → change-pc probe (stateless; reads
 * the x-customer-wh response header). Returns ok=true when indeterminable — we can't
 * verify what the API won't tell us, and blocking on that would break cart fill for
 * a response-shape change.
 */
export async function checkWarehouseMatch(
  appWarehouse: string | null,
  deps: AuthDeps = defaultDeps(),
): Promise<{ ok: boolean; accountWarehouse: string | null; postalCode: string | null }> {
  if (!appWarehouse) return { ok: true, accountWarehouse: null, postalCode: null };
  try {
    const addresses = await getAddressesRaw(deps);
    const pc = addresses?.find((a) => a.postalCode)?.postalCode ?? null;
    if (!pc) return { ok: true, accountWarehouse: null, postalCode: null };
    const res = await fetchWithTimeout(deps.fetchFn, `${BASE}/api/postal-codes/actions/change-pc/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_postal_code: pc }),
    });
    const wh = res.headers.get('x-customer-wh');
    if (!wh) return { ok: true, accountWarehouse: null, postalCode: pc };
    return { ok: wh === appWarehouse, accountWarehouse: wh, postalCode: pc };
  } catch {
    return { ok: true, accountWarehouse: null, postalCode: null };
  }
}
