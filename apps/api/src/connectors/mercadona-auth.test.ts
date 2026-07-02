// Unit tests for the Mercadona session (P2, docs/41 acceptance: "token rotation
// persistence (inject fs)"). The AuthDeps seam injects fetch + load/persist, so these
// assert the CRITICAL ordering — the rotated refresh token is persisted BEFORE the
// access token is handed out — plus the failure/single-flight/link-validation paths,
// all without touching the network or the real store.
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/connectors/mercadona-auth.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The auth module touches the app store for the warehouse param on authed GETs —
// point the store at a throwaway file so tests never read/write real state.
// (Lazy load: setting the env before the first store.get() is sufficient.)
process.env.STATE_FILE = join(mkdtempSync(join(tmpdir(), 'mercadona-auth-test-')), 'state.json');

import {
  clearSessionCache,
  decodeJwtPayload,
  linkAccount,
  maskToken,
  refreshAccessToken,
  type AuthDeps,
} from './mercadona-auth';
import type { KitchenMercadonaAccount } from '../store';

function account(overrides: Partial<KitchenMercadonaAccount> = {}): KitchenMercadonaAccount {
  return {
    refreshToken: 'refresh-OLD',
    customerId: 'cust-1',
    addressId: null,
    label: null,
    linkedAt: '2026-07-01T00:00:00.000Z',
    lastRefreshAt: null,
    lastRefreshOk: true,
    ...overrides,
  };
}

/** In-memory "fs": persistAccount overwrites the record; every persist is logged. */
function memDeps(fetchFn: typeof fetch, initial: KitchenMercadonaAccount | null): AuthDeps & {
  persisted: KitchenMercadonaAccount[];
  current: () => KitchenMercadonaAccount | null;
} {
  let stored = initial;
  const persisted: KitchenMercadonaAccount[] = [];
  return {
    fetchFn,
    loadAccount: () => stored,
    persistAccount: (a) => {
      stored = a;
      persisted.push({ ...a });
    },
    persisted,
    current: () => stored,
  };
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ---- Rotation persistence (the load-bearing behavior) --------------------------------

test('the rotated refresh token is persisted BEFORE the access token is returned', async () => {
  clearSessionCache();
  const order: string[] = [];
  const fetchFn = (async () => {
    order.push('fetch');
    return tokenResponse({ access_token: 'access-1', refresh_token: 'refresh-NEW' });
  }) as typeof fetch;
  const deps = memDeps(fetchFn, account());
  const origPersist = deps.persistAccount;
  deps.persistAccount = (a) => {
    order.push(`persist:${a.refreshToken}`);
    origPersist(a);
  };
  const token = await refreshAccessToken(deps);
  order.push('token-available');
  assert.equal(token, 'access-1');
  // The persist of the ROTATED token happens before the caller can use the access token.
  assert.deepEqual(order, ['fetch', 'persist:refresh-NEW', 'token-available']);
  assert.equal(deps.current()?.refreshToken, 'refresh-NEW');
  assert.equal(deps.current()?.lastRefreshOk, true);
});

test('a non-rotating response keeps the stored token and records the refresh', async () => {
  clearSessionCache();
  const fetchFn = (async () => tokenResponse({ access_token: 'access-2' })) as typeof fetch;
  const deps = memDeps(fetchFn, account());
  await refreshAccessToken(deps);
  assert.equal(deps.current()?.refreshToken, 'refresh-OLD');
  assert.equal(deps.current()?.lastRefreshOk, true);
  assert.ok(deps.current()?.lastRefreshAt);
});

test('a transient failure NEVER destroys the stored token (only marks health)', async () => {
  clearSessionCache();
  const fetchFn = (async () => tokenResponse({}, 500)) as typeof fetch;
  const deps = memDeps(fetchFn, account());
  await assert.rejects(refreshAccessToken(deps), /HTTP 500/);
  assert.equal(deps.current()?.refreshToken, 'refresh-OLD'); // bootstrap survives
  assert.equal(deps.current()?.lastRefreshOk, false);
});

test('a 401 surfaces a readable re-link hint', async () => {
  clearSessionCache();
  const fetchFn = (async () => tokenResponse({}, 401)) as typeof fetch;
  const deps = memDeps(fetchFn, account());
  await assert.rejects(refreshAccessToken(deps), /re-link the account/);
});

test('single-flight: concurrent refreshes spend the rotating token exactly once', async () => {
  clearSessionCache();
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return tokenResponse({ access_token: 'access-3', refresh_token: `refresh-${calls}` });
  }) as typeof fetch;
  const deps = memDeps(fetchFn, account());
  const [a, b, c] = await Promise.all([refreshAccessToken(deps), refreshAccessToken(deps), refreshAccessToken(deps)]);
  assert.equal(calls, 1); // ONE network refresh — a rotating token must never be double-spent
  assert.equal(a, 'access-3');
  assert.equal(b, 'access-3');
  assert.equal(c, 'access-3');
  assert.equal(deps.current()?.refreshToken, 'refresh-1');
});

