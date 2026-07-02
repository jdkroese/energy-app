# 39 — Kitchen Hub build brief (P0 + P1)

_Build instructions for the implementing agent. Concept + locked decisions: `docs/38-kitchen-hub.md`
(§11 decisions D1–D5, §12 owner refinements — ALL locked, owner gave final approval 2026-07-02).
Approved screens: `docs/mockups/kitchen-hub-v4.html` (open in a browser; single self-contained file)._

## What ships in this PR (P0 + P1)

Two new top-level sections — **Cooking** (`/cooking`) and **Groceries** (`/groceries`) — web +
mobile responsive, plus the read-only Mercadona connector. **No cart writes, no tablet kiosk
screens, no cooking mode in this PR** (P2/P3 follow separately). Doc pages `docs/38`, `docs/39`
and `docs/mockups/kitchen-hub-v4.html` must be included in the PR (they're untracked in the
primary checkout — copy them in).

### P0 — Mercadona connector (read-only), `apps/api/src/connectors/mercadona.ts`

Facts verified live 2026-07-02 (from `docs/38` §3):

- Base `https://tienda.mercadona.es/api/`, Django-style trailing slashes, anonymous for reads.
  Always send a realistic browser `User-Agent` (Akamai bot manager is present) and
  `?lang=es&wh=alc1`. **Warehouse: resolve once via
  `PUT /api/postal-codes/actions/change-pc/ {"new_postal_code":"03730"}` → response header
  `x-customer-wh` (expect `alc1`), cache it in state; never hardcode without the resolver.**
- `GET /api/categories/` (tree), `GET /api/categories/{id}/` (products of a category),
  `GET /api/products/{id}/` (detail incl. `price_instructions` (unit_price, bulk_price,
  reference_price, pack size info), `photos[]` imgix URLs — resize w/ `?fit=crop&h=300&w=300`).
- Search: Algolia index `products_prod_{wh}_es` (e.g. `products_prod_alc1_es`),
  `POST https://{APPID}-dsn.algolia.net/1/indexes/{index}/query` with
  `X-Algolia-Application-Id` + `X-Algolia-API-Key`. The app-id/key are PUBLIC, baked into
  Mercadona's JS bundle, and ROTATE (currently `7UZJKL1DJ0` / `9d8f2e39e90df472b4f2e559a116fe17`).
  On 401/403/404: re-scrape both from the tienda JS bundle and retry once. Mercadona is
  mid-migration off Algolia → put search behind an interface (`searchProducts(q)`) with a
  category-walk fallback so a dead Algolia degrades, not breaks.
- Cache all reads ≥30 min (their own `Cache-Control` is 1800s). Low concurrency (max 2 in
  flight), no retries beyond 1, timeout 8s. EVERYTHING degrades gracefully: if Mercadona is
  unreachable, the app still fully works minus prices/photos (show "prices unavailable").
- Config in state.json under `kitchen.mercadona` (postalCode, warehouse, algolia {appId, key,
  scrapedAt}). Env override `MERCADONA_POSTAL_CODE`.
- `GET /api/kitchen/mercadona/status` (admin): performs a live category fetch + 1 search and
  returns `{ok, warehouse, products, searchOk, latencyMs}` — this is the P0 go/no-go probe we
  verify on the mini after deploy. Also add a **"Mercadona" row to Settings ▸ Connections**
  (pattern: existing connection rows) showing linked/warehouse/status from that endpoint.

### P1 — the two sections

**Storage** — new `kitchen` slice in the API store (pattern: `home-scenes.ts` + `store.ts`).
Recipes can be sizeable → separate file `.data/kitchen.json` (atomic tmp+rename writes, same as
state.json), loaded at boot. Types (server + mirror in `apps/web/src/lib/types.ts`) — from
docs/38 §5: `Recipe` (with `nutrition{kcal,proteinG,carbsG,fatG,estimated}`, `tools[]`, steps
tagged `phase:'mise'|'cook'`), `ProductMap`, `StaplesItem`, `MealPlan`, `OrderDraft` (with
`packsNeeded/coverageNote`, `suggestions[]`, `status`, `targetSlot`, `submitBy`), `OrderHistory`,
`Household` (with `loves[]`, `goals{}`, `showNutritionOnCards`), `Reminders`.

