// SSRF guard for user-supplied URLs (docs/41 hardening #1 — review follow-up from
// PR #190). The recipe importer fetches arbitrary URLs server-side; without this a
// crafted "recipe" URL could probe the LAN (Sonnen/Tesla/Airzone/Tuya devices all
// live on it). Policy: resolve the hostname and refuse when ANY resolved address is
// private/loopback/link-local — and re-check every redirect hop.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** True for addresses a household server must never fetch on a user's behalf. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true; // not an IP at all — treat as unsafe
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // this-net, RFC1918, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const low = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — judge the embedded v4.
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  if (low === '::' || low === '::1') return true; // unspecified + loopback
  if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true; // link-local fe80::/10
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // ULA fc00::/7
  if (low.startsWith('ff')) return true; // multicast
  return false;
}

export class SsrfBlockedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Throw SsrfBlockedError unless the URL is http(s) to a public host. Resolves the
 * hostname (all A/AAAA records) so DNS names pointing into the LAN are caught too.
 * The resolver is injectable for unit tests.
 */
export async function assertPublicUrl(
  url: URL,
  resolve: (host: string) => Promise<Array<{ address: string }>> = (host) => lookup(host, { all: true }),
): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfBlockedError('only http(s) URLs are allowed');
  // Strip IPv6 brackets for literal checks.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
    throw new SsrfBlockedError(`host "${host}" is not a public address`);
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new SsrfBlockedError(`address ${host} is private — refusing to fetch`);
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await resolve(host);
  } catch {
    throw new SsrfBlockedError(`host "${host}" did not resolve`);
  }
  if (!addrs.length) throw new SsrfBlockedError(`host "${host}" did not resolve`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new SsrfBlockedError(`host "${host}" resolves to a private address — refusing to fetch`);
    }
  }
}

const MAX_REDIRECTS = 5;

/**
 * fetch() with the SSRF guard applied to the initial URL AND every redirect hop
 * (redirects are followed manually so each Location is re-checked — a public host
 * 302-ing to http://192.168.1.x is exactly the bypass this closes).
 */
export async function guardedFetch(
  urlStr: string,
  init: RequestInit,
  fetchFn: typeof fetch = fetch,
  resolve?: (host: string) => Promise<Array<{ address: string }>>,
): Promise<Response> {
  let url = new URL(urlStr);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url, resolve);
    const res = await fetchFn(url.toString(), { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      url = new URL(loc, url); // relative redirects resolve against the current hop
      continue;
    }
    return res;
  }
  throw new SsrfBlockedError(`too many redirects (> ${MAX_REDIRECTS})`);
}
