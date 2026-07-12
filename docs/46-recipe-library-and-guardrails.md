# Kitchen — Recipe library at scale + dietary guardrails + per-day picker

**Status:** brief approved by owner 2026-07-12. Build in two phases (separate worktrees/PRs).
**Owner decisions locked:** target ~2,000 recipes · scales = per-recipe bias **and** weekly-mix targets ·
source = AI bulk generation via the Batch API (celebrity-chef-*style* allowed, no site scraping — see
Sourcing note) · seasonal/local toggle for our location (Jávea, Costa Blanca, ES) · boost-ingredients
chips (garden surplus: avocados, tomatoes now).

## Why

The library ships 50 seed recipes. The owner wants a few thousand, plus richer preference guardrails
(1–10 scale bars for calories/carbs/fish/veg/protein, a seasonal-local toggle, boost ingredients), and a
per-day "request something → pick from candidates" flow in the weekly planner.

## Sourcing note (Jamie Oliver / Nigella)

The owner asked about scraping jamieoliver.com / nigella.com wholesale. We do NOT bulk-scrape those
sites: their creative recipe text is copyrighted and their ToS prohibit scraping; a 2,000-recipe copy is
not defensible even for private use, and the scrapers are brittle. Instead:

1. The existing **per-URL import** (schema.org JSON-LD → our schema) already works on those sites — the
   owner can import individual favourites by pasting a URL. Keep and don't regress it.
2. The bulk library is **AI-generated original content**, tuned to the household schema, and MAY include
   British-celebrity-chef-*inspired* styles (e.g. tags `jamie-style`, `nigella-style`: rustic quick
   Italian-British, indulgent baking-forward) — techniques and flavour pairings aren't copyrightable;
   the text we store is original.

## Current architecture (verified 2026-07-12)

- Store: `apps/api/src/kitchen/store.ts` — ONE JSON file `.data/kitchen.json`, full rewrite on every
  mutation, whole library in memory; `Recipe` in `apps/api/src/kitchen/types.ts:35` (mirror in
  `apps/web/src/lib/types.ts`). 50 seeds in `seed-recipes.ts`, gated by `seededAt`.
- Routes: `apps/api/src/routes/kitchen.ts` — `GET /recipes` returns the ENTIRE library; `/plan/suggest`
  (deterministic, per-day supported), `/plan/ask` (AI, embeds full library in prompt), `/recipes/generate`
  (AI, unsaved candidates), `/recipes/import` (JSON-LD → Claude fallback).
- Engine: `apps/api/src/kitchen/engine.ts` — `isEligible()` hard filters (allergies, dietRestrictions via
  ES+EN keyword lists), `scoreRecipe()` soft scoring (cuisine weights, rotation, time budget, kcal goal,
  loves/dislikes, season, kidScore), `suggestWeek()` fills Mon–Sun. Unit-tested (`node --import tsx --test`).
- Household: `types.ts:178` — adults/kids, allergies, dietRestrictions, dislikes, loves, weeknightMaxMin,
  cuisineWeights, goals, showNutritionOnCards. Edited in `PreferencesModal` (Cooking.tsx:794).
- AI: `apps/api/src/connectors/claude.ts` — model pinned `claude-sonnet-5`, key from env or
  Settings→Intelligence (owner has NOT added a key yet), per-feature toggles, EUR usage counter,
  every caller fails soft to a deterministic path.
- UI: `apps/web/src/screens/kitchen/Cooking.tsx` (planner + shelf, chips filters, NO search box),
  `Cook.tsx`, `shared.tsx`. Day cards: Swap/pin/skip/servings.

---

## Phase 1 — Guardrails + per-day request/pick (no storage change)

### 1a. Household model additions (`Household` in both types files, hydrate defensively like dietRestrictions)

```ts
nutritionScales: {           // all 1–10, default 5 = neutral
  calories: number;          // 1 = light dinners preferred … 10 = hearty
  carbs: number;             // 1 = low-carb preferred … 10 = carb-happy
  fish: number;              // 1 = avoid fish … 10 = fish-forward
  veg: number;               // 1 = meat-forward … 10 = veg-forward
  protein: number;           // 1 = indifferent … 10 = high-protein priority
};
seasonalLocal: boolean;      // prefer in-season fresh local produce for our location (default true)
boostIngredients: string[];  // free-text chips, e.g. ['aguacate','tomate'] — garden surplus
```

