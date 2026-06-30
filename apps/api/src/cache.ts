// Tiny TTL memo cache that also coalesces concurrent calls. Keeps upstream API
// volume bounded regardless of how often clients/the alert-loop poll — critical
// for the pay-as-you-go Tesla Fleet API. Successes are cached for ttlMs; errors
// are not cached (next call retries) and never served stale.
const hits = new Map<string, { at: number; val: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

interface CacheOpts {
  /**
   * Stale-while-revalidate window (ms). When set, an expired-but-still-recent
   * value (older than ttlMs but younger than ttlMs + staleMs) is returned
   * IMMEDIATELY while a refresh runs in the background — so a slow upstream
   * never blocks the caller. Beyond ttlMs + staleMs the value is too old to
   * serve and the call blocks on a fresh fetch. Omit for the default behaviour
   * (block on every expiry). The background refresh is still coalesced via the
   * inflight map, so upstream call volume is unchanged.
   */
  staleMs?: number;
}

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, opts?: CacheOpts): Promise<T> {
  const hit = hits.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < ttlMs) return Promise.resolve(hit.val as T);

  // Refresh (coalesced): one in-flight fetch per key, result cached on success.
  const refresh = (): Promise<T> => {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn()
      .then((val) => {
        hits.set(key, { at: Date.now(), val });
        return val;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  // Stale-while-revalidate: serve the recent-enough stale value now, refresh in
  // the background. A failed background refresh keeps the stale value (we only
  // overwrite on success), so a flaky upstream degrades to "last good" rather
  // than blocking.
  const staleMs = opts?.staleMs ?? 0;
  if (hit && staleMs > 0 && age < ttlMs + staleMs) {
    void refresh().catch(() => undefined);
    return Promise.resolve(hit.val as T);
  }

  return refresh();
}

/** Drop a cached entry so the next cached() call for this key refetches. Used
 *  after a write so a control action is reflected immediately, not after the TTL. */
export function invalidate(key: string): void {
  hits.delete(key);
}
