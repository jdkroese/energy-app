// Tiny TTL memo cache that also coalesces concurrent calls. Keeps upstream API
// volume bounded regardless of how often clients/the alert-loop poll — critical
// for the pay-as-you-go Tesla Fleet API. Successes are cached for ttlMs; errors
// are not cached (next call retries) and never served stale.
const hits = new Map<string, { at: number; val: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = hits.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.val as T);

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
}
