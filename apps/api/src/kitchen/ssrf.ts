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

/**
 * Expand any textual IPv6 into its 8 numeric groups (handles `::` compression and a
 * dotted-v4 tail). Returns null when unparseable — callers treat that as unsafe.
 * Numeric expansion is the load-bearing part: `new URL()` CANONICALIZES literals
 * (e.g. `[::ffff:192.168.1.165]` → `[::ffff:c0a8:1a5]`) BEFORE the guard sees them,
 * so string checks against the dotted-mapped spelling alone are bypassable via the
 * hex-mapped form (PR #191 review finding #1).
 */
export function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  // Dotted-v4 tail ("…:a.b.c.d") → two hex groups, so one parser covers both spellings.
  const v4m = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4m) {
    const parts = [v4m[2], v4m[3], v4m[4], v4m[5]].map(Number);
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    s = `${v4m[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groupsStr: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // "::" must stand for at least one zero group
    groupsStr = [...head, ...(Array(missing).fill('0') as string[]), ...tail];
  } else {
    groupsStr = head;
  }
  if (groupsStr.length !== 8) return null;
  const out: number[] = [];
  for (const g of groupsStr) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** The IPv4 embedded at two adjacent groups, as dotted text. */
function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true; // unparseable → unsafe
  // v4-MAPPED ::ffff:0:0/96 (hex OR dotted spelling) and the deprecated v4-compatible
  // ::/96 (which also covers :: and ::1): judge the embedded v4 with the v4 rules.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
    return isPrivateV4(embeddedV4(g[6], g[7]));
  }
  // NAT64 well-known prefix 64:ff9b::/96 also embeds a v4.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPrivateV4(embeddedV4(g[6], g[7]));
  }
  // 6to4 2002::/16 embeds a v4 in groups 1–2.
  if (g[0] === 0x2002) return isPrivateV4(embeddedV4(g[1], g[2]));
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
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
