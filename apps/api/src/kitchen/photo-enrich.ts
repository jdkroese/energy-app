// Photo enrichment coordinator (docs/47 §3b, hardened docs/48 §4b) — same idle-tick pattern
// as library-generate.ts, but deliberately simpler: it is STATELESS by construction. There is
// no job to persist or resume; recipesRepo.nextPhotoWorkItem() (photo-null first, then
// provider-hotlinked, then og:image-import backfill) IS the queue, so a restart mid-run just
// picks up wherever the query lands next. Runs alongside the bulk generator without competing
// with it — this coordinator never touches kitchen.libraryGeneration and never calls the
// Anthropic API, so it can't affect the generation budget/cap, and a generation run can't
// starve it either (they're independent timers over independent state).
//
// The flow per candidate is now (docs/48 §4b — "no more hotlink-first"):
//   search (photo-null only) → relevance guard (inside searchFoodPhoto) → download + validate
//   (photo-cache.ts) → set photo (to the LOCAL /api/kitchen/photos/:id route) + credit,
//   atomically, only once the file is actually on disk. A download failure leaves the
//   recipe exactly as it was — retryable next tick, never marked photo_tried_at (that marker
//   means "no result exists", not "transfer hiccup").
//
// Fail-soft (mirrors every other coordinator in this app): any error is caught and logged,
// never thrown into the boot path or a request path.

import * as store from '../store';
import * as recipesRepo from './recipes-repo';
import { buildPhotoQueries, preferredProvider, searchFoodPhoto } from './photo-providers';
import { downloadAndCache } from './photo-cache';

const RETRY_NO_HIT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TICK_MS = 20_000; // matches the provider throttle cadence — at most one attempt per tick

function pexelsKey(): string | null {
  return store.get().kitchen.intelligence.pexelsApiKey || null;
}

/** Library card "Commons + Openverse · free" / "Pexels · fast" status line. */
export function currentProvider(): 'pexels' | 'commons+openverse' {
  return preferredProvider(pexelsKey());
}

let ticking = false;

/** One coordinator step: pick the next photo work item (search a photo-null recipe, or
 *  download-and-cache an already-hotlinked one) and act on it. Re-entrancy guarded like the
 *  other kitchen coordinators. A 'throttled' search or a download-throttle outcome leaves the
 *  candidate exactly as it was — retried on a later tick, never marked as a permanent miss. */
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const item = recipesRepo.nextPhotoWorkItem(now, RETRY_NO_HIT_MS);
    if (!item) return; // fully caught up (or every remaining miss is in its 30-day cool-off)

    if (item.mode === 'cache-only') {
      // Already has a remote URL (provider hotlink or og:image import) — just needs
      // downloading; no search, no relevance guard (it was already accepted once, or is the
      // recipe's own imported photo).
      const photo = item.recipe.photo;
      if (!photo) return; // shouldn't happen (nextPhotoWorkItem only returns cache-only items with a photo), fail-soft
      const dl = await downloadAndCache(item.recipe.id, photo);
      if (dl.kind === 'cached') {
        recipesRepo.setRecipePhotoLocal(item.recipe.id, dl.route);
      }
      // 'throttled' / 'invalid' / 'error' — leave the recipe exactly as-is (still hotlinked,
      // still rendering fine today); next tick tries again or moves to another candidate.
      return;
    }

    // mode === 'search'
    const { primary, fallback, fallbackGuardText } = buildPhotoQueries(item.recipe);
    const outcome = await searchFoodPhoto({
      recipeTitle: item.recipe.title,
      primaryQuery: primary,
      fallbackQuery: fallback,
      fallbackGuardText,
      pexelsApiKey: pexelsKey(),
    });

    if (outcome.kind === 'found') {
      const dl = await downloadAndCache(item.recipe.id, outcome.result.url);
      if (dl.kind === 'cached') {
        recipesRepo.setRecipePhoto(item.recipe.id, dl.route, {
          name: outcome.result.credit,
          url: outcome.result.creditUrl,
          provider: outcome.result.provider,
          ...(outcome.result.license ? { license: outcome.result.license } : {}),
        });
      }
      // download 'throttled'/'invalid'/'error' — recipe stays exactly as it was (photo null,
      // no tried marker): a download hiccup is NEVER a definitive no-hit, so the next tick
      // just searches again (docs/48 §4b).
    } else if (outcome.kind === 'no-hit') {
      recipesRepo.markPhotoTried(item.recipe.id, new Date(now).toISOString());
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
 *  "every recipe gets a real, durable photo" half of docs/47/docs/48's zero-button-press brief. */
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
