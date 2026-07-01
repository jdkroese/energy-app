import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Last-good response cache, keyed by the FETCHER FUNCTION identity. When a screen
 * remounts (e.g. navigating back to Devices), its polls previously started cold —
 * `data: null, loading: true` — flashing a spinner and blocking on a network
 * round-trip every single time. This cache lets a remount seed its first render
 * synchronously from the previous value, then revalidate in the background:
 * client-side stale-while-revalidate.
 *
 * Keyed by the fetcher reference, so only STABLE fetchers (e.g. `api.blinds.list`,
 * defined once on the `api` object) share a slot across mounts and benefit. Inline
 * arrow fetchers get a fresh identity each render, miss the cache, and behave
 * exactly as before. A WeakMap means entries for GC'd fetchers vanish on their own.
 */
const lastGood = new WeakMap<object, { data: unknown; ts: number }>();

export interface PollingState<T> {
  /** Last successfully-fetched value (kept on error → keep-last-good). */
  data: T | null;
  /** True until the first successful (or failed) fetch resolves. */
  loading: boolean;
  /** Most recent error, cleared on the next success. */
  error: Error | null;
  /** True when the last refetch failed but we're still showing older data. */
  stale: boolean;
  /** Timestamp (ms) of the last successful fetch. */
  updatedAt: number | null;
  /** Force an immediate refetch; resolves when that fetch settles. */
  refetch: () => Promise<void>;
}

/**
 * usePolling — fetch + setInterval, keeping the last good value across refetch
 * errors and exposing a `stale` flag. No external data-lib dependency.
 *
 * @param fetcher async function returning the data
 * @param intervalMs poll cadence; pass 0/undefined to fetch once
 * @param deps re-create the loop when these change (e.g. a range selector)
 * @param enabled when false, skips fetching entirely (no initial fetch, no
 *   interval) — used to defer data for tabs/views the user isn't looking at.
 *   The last-good `data` is kept, and `loading` clears so callers don't show a
 *   permanent spinner for a paused poll. Flip back to true to fetch immediately
 *   and resume polling. Defaults to true (existing call sites are unaffected).
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 0,
  deps: ReadonlyArray<unknown> = [],
  enabled = true,
): PollingState<T> {
  // Seed the first render from the last-good cache (if this exact fetcher has run
  // before), so a remount shows prior data instantly instead of a spinner. A cache
  // hit means loading is already false — the effect below still revalidates in the
  // background. A miss keeps the original cold-start behaviour (null + loading).
  const seed = lastGood.get(fetcher) as { data: T; ts: number } | undefined;
  const [data, setData] = useState<T | null>(seed ? seed.data : null);
  const [loading, setLoading] = useState(!seed);
  const [error, setError] = useState<Error | null>(null);
  const [stale, setStale] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(seed ? seed.ts : null);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // Holds the current effect's fetch routine so refetch() can invoke it directly
  // and return its promise (so callers can `await refetch()`).
  const runRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    // Paused (deferred) — don't fetch or poll. Keep the last-good `data`, and
    // clear `loading` so a gated view never shows a perpetual spinner.
    if (!enabled) {
      setLoading(false);
      return;
    }
    let alive = true;
    const run = async () => {
      try {
        const d = await fetcherRef.current();
        // Cache the fresh value against the fetcher identity so the next remount
        // of this poll renders it immediately (client-side SWR). Written even if
        // this instance was unmounted mid-flight, so the value isn't lost.
        lastGood.set(fetcherRef.current, { data: d, ts: Date.now() });
        if (!alive) return;
        setData(d);
        setError(null);
        setStale(false);
        setUpdatedAt(Date.now());
      } catch (e) {
        if (!alive) return;
        setError(e as Error);
        setStale(true);
      } finally {
        if (alive) setLoading(false);
      }
    };
    runRef.current = run;
    run(); // initial fetch fires regardless of tab visibility
    if (intervalMs > 0) {
      // Skip ticks while the tab is hidden — no point polling a backgrounded
      // app (saves network + battery). On return to foreground, refetch at once
      // so the user sees fresh data instead of waiting up to a full interval.
      const id = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        run();
      }, intervalMs);
      const onVisible = () => {
        if (typeof document !== 'undefined' && !document.hidden) run();
      };
      const hasDoc = typeof document !== 'undefined';
      if (hasDoc) document.addEventListener('visibilitychange', onVisible);
      return () => {
        alive = false;
        clearInterval(id);
        if (hasDoc) document.removeEventListener('visibilitychange', onVisible);
      };
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, ...deps]);

  const refetch = useCallback(() => runRef.current(), []);

  return { data, loading, error, stale, updatedAt, refetch };
}