// ---- linkAccount (validate-then-persist, Tesla reauth pattern) ---------------------------

test('a rejected pasted token persists NOTHING (a bad paste cannot clobber a working link)', async () => {
  clearSessionCache();
  const fetchFn = (async () => tokenResponse({ detail: 'invalid' }, 401)) as typeof fetch;
  const deps = memDeps(fetchFn, account()); // an existing working account is stored
  await assert.rejects(linkAccount('pasted-bad-token', undefined, deps), /HTTP 401/);
  assert.equal(deps.persisted.length, 0);
  assert.equal(deps.current()?.refreshToken, 'refresh-OLD');
});

test('a valid pasted token links, persisting the ROTATED token (the paste is spent)', async () => {
  clearSessionCache();
  const fetchFn = (async (url: Parameters<typeof fetch>[0]) => {
    const u = String(url);
    if (u.includes('/api/auth/tokens/')) {
      return tokenResponse({ access_token: 'access-l', refresh_token: 'refresh-ROTATED', customer_id: 'cust-77' });
    }
    return tokenResponse({}, 404); // enrichment lookups may fail — the link still succeeds
  }) as typeof fetch;
  const deps = memDeps(fetchFn, null);
  const result = await linkAccount('pasted-token', undefined, deps);
  assert.equal(result.ok, true);
  assert.equal(result.customerId, 'cust-77');
  assert.equal(deps.current()?.refreshToken, 'refresh-ROTATED');
  assert.equal(deps.current()?.customerId, 'cust-77');
});

test('customer id falls back to the JWT claim, then the explicit argument', async () => {
  clearSessionCache();
  const claims = Buffer.from(JSON.stringify({ customer_id: 'cust-jwt', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url');
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${claims}.sig`;
  const fetchFn = (async (url: Parameters<typeof fetch>[0]) =>
    String(url).includes('/api/auth/tokens/') ? tokenResponse({ access_token: jwt }) : tokenResponse({}, 404)) as typeof fetch;
  const deps = memDeps(fetchFn, null);
  const viaJwt = await linkAccount('t', undefined, deps);
  assert.equal(viaJwt.customerId, 'cust-jwt');

  clearSessionCache();
  const plainFetch = (async (url: Parameters<typeof fetch>[0]) =>
    String(url).includes('/api/auth/tokens/') ? tokenResponse({ access_token: 'opaque-token' }) : tokenResponse({}, 404)) as typeof fetch;
  const deps2 = memDeps(plainFetch, null);
  const viaArg = await linkAccount('t', 'cust-manual', deps2);
  assert.equal(viaArg.customerId, 'cust-manual');
  await assert.rejects(linkAccount('t', undefined, memDeps(plainFetch, null)), /customer id could not be derived/);
});

// ---- Masking (tokens are never exposed raw) -------------------------------------------------

test('maskToken never returns enough of the token to be useful', () => {
  assert.equal(maskToken(null), null);
  assert.equal(maskToken('short'), '••••••••');
  const masked = maskToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9-something-long');
  assert.ok(masked);
  assert.ok(masked.includes('••••••••'));
  assert.ok(masked.length < 25);
});

test('decodeJwtPayload survives garbage', () => {
  assert.equal(decodeJwtPayload('not-a-jwt'), null);
  assert.equal(decodeJwtPayload('a.b.c'), null);
});
