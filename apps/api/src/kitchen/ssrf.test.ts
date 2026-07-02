// SSRF guard matrix (docs/41 hardening #1 + acceptance): 10.x / 127.x / 169.254 /
// 172.16-31 / 192.168 / CGNAT / fe80 / ::1 / DNS-to-private / redirect-to-private.
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/kitchen/ssrf.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertPublicUrl, expandV6, guardedFetch, isPrivateIp, SsrfBlockedError } from './ssrf';

// ---- isPrivateIp matrix -----------------------------------------------------------------

test('private/loopback/link-local IPv4 ranges are rejected', () => {
  for (const ip of [
    '10.0.0.1',
    '10.255.255.255',
    '127.0.0.1',
    '127.8.8.8',
    '169.254.1.1',
    '172.16.0.1',
    '172.31.255.1',
    '192.168.1.165', // the Airzone webserver — exactly what must never be fetchable
    '100.64.0.1', // CGNAT (the house's own WAN reality)
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} must be private`);
  }
});

test('public IPv4 addresses pass', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '11.0.0.1', '169.253.1.1']) {
    assert.equal(isPrivateIp(ip), false, `${ip} must be public`);
  }
});

test('IPv6 loopback/link-local/ULA/mapped-private are rejected', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fe80::abcd:1', 'fc00::1', 'fd12:3456::1', '::ffff:192.168.1.1', '::ffff:10.0.0.1', 'ff02::1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} must be private`);
  }
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false);
  assert.equal(isPrivateIp('::ffff:8.8.8.8'), false);
});

test('garbage that is not an IP is treated as unsafe', () => {
  assert.equal(isPrivateIp('not-an-ip'), true);
  assert.equal(isPrivateIp('999.1.1.1'), true);
});

test('HEX-spelled v4-mapped literals are judged by the embedded v4 (URL-canonicalized form)', () => {
  // new URL() canonicalizes [::ffff:192.168.1.165] to [::ffff:c0a8:1a5] — the hex
  // spelling MUST be caught too (PR #191 review finding #1).
  assert.equal(isPrivateIp('::ffff:c0a8:1a5'), true); // 192.168.1.165
  assert.equal(isPrivateIp('::ffff:7f00:1'), true); // 127.0.0.1
  assert.equal(isPrivateIp('::ffff:a00:1'), true); // 10.0.0.1
  assert.equal(isPrivateIp('::ffff:a9fe:a9fe'), true); // 169.254.169.254
  assert.equal(isPrivateIp('::ffff:6440:1'), true); // 100.64.0.1 (CGNAT)
  assert.equal(isPrivateIp('::ffff:808:808'), false); // 8.8.8.8 — public stays public
  // Other v4-embedding prefixes: v4-compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16.
  assert.equal(isPrivateIp('::c0a8:101'), true); // v4-compatible 192.168.1.1
  assert.equal(isPrivateIp('64:ff9b::a00:1'), true); // NAT64 → 10.0.0.1
  assert.equal(isPrivateIp('64:ff9b::808:808'), false); // NAT64 → 8.8.8.8
  assert.equal(isPrivateIp('2002:c0a8:101::'), true); // 6to4 → 192.168.1.1
});

