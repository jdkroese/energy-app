// Photo enrichment coordinator (docs/47 §3b) — same idle-tick pattern as library-generate.ts,
// but deliberately simpler: it is STATELESS by construction. There is no job to persist or
// resume; "the next recipe with photo == null" (recipes-repo.nextPhotoEnrichmentCandidate) IS
// the queue, so a restart mid-run just picks up wherever the query lands next. Runs alongside
// the bulk generator without competing with it — this coordinator never touches
// kitchen.libraryGeneration and never calls the Anthropic API, so it can't affect the
// generation budget/cap, and a generation run can't starve it either (they're independent
// timers over independent state).
//
// Fail-soft (mirrors every other coordinator in this app): any error is caught and logged,
// never thrown into the boot path or a request path.

import * as store from '../store';
import * as recipesRepo from './recipes-repo';
import { buildPhotoQueries, preferredProvider, searchFoodPhoto } from './photo-providers';

const RETRY_NO_HIT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TICK_MS = 20_000; // matches the provider throttle cadence — at most one attempt per tick

function pexelsKey(): string | null {
  return store.get().kitchen.intelligence.pexelsApiKey || null;
}

/** Library card "Openverse - free" / "Pexels - fast" status line. */
export function currentProvider(): 'openverse' | 'pexels' {
  return preferredProvider(pexelsKey());
}

let ticking = false;

/** One coordinator step: pick the next photo-null recipe (any source), try to find + store a
 *  photo for it, or mark it tried on a definitive no-hit. Re-entrancy guarded like the other
 *  kitchen coordinators. A 'throttled' or transient 'error' outcome leaves the candidate
 *  exactly as it was — retried on a later tick, never marked as a permanent miss. */
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const candidate = recipesRepo.nextPhotoEnrichmentCandidate(now, RETRY_NO_HIT_MS);
    if (!candidate) return; // fully caught up (or every remaining miss is in its 30-day cool-off)

    const { primary, fallback } = buildPhotoQueries(candidate);
    const outcome = await searchFoodPhoto({ primaryQuery: primary, fallbackQuery: fallback, pexelsApiKey: pexelsKey() });

    if (outcome.kind === 'found') {
      recipesRepo.setRecipePhoto(candidate.id, outcome.result.url, {
        name: outcome.result.credit,
        url: outcome.result.creditUrl,
        provider: outcome.result.provider,
      });
    } else if (outcome.kind === 'no-hit') {
      recipesRepo.markPhotoTried(candidate.id, new Date(now).toISOString());
    }
    // 'throttled' / 'error' — nothing to persist, next tick just tries the same candidate again.
  } catch (e) {
    console.error('[photo-enrich] tick failed:', (e as Error).message);
  } finally {
    ticking = false;
  }
}

let coordinatorHandle: ReturnType<typeof setInterval> | null = null;

/** Boot wiring (index.ts): start the poll timer. No owner action needed — this is the
 *  "every recipe gets a real photo" half of docs/47's zero-button-press brief. */
export function startPhotoEnrichmentCoordinator(): void {
  if (coordinatorHandle) return;
  coordinatorHandle = setInterval(() => void tick(), TICK_MS);
  void tick();
}

/** Test-only: stop the poll timer (avoids leaking an interval across test files). */
export function _stopCoordinatorForTests(): void {
  if (coordinatorHandle) clearInterval(coordinatorHandle);
  coordinatorHandle = null;
}
