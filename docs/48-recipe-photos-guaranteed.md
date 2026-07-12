# Kitchen — photos guaranteed: Commons cascade, local cache, relevance guard

**Status:** brief approved by owner 2026-07-12 ("make sure all recipes have pictures"). Follow-up
hardening of docs/47 §3b (P3, merged as #229). Live-probed 2026-07-12 (see Findings) — this brief
is grounded in REAL provider behavior, not docs alone.

## Findings from live probes (the "why")

1. **Openverse anonymous budget is 200 requests/DAY** (`x-ratelimit-limit-anon_sustained: 200/day`,
   burst 20/min — measured live). P3's 1-candidate-per-20s tick would burn the day's budget in
   ~67 min then 429 all day; keyless full coverage of 2,000 recipes ≈ 2 weeks. Too slow for
   "make sure".
2. **Match quality risk**: Openverse "Chicken teriyaki food dish" → miso-cod amuse-bouche photos
   (first plausible hit ≠ relevant hit). P3 stores it blindly.
3. **Wikimedia Commons search is BETTER and effectively unmetered for our pace**: exact dish
   matches ("Teriyaki Chicken", "Boerenkool stamppot"), license + artist metadata included,
   `thumburl` at a requested width. Etiquette: identifying User-Agent + gentle pacing.
   BUT `upload.wikimedia.org` 429s bursty image fetches → downloads must be paced too.
4. **Hotlinks are fragile** (origin-hosted Flickr/Wikimedia URLs; referrer/burst limits; rot).
   Local caching removes render-time flakiness forever and is license-compliant (CC + Pexels
   licenses permit storing copies; we retain attribution and add the license name).

## 4a. Provider cascade + relevance guard (`photo-providers.ts`)

- Order: **Pexels (if key) → Wikimedia Commons (keyless default) → Openverse (long-tail filler)**.
- New Commons provider:
  `GET https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=<q>&gsrnamespace=6&gsrlimit=5&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=960&format=json`
  with `filetype:bitmap` prefixed to the search. Parse pages → imageinfo[0]: use `thumburl`
  (960px) else `url`; credit = extmetadata Artist (strip HTML tags), creditUrl = descriptionurl
  (add `|descriptionurl`? verify field — else the File: page URL), license = LicenseShortName.
  Skip GIFs (probe hit one) — accept jpeg/png/webp only. Pace ≥15 s between Commons searches.
- **Relevance guard (all providers)**: a candidate result is accepted only if its title shares at
  least one significant word (>3 chars, diacritic/case-insensitive, basic EN/ES plural-strip)
  with the recipe title OR the fallback main-ingredient query. Otherwise try the next result in
  the response, then the next provider. Prevents miso-cod-for-teriyaki.
- **Openverse daily budget**: persist a per-day counter (state.json, `{day, used}`); hard-stop
  Openverse at 180 searches/day (headroom under 200) — the cascade means Openverse only sees
  what Commons missed, so this rarely binds. Keep the existing 429 backoff as belt-and-braces.
- `photoCredit` gains `license?: string` (types both sides + sqlite is already JSON —
  no schema bump needed for the credit; see 4b for the one new column).

## 4b. Local photo cache (durability — the core of "make sure")

- New `photo-cache.ts`: download the chosen image to `<dataDir>/recipe-photos/<recipeId>.jpg`
  (resolve dataDir the same way kitchen.json does; create the dir; ~200–400 KB each, ~600 MB
  at 2,000 — fine on the mini). Validate response: HTTP 200 + content-type image/* + >10 KB.
  Pace downloads ≥10 s apart (upload.wikimedia.org 429s bursts — probe-proven), independent of
  the search pacing. On download failure: keep the recipe photo-null (or hotlink if one was
  already stored), leave it retryable — never mark photo_tried_at for a DOWNLOAD failure (that
  marker means "no result exists", not "transfer hiccup").
- Serve: `GET /api/kitchen/photos/:recipeId` — streams the cached file with long-lived cache
  headers + correct content-type; 404 when absent. ANY-authed like other kitchen reads
  (kiosk needs it). Recipe.photo is set to `/api/kitchen/photos/<id>` ONLY after a verified
  download — the enrichment flow becomes: search → relevance guard → download+validate → set
  photo + photoCredit atomically. No more hotlink-first.
- **Backfill**: enrichment coordinator also treats recipes whose `photo` is a REMOTE http(s)
  URL from a stock provider (photoCredit.provider set, i.e. P3-era enrichments — NOT seed
  `/recipes/*.jpg`, NOT URL-import og:images which keep their remote URLs by design... 
  CORRECTION per owner intent "ALL recipes have pictures": og:image imports keep working today;
  leave them hotlinked but add them to the cache queue LAST (lowest priority) so they too end
  up durable eventually. Seeds stay local-bundle.) as cache candidates: download → flip photo
  to the local URL. Priority order each tick: (1) photo-null recipes, (2) provider-hotlinked,
  (3) og:image imports.
- sqlite: no new column needed if the local path lives in `photo` — but add
  `photo_cached INTEGER NOT NULL DEFAULT 0` (schema v3, guarded additive ALTER like v2) so the
  coverage query ("cached / total") is cheap and the queue priorities are indexable.

## 4c. Coverage surfacing + self-heal

- Library card "Photos X / Y" now counts CACHED photos (plus a small "(+N linked)" when
  hotlinked/og-image ones exist). Provider status line reflects the cascade:
  "Pexels · fast" / "Commons + Openverse · free".
- RecipePhoto (web) gains an `onError` fallback to the illustrated placeholder (pure client
  fallback — no writes). Cached-local URLs make this a rare path.
- Credit line now includes license when present: "Photo: <name> · <license> · <provider>".

## 4d. Tests (node --import tsx --test; ZERO live network — fixtures/mocks only)

Commons response parsing (incl. GIF skip, HTML-stripped artist, license), relevance guard
(teriyaki/miso-cod fixture must REJECT), cascade order + per-provider budgets (Openverse daily
counter rollover), download validation (content-type/size/status), download-failure ≠
photo_tried_at, atomic set-after-download, backfill priority order, schema v3 idempotence,
photo route (404/200/content-type).

## Cross-cutting

- All coordinators stay fail-soft; pacing must never block request paths (downloads happen in
  the enrichment tick, never inline in a route).
- Keyless end-to-end expectation after this ships: ~2,000 photos in **~1–2 days**
  (Commons-first at 15 s/search + 10 s/download), Openverse mopping up misses at ≤180/day;
  with a free Pexels key: same cascade, faster + nicer.
- Owner actions: none. Optional Pexels key unchanged.