### 1b. Engine semantics (all in `engine.ts`, unit-test each; keep pure)

- **Recipe classification helpers** (exported, keyword-based like the existing FISH/MEAT arrays):
  `isFishRecipe(r)`, `isVeggieRecipe(r)` (no meat & no fish), `vegRichness(r)` 0..1 (share of produce
  ingredients). ES+EN keywords.
- **Per-recipe bias** in `scoreRecipe()` (each scale contributes roughly ±10 max so no single scale
  dominates cuisine/rotation; 5 = zero contribution):
  - calories: map scale→target kcal band (1→~450, 5→~650, 10→~900); score −(|kcal−target|/40), cap ±10.
    Skip when recipe has no nutrition.
  - carbs: scale<5 penalizes carbsG>60/serving, scale>5 mildly boosts; linear, cap ±8.
  - protein: scale>5 boosts proteinG≥30; scale<5 neutral (protein indifference, never penalize protein).
  - fish/veg: per-recipe component cap ±8 (weekly mix below does the heavy lifting).
- **Weekly mix targets** in `suggestWeek()`: derive targets from scales —
  fish: 1–2→0, 3–4→1, 5–6→1–2, 7–8→2–3, 9–10→3–4 fish dinners/week;
  veg: same bands for full-veggie dinners. While filling the week, track counts; boost (+18) eligible
  fish/veggie recipes while under target, penalize (−18) once target met. Respect pins/skips (pinned
  fish dinners count toward the target). Single-day re-suggest uses the week's current counts.
- **Seasonal/local**: month→in-season produce table for the Costa Blanca (constant in engine;
  ES+EN names — e.g. Jul: tomate, pimiento, berenjena, calabacín, melocotón, sandía, higo…; write all
  12 months, ~8–14 items each). When `seasonalLocal` on: +2 per in-season ingredient match (cap +12),
  and strengthen the existing `season[]` match bonus. Off → behaviour unchanged.
- **Boost ingredients**: +8 per distinct boosted ingredient present (match `name`+`es`, substring,
  case/diacritic-insensitive), cap +20. Strong enough to surface avocado/tomato recipes now.

### 1c. Per-day request + pick (planner)

