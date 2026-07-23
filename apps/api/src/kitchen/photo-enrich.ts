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
// DEAD-URL WEDGE GUARD (docs/48 W1 review fix): "retryable" must not mean "retried with the
// identical inputs forever". The queue and the search are both deterministic, so a recipe
// whose top search hit downloads as INVALID (dead link / html error page / <10KB — not a
// transient throttle or network blip) would otherwise be re-picked, re-searched, re-picked
// the same dead URL, and re-fail identically every tick — wedging every recipe behind it and
// burning the Openverse daily budget on repeats. The in-memory tracker below remembers, per
// recipe, which URLs downloaded invalid (fed back into searchFoodPhoto as skipUrls so the
// NEXT candidate gets its chance) and how many invalid downloads the recipe has racked up;
// at 3 the recipe is treated as a functional no-hit: search-mode → markPhotoTried (30-day
// cool-off), cache-only → skipped for the rest of the process lifetime (it keeps rendering
// via its existing hotlink). In-memory on purpose — resets on restart, self-corrects.
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

// ---- Per-recipe invalid-download tracker (docs/48 W1) -----------------------------------------

interface PhotoFailures {
  badUrls: Set<string>;
  invalidCount: number;
}

/** Give up on a recipe after this many INVALID downloads (throttled/network-error never count). */
const INVALID_DOWNLOAD_LIMIT = 3;
/** Bound the tracker — drop-oldest beyond this. 500 recipes' worth of failure state is plenty:
 *  the queue only ever works one recipe at a time, so old entries are long-settled. */
const MAX_TRACKED_RECIPES = 500;

const photoFailures = new Map<string, PhotoFailures>();

function failuresFor(recipeId: string): PhotoFailures {
  let f = photoFailures.get(recipeId);
  if (!f) {
    f = { badUrls: new Set<string>(), invalidCount: 0 };
    photoFailures.set(recipeId, f);
    if (photoFailures.size > MAX_TRACKED_RECIPES) {
      // Map iterates in insertion order — the first key is the oldest entry.
      const oldest = photoFailures.keys().next().value;
      if (oldest !== undefined) photoFailures.delete(oldest);
    }
  }
  return f;
}

/** Record one INVALID download (dead link / wrong content-type / too small) for a recipe.
 *  Returns the recipe's new invalid count. */
function recordInvalidDownload(recipeId: string, url: string): number {
  const f = failuresFor(recipeId);
  f.badUrls.add(url);
  f.invalidCount += 1;
  return f.invalidCount;
}

/** Cache-only backfill items that have exhausted their invalid budget — nextPhotoWorkItem
 *  skips these so the queue keeps moving past a permanently dead hotlink. */
function cacheOnlySkipIds(): Set<string> {
  const out = new Set<string>();
  for (const [id, f] of photoFailures) {
    if (f.invalidCount >= INVALID_DOWNLOAD_LIMIT) out.add(id);
  }
  return out;
}

/** Test-only: clear the invalid-download tracker between test cases. */
export function _resetFailuresForTests(): void {
  photoFailures.clear();
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
    const item = recipesRepo.nextPhotoWorkItem(now, RETRY_NO_HIT_MS, cacheOnlySkipIds());
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
      } else if (dl.kind === 'invalid') {
        // The recipe's ONE existing URL is bad (dead link / html error page / too small) —
        // count it; at the limit, cacheOnlySkipIds() excludes this recipe from the queue for
        // the rest of the process lifetime. Harmless: it keeps rendering via its hotlink.
        recordInvalidDownload(item.recipe.id, photo);
      }
      // 'throttled' / network 'error' — genuinely transient, leave the recipe exactly as-is
      // (still hotlinked, still rendering fine today); next tick just tries again.
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
      // URLs that already downloaded as invalid for this recipe — skipped in the candidate
      // pick so the next relevant result gets its chance instead of the same dead top hit.
      skipUrls: photoFailures.get(item.recipe.id)?.badUrls,
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
      } else if (dl.kind === 'invalid') {
        // Specifically INVALID (not throttled, not a network blip): remember the URL so the
        // next search skips it, and after the limit treat the recipe as a functional no-hit —
        // a recipe whose only results are dead links must not wedge the queue forever.
        const count = recordInvalidDownload(item.recipe.id, outcome.result.url);
        if (count >= INVALID_DOWNLOAD_LIMIT) {
          recipesRepo.markPhotoTried(item.recipe.id, new Date(now).toISOString());
        }
      }
      // download 'throttled' / network 'error' — recipe stays exactly as it was (photo null,
      // no tried marker, nothing counted): a transient hiccup is NEVER a definitive no-hit,
      // so the next tick just searches again (docs/48 §4b).
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