**API routes** `apps/api/src/routes/kitchen.ts`, mounted `/api/kitchen`, `requireAuth`
(mutations `requireAuth` too — any household member; nothing admin-only except the status probe):

```
GET/PUT  /household            (prefs incl. goals, loves, cuisine weights, time budget)
GET/POST/PUT/DELETE /recipes   (+ POST /recipes/import {url} → parsed recipe, see Import)
GET/PUT  /plan?week=2026-07-06 (the MealPlan; PUT day: {recipeId|skip|clear, servings})
POST     /plan/suggest         (deterministic engine; body {day?} for single-slot re-suggest)
POST     /plan/ask             (AI request box → candidate recipes; 501-style soft answer when Intelligence off)
GET/PUT  /staples
GET/PUT  /order/draft          (lines, checks, qty; server recomputes prices + pack math)
POST     /order/draft/from-plan(explode current week → draft; dedup + pack-size consolidation)
GET      /order/history
GET      /products/search?q=   (proxy to connector: id, name, photo, unit price, pack size)
GET      /mercadona/status     (admin probe, above)
```

**Suggestion engine (deterministic — no LLM):** score recipes by: not cooked within 3 weeks
(rotation) · cuisine-weight match (household prefs) · weekday prep-time ≤ time budget
(Mon–Thu) · goal fit (kcal ≤ target when goals.mode set) · loves boost / dislikes penalty /
allergies hard-filter · season tags. Fill 7 slots with cuisine variety (no 2 consecutive same
cuisine). Pins survive re-suggest; skips stay skipped.

**Pack-size consolidation:** sum ingredient quantities across the week's recipes (normalise
units g/kg/ml/L/count), match against the mapped product's pack size → `packsNeeded` +
`coverageNote` ("900 g across 3 recipes → 1× 1 kg ✓"). Unmapped ingredients → the draft line
carries `needsMapping: true` and the UI shows the cyan pick-once search (writes `ProductMap`).

**Recipe import (`/recipes/import`):** fetch URL server-side → parse schema.org/Recipe JSON-LD
(most sites have it) → normalise. If Intelligence is ON and JSON-LD missing/incomplete, one
Claude API call (model `claude-sonnet-5`, small max_tokens) to extract {title, servings, times,
ingredients (name/qty/unit + canonical Spanish name), steps (tag mise/cook), tools, nutrition
estimate, cuisine}. Photo: og:image URL stored as-is. Fails soft to a manual-entry prefill.

**Intelligence settings (D2):** Settings ▸ new "Intelligence" card — API key (masked, stored in
state, env `ANTHROPIC_API_KEY` override), master switch, per-feature toggles (import parsing ·
cooking suggestions · planner request box · weekly-plan assist), month usage € counter (count
tokens, price locally). Server helper `apps/api/src/connectors/claude.ts` — plain fetch to the
Anthropic Messages API, no SDK dependency needed.

**Reminders / order rhythm:** `kitchen.reminders` config (planWeekAt default Sun 18:00, submit
deadline Sun 22:00, target slot label "Mon 19:00–20:00" — all editable in the Groceries UI).
A small hourly coordinator tick (`control/kitchen-coordinator.ts`, pattern of the other
coordinators; **log-only + Push notify, no control-loop interaction**) emits: plan-week nudge if
next week has <3 planned days, and submit nudge if draft not submitted by deadline − 4h. Notify
via the existing push fan-out; log via `logEvent()` (category `kitchen`, class `system`).