test('expandV6 parses compression + dotted tails and rejects garbage', () => {
  assert.deepEqual(expandV6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandV6('::ffff:192.168.1.165'), [0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x01a5]);
  assert.deepEqual(expandV6('::ffff:c0a8:1a5'), [0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x01a5]);
  assert.deepEqual(expandV6('2606:4700:4700::1111'), [0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111]);
  assert.equal(expandV6('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(expandV6('1::2::3'), null);
  assert.equal(expandV6('::ffff:999.1.1.1'), null);
  assert.equal(expandV6('nonsense'), null);
});

// ---- assertPublicUrl ---------------------------------------------------------------------

const resolveTo = (ips: string[]) => async () => ips.map((address) => ({ address }));

test('IP-literal URLs in private ranges are blocked without a DNS call', async () => {
  for (const host of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '192.168.1.10', '[::1]']) {
    await assert.rejects(assertPublicUrl(new URL(`http://${host}/recipe`)), SsrfBlockedError, host);
  }
});

test('v4-mapped IPv6 URLs are blocked THROUGH the production path — hex and dotted spellings', async () => {
  // The load-bearing detail (PR #191 review finding #1): new URL() canonicalizes the
  // literal BEFORE assertPublicUrl ever sees it (dotted → hex), so these must go
  // through full URLs, not bare isPrivateIp() strings.
  for (const url of [
    'http://[::ffff:c0a8:1a5]/', // 192.168.1.165 (Airzone) — hex-mapped
    'http://[::ffff:192.168.1.165]/', // same, dotted (canonicalized to hex by URL)
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/', // 127.0.0.1 — hex-mapped
    'http://[::ffff:a00:1]/', // 10.0.0.1 — hex-mapped
    'http://[::ffff:a9fe:a9fe]/', // 169.254.169.254 (metadata endpoint)
    'http://[64:ff9b::c0a8:1a5]/', // NAT64-embedded 192.168.1.165
  ]) {
    const parsed = new URL(url); // never throws for these — the guard must do the work
    await assert.rejects(assertPublicUrl(parsed), SsrfBlockedError, `${url} (hostname became "${parsed.hostname}")`);
  }
  // A public v4-mapped literal still passes the same path.
  await assert.doesNotReject(assertPublicUrl(new URL('http://[::ffff:808:808]/')));
});

test('localhost / .local / .lan / .internal hostnames are blocked', async () => {
  for (const host of ['localhost', 'sonos.local', 'router.lan', 'db.internal']) {
    await assert.rejects(assertPublicUrl(new URL(`https://${host}/`)), SsrfBlockedError, host);
  }
});

test('a DNS name resolving to a private address is blocked — even mixed with public', async () => {
  await assert.rejects(
    assertPublicUrl(new URL('https://evil.example.com/recipe'), resolveTo(['93.184.216.34', '192.168.1.165'])),
    SsrfBlockedError,
  );
});

test('a public https URL resolving publicly passes; non-http(s) schemes are blocked', async () => {
  await assert.doesNotReject(assertPublicUrl(new URL('https://www.recetasderechupete.com/x'), resolveTo(['93.184.216.34'])));
  await assert.rejects(assertPublicUrl(new URL('ftp://example.com/'), resolveTo(['93.184.216.34'])), SsrfBlockedError);
});

// ---- Redirect re-check (guardedFetch) -------------------------------------------------------

function fakeFetch(hops: Record<string, { status: number; location?: string }>): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0]) => {
    const key = String(url);
    const hop = hops[key];
    if (!hop) throw new Error(`unexpected fetch ${key}`);
    return new Response(hop.status < 300 ? 'ok' : null, {
      status: hop.status,
      headers: hop.location ? { location: hop.location } : {},
    });
  }) as typeof fetch;
}

test('a public host redirecting into the LAN is blocked at the hop', async () => {
  const fetchFn = fakeFetch({
    'https://blog.example.com/recipe': { status: 302, location: 'http://192.168.1.165/api/v1/' },
  });
  await assert.rejects(
    guardedFetch('https://blog.example.com/recipe', {}, fetchFn, resolveTo(['93.184.216.34'])),
    SsrfBlockedError,
  );
});

test('a public→public redirect chain is followed and returns the final response', async () => {
  const fetchFn = fakeFetch({
    'https://a.example.com/': { status: 301, location: 'https://b.example.com/page' },
    'https://b.example.com/page': { status: 200 },
  });
  const res = await guardedFetch('https://a.example.com/', {}, fetchFn, resolveTo(['93.184.216.34']));
  assert.equal(res.status, 200);
});

test('relative redirects resolve against the current hop and are still checked', async () => {
  const fetchFn = fakeFetch({
    'https://a.example.com/start': { status: 302, location: '/next' },
    'https://a.example.com/next': { status: 200 },
  });
  const res = await guardedFetch('https://a.example.com/start', {}, fetchFn, resolveTo(['93.184.216.34']));
  assert.equal(res.status, 200);
});

test('endless redirect loops give up after the hop budget', async () => {
  const fetchFn = fakeFetch({
    'https://a.example.com/loop': { status: 302, location: 'https://a.example.com/loop' },
  });
  await assert.rejects(guardedFetch('https://a.example.com/loop', {}, fetchFn, resolveTo(['93.184.216.34'])), SsrfBlockedError);
});