- **API** `POST /api/kitchen/plan/request { week, date, text? }` (admin+kiosk read? — match existing
  plan-write gating): returns top **6 candidates** `{recipe, why}[]`.
  - Deterministic path (always works): eligibility filter → `scoreRecipe` with guardrails → if `text`
    given, add keyword-match scoring over title/tags/ingredients (reuse `/plan/ask`'s keyword fallback);
    exclude recipes already in this week's plan; `why` = short human reason ("fish · in season · 24 min").
  - AI path (only when Intelligence on + key): re-rank/filter the deterministic top ~30 with one small
    Claude call (existing `plannerRequestBox` feature flag); fail soft to deterministic order.
- **UI** (web ≥768 + mobile): each day card gets a **Pick** affordance (alongside Swap). Opens a
  sheet/popover: request text input ("something with fish, light") + 6 candidate cards (photo, title,
  meta chips, `why`) + refresh. Tap → assign to that day (sets `pinned: true`, like hand-pick today).
  Empty text = "show me good options for this day". Mobile = bottom sheet; desktop = modal.

### 1d. Preferences UI (PreferencesModal, web + mobile)

New "Nutrition & sourcing" section: five labelled 1–10 sliders (use existing `Slider`, show live
qualitative label: e.g. calories 2/10 → "light"), seasonal-local toggle with subtitle "Prefer in-season
produce (Costa Blanca)", `ChipsEditor` for boost ingredients labelled "Boost ingredients (garden
surplus)". Persist via existing `PUT /household`.

### 1e. Tests

Engine unit tests: classification helpers, each scale's bias direction, weekly-mix targets met on a
synthetic library, seasonal boost on/off, boost-ingredients ranking, request endpoint keyword path.

---

## Phase 2 — Storage at scale + bulk generation (after P1 merges)

### 2a. SQLite recipe store

- Move `recipes` out of `kitchen.json` into a SQLite DB (use the shared `apps/api/src/db/sqlite.ts`
  module — same driver/pattern as solar history). Table
  `recipes` (id PK, title, cuisine, tags/ingredients/steps as JSON columns, kcal/protein/carbs/fat,
  prepMin+cookMin, isFish/isVeggie/vegRich precomputed, lastCookedAt, source, createdAt) + FTS5 index
  over title/tags/ingredient names (ES+EN).
- **Boot migration**: if `kitchen.json` has recipes → copy into DB, back up `kitchen.json` →
  `kitchen.json.pre-sqlite.bak`, drop the array from the JSON (keep plans/household/etc. there).
  Idempotent, logged, fail-safe (on any error keep JSON as source of truth and log loudly).
- Engine/suggest paths read via a slim repository module (`kitchen/recipes-repo.ts`) — in-memory LRU of
  the full slim index (id/title/tags/nutrition/classification, no steps) is fine at 5k; full recipe
  fetched by id.

### 2b. API scale-out

- `GET /recipes?q=&cuisine=&tag=&maxMin=&fish=&veggie=&page=&pageSize=` — paginated (default 50),
  FTS search, filters; response includes `total`. Keep an unpaginated `?all=slim` slim-index variant
  for the planner UI if needed.
- AI prompts: NEVER embed the full library. `/plan/ask` + `/what-can-i-make/answer` build the library
  string from FTS/scored top ≤120 slim entries relevant to the query.
- Shelf UI: add search box + filter chips backed by the server; paginate/infinite-scroll the shelf;
  candidate picker (P1c) reuses the search endpoint.

### 2c. Bulk generation pipeline (~2,000 recipes, Batch API)

- Admin endpoint `POST /api/kitchen/library/generate { target: number }` + `GET .../generate/status`.
  Uses the owner's Anthropic key (Settings→Intelligence; refuse with a clear error if absent).
- Implementation: coverage plan across cuisines (spanish 30%, italian 15%, japanese 15%, dutch 10%,
  global 30% incl. `jamie-style`/`nigella-style`/mexican/indian/thai/greek/moroccan), meal archetypes,
  seasons, fish/veggie quotas (≥20% fish, ≥25% veggie), weeknight ≤35min majority, kid-friendly share.
  Message Batches API (50% price): batches of requests, each generating 5 recipes as strict JSON
  matching our `Recipe` schema (es ingredient names REQUIRED, nutrition estimated, seasons, kidScore,
  tools, mise/cook steps with timers). Model `claude-sonnet-5` (already pinned). Poll batch → validate
  (zod-ish sanitize like `sanitizeRecipe`) → dedupe (normalized-title Levenshtein + same-cuisine) →
  insert with `source:'ai'`, no photo (photo=null renders the existing gradient placeholder — fine).
- Progress: status endpoint returns {queued, generated, inserted, duplicates, failedValidation,
  estCostEur, spentEur (reuse the usage counter)}; simple progress card in the Cooking screen behind
  admin. Resumable: target minus current count; safe to re-run.
- Cost guard: hard cap per run (default €25) using the existing EUR usage counter; abort cleanly.
- CLI fallback `apps/api/scripts/generate-library.mjs` for running the same pipeline off-box (nice to
  have; endpoint is primary).

### 2d. Tests

Repo module CRUD+FTS, migration idempotence (temp dir), pagination, retrieval-prompt cap, generator
validation/dedupe with fixture responses (no live API in tests).

---

## Cross-cutting

- Web AND mobile for every UI change (repo standing rule). Power design system.
- API tests run with `node --import tsx --test` (NOT vitest).
- Deploys preserve armed state; kitchen changes don't touch battery control. P2 boot migration must be
  fail-safe (JSON stays authoritative on any error).
- Do NOT run Prettier; match hand-formatting.
- Owner actions after P2: add Anthropic API key (Settings → Intelligence) → press Generate. Everything
  else must work without the key (deterministic paths).