**Seed library:** ~50 dinners balanced across Spanish/Dutch/Japanese/Italian/global, kid-tested
weeknight bias, each: ES-canonical ingredient names (for SKU search), tools, phased steps,
nutrition estimate (flag `estimated:true`), cuisine/season/kids tags, and a photo. Photos:
download from Wikimedia Commons at build time (proper UA with contact email; **only the fixed
allowed thumb sizes work, e.g. 330px/500px** — 400px etc. return 400) into
`apps/web/public/recipes/` (≤60 files, ~40 KB each) + an `ATTRIBUTION.md` alongside. Seed data
as a JSON file loaded on first boot (don't overwrite user edits).

**Frontend** (`apps/web`): nav per approved v4 — new rail section [Cooking (chef-hat), Groceries
(shopping-basket)] between Music and Automations in `nav.ts` (`NAV_KITCHEN`), included in
`RAIL_SECTIONS` + a "Kitchen" group in `MOBILE_MORE_SECTIONS` between Media and Automation.
Lazy screens `screens/kitchen/Cooking.tsx` + `screens/kitchen/Groceries.tsx` (+ shared
components folder). Verify icon names resolve in lucide (`chef-hat`, `shopping-basket` — the
Icon.tsx silent-blank gotcha).

Build the screens to match `docs/mockups/kitchen-hub-v4.html` **exactly** (it is the approved
design, built on the live tokens): planner (order-rhythm strip, AI bar, 7 day cards w/ photo,
kcal, servings stepper, Swap/Skip, skipped state, filter chips, library shelf w/ URL-import),
quick-view overlay (desktop modal / mobile bottom sheet), Groceries (smart-suggestions card —
**P1 renders only the auto-applied pack merges; interactive suggestions are P2**, three columns
recipes/staples/basket on desktop, segmented tabs on mobile, mapping-memory picker, priced
basket w/ slot row, "Send as checklist" (M0) — the primary "Fill Mercadona cart" button renders
DISABLED with tooltip "Cart link coming in the next update" until P2), Preferences (household,
goals, loves, allergies/dislikes, cuisine weights) + Intelligence settings. Both breakpoints per
the standing web+mobile rule (`ctx.desktop`); touch targets ≥46px.

### Out of scope for this PR (do NOT build)

P2: token bootstrap, cart writes, interactive smart suggestions, slot reads, `myregulars`
seeding, order-status tracking beyond `draft`. P3: tablet kiosk screens, cooking mode. P4: all
of it. Keep seams (types + disabled UI) where noted.

## Workflow requirements (repo standing rules)

- Isolated worktree: `bash scripts/new-worktree.sh kitchen-hub-p1` → branch `kitchen-hub-p1`
  off latest `origin/main`; activate hooks if not inherited.
- **No Prettier** (`prettier --write` is forbidden — hand-match the existing style, single
  quotes, ~120 col).
- `npm run build` (web) + API typecheck/tests must pass; fix what you break, touch nothing
  outside the feature.
- This feature never touches the control loop / battery logic. It's additive → a normal deploy
  is safe (armed state persists).
- Rebase on `origin/main` before push (other agents are landing PRs — expect movement).
  Open a PR titled "feat(kitchen): Cooking & Groceries sections + Mercadona read connector
  (P0+P1)" with a body covering: what/why, screens built, connector posture (read-only,
  cache, degrade), verification evidence, and out-of-scope list. Do NOT merge — the
  orchestrating agent reviews and lands it.

## Acceptance checklist (self-verify before PR)

1. `preview_start` → both sections reachable from rail (desktop ≥768) and More sheet (<768);
   screenshots at both widths attached to the PR.
2. Suggest week fills 7 slots honoring rotation/cuisine/time-budget/allergies; skip + pin
   survive re-suggest; servings steppers rescale ingredient explosion.
3. From-plan draft: dedup + pack math correct on a hand-checked example (rice 900 g → 1 pack).
4. Mercadona: status endpoint green from dev (search + category + product + price render in the
   picker); kill-switch test — block the domain → app still renders with prices "unavailable".
5. Import: a real recipe URL with JSON-LD parses; a garbage URL fails soft to manual entry.
6. Intelligence off → AI bar hidden/disabled state, import still works via JSON-LD path.
7. Reminders: coordinator tick unit-testable (inject clock); emits event + push on the fixture.
8. No regressions: existing screens compile, nav renders, `npm run build` green.
