# docs/43 — AI-generated recipes: the discovery front door

Owner decision (2026-07-03). Owner asked: *"why do we need a library? can AI not
generate recipes and photos based on questions/ingredients? I expect a couple of nice
recipes to choose from. Give the entire page and functionality a polish."*

## Chosen architecture — "Growing cookbook, AI on-ramp"

The **library stays as the structured backbone.** Everything downstream of a recipe is
deterministic and operates on structured data, not free-text blobs:

- the week planner / 3-week rotation scorer (`engine.ts`)
- the groceries → Mercadona-cart ingredient pipeline (ingredient `es` names → SKU search
  → pack-size consolidation → spend-capped cart fill)
- cooking mode (mise/cook steps, timers)
- ratings, nutrition, "Fits goal" badges, cuisine weights

None of that works on a paragraph of prose. So we keep the structured `Recipe` as the
substrate and make **AI the discovery front door**:

> Ask a question or pick ingredients → AI **generates** a few *complete, structured*
> candidate recipes that already fit the household → owner picks the one(s) they like →
> saved **into** the library so they're plannable / orderable / cookable exactly like a
> seed recipe.

The deterministic finder (`rankRecipesByCoverage`, the ingredient palette) stays as the
**always-works, zero-cost, offline fallback** — visible right beside the AI results, never
replaced by them.

### Why not free-text recipes / drop the library

A free-text recipe can't be planned (no cuisine/kcal/time to score), can't be ordered (no
`es` ingredient names, no quantities/units to consolidate into a cart), and can't drive
cooking mode (no phased steps/timers). Generating *structured* recipes preserves every one
of those pipelines while still giving the owner "a couple of nice recipes to choose from."

## Photos — illustrated cards for now

Claude is text-only here; no image model is wired and we are **not** adding an image
provider in this change. Generated (and any photo-less) recipes render a **designed,
cuisine-tinted illustrated card** — a tasteful gradient + a subtle utensil glyph + the
dish's initials — so an AI recipe looks *intentional*, not like a broken image. The
`recipe.photo` path already accepts a URL, so a future image provider can drop generated
image URLs straight in with no schema change. **Real AI photos remain a future opt-in that
needs an image provider.**

## The generate route

`POST /api/kitchen/recipes/generate` — body `{ question?, ingredients?, count? }`.

- Requires at least one of `question` / `ingredients` (else 400). `count` clamps to 2–4
  (default 3).
- Gated on the **new** `recipeGeneration` Intelligence feature. Off → soft
  `{ ts, ok:false, reason:'intelligence-off', recipes:[] }` (the deterministic cookbook
  search still fully works).
- On → Claude (`completeJSON`) returns ONLY `{recipes:[…]}`, each a COMPLETE structured
  recipe. The household is fed into the prompt so candidates already fit: **allergies and
  diet-restriction ingredients are a hard NEVER** (the diet slugs expand via the engine's
  `DIET_RESTRICTION_KEYWORDS`), dislikes are avoided, kid-friendly when kids > 0, high
  cuisine-weight cuisines preferred, near the kcal goal when set, honouring the
  ingredients-on-hand / the free-form question.
- Every returned recipe is validated + clamped through the **same** sanitiser the manual
  `POST /recipes` uses (extracted as the pure `sanitizeGenerated()`), then
  `source:'ai'`, `photo:null`, `nutrition.estimated=true`, and a temporary `id`
  (`gen_<index>`). **Nothing is persisted** — they come back as *candidates*.
- **Belt-and-braces hard filter:** after generation any candidate still containing an
  allergen or diet-restriction ingredient is *dropped* (reusing the engine's keyword lists
  / `textMatchesAny`). The model is told never to use them; this guarantees it.
- Fails **soft** on parse / upstream error → `{ ok:false, reason:'no-recipes', recipes:[] }`.
- **Saving is the existing `POST /recipes`** with the candidate's structured body (the
  sanitiser's `source` allowlist now accepts `'ai'`). No new save route.

### Cache

A tiny in-process LRU-ish `Map` cache keyed on
`normalizedQuestion | sortedIngredients | householdSignature`, TTL ~10 min, cap ~40
entries. Re-asking the exact same thing with the same household returns the cached
candidates instead of re-billing Claude. It only caches successful (`ok:true`) results and
is process-local (fine for a single-instance household app); a deploy/restart clears it.

## Intelligence feature (additive)

`recipeGeneration` added to `KitchenIntelligenceConfig.features` (store.ts default, hydrate
allowlist), the `/intelligence` PUT allowlist, the web `KitchenIntelligence['features']`
type, and a Settings ▸ Intelligence toggle. **Default `true`** so the flagship works the
moment the owner flips the master switch — but the master switch is **off on prod today**,
so nothing generates live until the owner enables it.

## Discovery-hub UX (WhatCanIMake reframed)

From "rank my library" into "find or invent a recipe", keeping the deterministic path free:

- Ingredient palette + free-text chips stay. Two actions on the set: **Search cookbook**
  (deterministic coverage rank) and **Invent recipes** (→ generate with those ingredients).
- The question box is the primary "ask for a couple of nice recipes" entry → generate with
  the question (+ any selected ingredients).
- Results in two clearly-labelled groups of consistent recipe cards: **From your cookbook**
  (deterministic matches → open existing quick-view) and **Fresh ideas — tap to keep** (AI
  candidates). A candidate opens a full quick-view (ingredients, steps, nutrition, time)
  with **Save to cookbook**, **Add to this week**, **Cook now** — each saves first (a
  candidate is marked "not saved yet" until then).
- Intelligence OFF → the Invent/ask actions show the existing soft hint; the deterministic
  cookbook search still works. Per-action loading + fail-soft notes.
- Kiosk variant keeps working (bigger targets); generation is discovery, not
  money-adjacent, so it's allowed there — keep/read only.

## Page polish

- Redesigned illustrated `RecipePhoto` fallback (cuisine gradient + glyph + initials),
  consistent at every size it's used (72/96/48/42/56/140/180).
- Discovery is a first-class page section ("Find or invent a recipe") between the planner
  and the library shelf, not a tiny strip at the bottom. Consistent card styling across
  planner day-cards, shelf, cookbook results, AI candidates. Tightened spacing / rhythm
  strip / AI bar / filter chips / empty+loading+error states. Verified desktop ≥768px and
  mobile <768px.

## What we can / can't verify live

Intelligence is OFF on prod/seed, so real generation can't be exercised live. Verified
live: deterministic cookbook search + palette + page polish (both viewports), the
Invent/generate actions showing the soft Intelligence-off hint (the observable OFF path),
the illustrated fallback card at all sizes, and no planner/groceries regression. The
generation happy-path is covered by unit tests (pure `sanitizeGenerated()` clamp + the
allergen/diet post-filter drop + the intelligence-off shape). No real Claude call in tests.
