# Kitchen — self-filling recipe library + photos for every recipe

**Status:** brief approved by owner 2026-07-12 ("can you not preload the database with 2000 recipes?
I want all with images."). Phase 3 of the docs/46 effort; P1 (#227) + P2 (#228) are merged/deployed.
**Decisions:** auto-fill to target with NO owner button press · every recipe gets a real photo ·
photo source = free stock via a pluggable provider: **Openverse (keyless, default)** with
**Pexels (free API key, optional fast path)**; AI-generated photos stay a possible later upgrade.

## Why

P2 shipped the Generate button; the owner wants zero-action: the box should fill itself to 2,000,
and ALL recipes (seeded, imported, generated) should show real images — AI-generated recipes
currently render the illustrated placeholder (photo = null).

## 3a. Auto-generation (no button)

Extend `kitchen.libraryGeneration` (state.json) + `library-generate.ts`:

- New persisted fields: `autoTarget: number` (default **2000**; 0 = auto-off) and
  `monthlyBudgetEur: number` (default **40**).
- On the existing coordinator timer (and once shortly after boot): if
  `claude.isConfigured()` AND `recipesRepo.count() < autoTarget` AND `status` is `'idle'` or
  `'done'` AND the intelligence usage counter's current-month EUR < `monthlyBudgetEur` →
  `startGeneration(autoTarget)` automatically.
- **Never auto-start after `'cancelled'` or `'error'`** — a human pressed Stop or something broke;
  auto-resuming those is hostile/looping. A manual Generate (or changing autoTarget) clears the
  latch (set status back to 'idle' on manual start — existing behavior).
- The €25/run hard cap stays; the monthly budget guard bounds worst-case repeated-boot spend.
- Library card UI: show auto mode plainly — "Auto-filling to 2,000" with the existing progress
  stats when running; when idle-below-target waiting on budget/key, say why. Keep the manual
  Generate/Stop controls (Stop now also sets `autoTarget = current count`, i.e. stop MEANS stop —
  surface that in the confirm copy).

## 3b. Photo enrichment (every photo-null recipe)

New `apps/api/src/kitchen/photo-providers.ts` + `photo-enrich.ts`:

- Provider interface: `searchFoodPhoto(query: string) → { url, credit, creditUrl, provider } | null`.
  - **Openverse** (default, keyless): `GET https://api.openverse.org/v1/images/?q=<query>&license_type=commercial&per_page=5`
    — pick the first result with a plausible aspect/size; throttle ≥1 req / 20 s, exponential
    backoff on 429 (honor Retry-After), User-Agent identifying the app. Anonymous per their docs.
  - **Pexels** (optional fast path): key from a new optional Settings → Intelligence field
    `pexelsApiKey` (write-only like the Anthropic key). `GET https://api.pexels.com/v1/search` —
    pace ≤180/hour. When a key is present Pexels is preferred; Openverse remains the fallback.
- Query builder: recipe title EN-ified (strip diacritics) + `" food dish"`; if no result, retry
  once with `<main ingredient> <cuisine> food`. Main ingredient = first non-pantry ingredient.
- Enrichment coordinator (same idle-tick pattern as library-generate): every tick, take the next
  recipe with `photo == null` (any source), fetch a photo, store `photo` (hotlink URL) +
  new optional `photoCredit?: { name: string; url: string; provider: 'openverse' | 'pexels' }`
  on Recipe (types + sqlite column `photo_credit_json` + repo mapping + web mirror). On a
  definitive no-result, mark it tried (e.g. `photoCredit: {provider:..., name:'', url:''}`? NO —
  cleaner: separate sqlite column `photo_tried_at TEXT` so we don't re-query forever; re-try
  no-hits after 30 days).
- Ordering: photo enrichment must not starve generation — run both; enrichment picks up newly
  inserted recipes automatically (photo-null query).
- **Attribution (required by both providers' terms):** RecipeQuickView (and Cook mode header if
  trivial) shows a subtle credit line when `photoCredit` present — "Photo: <name> · <provider>"
  linking `creditUrl`; the shelf/library card footer gets a one-line "Photos via Openverse/Pexels".
- Existing 50 seeds keep their local `/recipes/*.jpg`; URL-imports keep og:image; only
  photo-null recipes are enriched.

## 3c. UI (web + mobile, Power design system)

- Library card: add photo coverage — "Photos 812 / 2,047" (mono) + provider status ("Openverse ·
  free" or "Pexels · fast"); when a Pexels key would speed things up (no key + >200 photo-null),
  a subtle hint line: "Add a free Pexels key in Settings → Intelligence to fetch photos ~40× faster".
- Settings → Intelligence: optional "Pexels API key (photos)" input, write-only, same pattern as
  the Anthropic key field.
- Recipe quick-view: the credit line (11px, text-3, links out).

## 3d. Tests (node --import tsx --test; NO live network)

Auto-start decision matrix (idle/done/cancelled/error × count vs target × budget), stop-sets-
autoTarget latch, query builder, provider response parsing (fixture JSON for both providers),
enrichment tick with a mocked provider (stores photo+credit, marks tried on no-hit, skips
photo-present), throttle/backoff logic (fake timers or injected clock), sqlite column migration
(schema v2 — additive ALTER, keep fail-soft).

## Cross-cutting

- SQLite schema bump v1→v2 must be additive + idempotent (ALTER TABLE ... ADD COLUMN guarded by
  a recipes_meta check), same fail-soft rules as P2.
- Coordinators must stay fail-soft (photo enrichment can never affect control loops or kitchen
  request paths).
- Deploys restart the API: both coordinators must resume cleanly mid-run (generation already
  does; enrichment is stateless by construction — the photo-null query IS the queue).
- Owner actions: NONE required. Optional: paste a free Pexels key for faster/nicer photos.
