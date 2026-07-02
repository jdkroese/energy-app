# 38 — Kitchen Hub: groceries, meal planning & recipes

_Concept / scope proposal — 2026-07-02. Status: **for owner discussion, nothing built**._
_Companion to docs/32 (tablet mode) — this section is the kitchen tablet's killer use case._

---

## 1. Vision

The app already runs the house's energy, climate, lights and water. The Kitchen Hub adds the
**weekly food loop** — the single most repetitive piece of household logistics — and closes it
end-to-end:

> **Plan** (10 minutes on Sunday) → **Order** (one review, one tap to Mercadona) → **Cook**
> (weeknights, on the kitchen tablet) → the app **learns** and next week takes 5 minutes.

The busy-parent test for every feature: _does this remove a decision, a re-typing, or a
supermarket walk-through?_ If not, it's out.

What makes this more than "another recipe app":

1. **It knows your store.** Live Mercadona catalog, prices and photos for warehouse `alc1`
   (Jávea). A shopping list here is not a text list — it's real products with a real basket total
   in € before you order.
2. **It remembers the mapping.** "200 g arroz bomba" → the exact Mercadona SKU you buy. Confirmed
   once, reused forever. After ~3 weeks the weekly order becomes one review + one tap. This
   mapping memory is the compounding asset — no off-the-shelf app has it for Mercadona.
3. **It lives on the wall.** Cooking mode is designed tablet-first for the kitchen tablet
   (docs/32): big type, big buttons, timers, greasy-finger-proof. The phone and desktop get the
   planning/ordering surfaces.

## 2. The three loops (user experience)

### Loop A — Plan the week (desktop/mobile, ~10 min)

- **Suggested week:** the app proposes 5–7 dinners from the recipe library. Deterministic engine
  first (no AI required): rotation (nothing repeated within N weeks), variety balancing across
  tags (pasta / rice / fish / meat / veg / kids-favourite), prep-time weighting (quick meals on
  busy weekdays, project cooking on weekends), season awareness.
- **Swipe to shape it:** accept / swap ("show me another fish one") / pin a family favourite /
  **skip a night** (eating out — an explicit skipped state with undo, excluded from the order).
  **Per-night servings stepper** on every card (defaults to the household count, +/- for guests).
- **Recipe quick-view:** tap any card → overlay with photo, full ingredient list (with mapped
  products + prices), nutrition, steps summary, and actions (plan it / cook now / send
  ingredients to Groceries).
- **Real photography:** every recipe card carries a real photo of the dish (URL imports pull the
  source photo; the seed library ships with photos; owner uploads for manual recipes).
- **Nutrition on every recipe:** kcal per serving on the card; protein/carbs/fat in quick-view.
  Estimated at import/seed time (Claude-assisted, flagged "estimated"), stored in the model.
- **AI request box** (needs D2 on): free-text ask on the planner — "something light with salmon
  for Thursday", "Japanese comfort food, kids-friendly" → candidate recipes to accept into the
  week. Fails soft to library search when Intelligence is off.
- **Guidance capture:** household profile — dislikes, allergies, "kids won't eat X", preferred
  cuisines, weeknight time budget. The engine respects it; you enter it once.
- Output: a **week board** — 7 day-cards, each with recipe photo, prep time, servings.

### Loop B — Order (desktop/mobile, ~5 min)

- **List builder:** the week's recipes explode into ingredients, quantities scaled to servings,
  **deduplicated across recipes** (two recipes needing onions → one line), unit-normalised.
- **"Newly needed" confirmation (owner's requirement):** before anything is added, each
  ingredient line is shown as a checkbox — _do you actually need to buy this, or is it in the
  pantry?_ Salt, olive oil, rice: usually unchecked. One screen, big toggles. The app remembers
  which ingredients you habitually skip ("pantry staples") and pre-unchecks them next time.
- **Staples list (owner's requirement):** a predefined, editable list of frequently ordered
  items (milk, bread, eggs, fruit, cleaning…), each with a default quantity and a per-item
  cadence hint (weekly / biweekly). One tap adds the due ones to the order draft. Seeded
  automatically from Mercadona's own `myregulars` endpoint once the account is linked.
- **Priced basket:** every line is a real Mercadona product (via the mapping memory, or a
  one-time pick from live search results with photos + prices). Running total in €, flagged
  against the delivery minimum.
- **Package-size intelligence:** quantities are consolidated across recipes and matched against
  real pack sizes — "3 recipes need 900 g rice → one 1 kg pack covers it"; 1.3 kg → 2 packs.
  Coverage math shows on the line so over/under-buying is visible.
- **Smart suggestions (confirm / ignore):** an efficiency strip above the list — bigger-pack
  unit-price savings ("1 L → 3 L olive oil saves 1,20 €/L — switch?"), shared-fresh-item merges
  ("one parsley bunch covers vongole + gambas"), cadence nudges ("toilet paper usually every
  2 weeks — it's been 3. Add?"). Each is a one-tap confirm or ignore; ignored suggestions teach
  the heuristics.
- **Push to Mercadona:** see §4 — default is *auto-fill the cart, human reviews and checks out
  in the Mercadona app/site*. We never place the order headlessly.
- **Order rhythm & reminders (owner requirement):** standing target = **delivery Monday evening**,
  which means the order must be submitted before the slot cutoff. The app tracks a
  **submit-by deadline** (default Sunday evening, configurable), shows a countdown chip on the
  planner and Groceries, and sends reminders (in-app banner + push): "plan your week" (Sunday
  afternoon) and "cart is filled — submit before 22:00 for the Monday slot". Slot *booking*
  stays human (in Mercadona, at checkout); P2 can read available slots via the authed API to
  show real cutoff times and the delivery window, and the order status card tracks
  draft → cart filled → submitted → delivery window.

### Loop C — Cook (kitchen tablet first)

- **Tonight lives ON the kiosk home (owner decision):** not a separate kitchen tab — the
  TabletHome (docs/32) integrates the Tonight card (today's planned dinner: photo, time,
  servings, one tap into cooking mode) alongside the home controls, plus:
  - **"We're out of…" logging:** quick-add tiles (staples) + free-text "other…" — items land
    straight in the next Groceries order draft (unmapped items go through mapping memory later).
  - **Order status card:** draft → cart filled → submitted → **delivery window with countdown**
    ("Delivery Mon 19:00–20:00 · in 22 h · 29 items · 86,65 €").
- **Cooking mode runs in three phases (owner decision):**
  1. **Prepare** — tools & equipment checklist (pans, rack, thermometer…) + full ingredient
     checklist with amounts rescaled to tonight's servings. Nothing starts until the bench is set.
  2. **Mise en place** — prep tasks as check-off tiles (butterfly the chicken, breading station,
     start the rice — with its own timer), so the actual cooking is calm.
  3. **Cook** — the step-by-step guide (kept as designed): one step per screen in huge type,
     inline rescaled amounts, tap-to-start timers that survive step changes, "keep screen on",
     next/back with a knuckle. A phase bar (Prepare · Mise en place · Cook) is always visible.
- **Off-plan cooking:** browse previously ordered/cooked recipes (the "we know you can make
  this" shelf — ingredients were bought recently).
- **"What can I make with…" (owner's requirement):** type or tap a few ingredients on hand
  ("chicken thighs, courgette, rice") → ranked suggestions. Deterministic first pass: recipes
  ranked by % of ingredients covered from the library. Optional Claude-powered fallback for
  free-form "invent me something" (see decision D2).
- **Cooked!** — one tap at the end. Feeds rotation history, "last cooked", and a lightweight
  rating (👍 / 😐 / 👎 per family) that tunes future suggestions.

## 3. What Mercadona actually allows (research verdict, verified live 2026-07-02)

Full detail in the research notes; the load-bearing facts:

| Capability | Status | How |
|---|---|---|
| Catalog, product detail, prices, allergens | ✅ anonymous, stable | `tienda.mercadona.es/api/` with `?wh=alc1` (Jávea = warehouse `alc1`, verified via postal-code 03730) |
| Product search | ✅ works today, **migration risk** | Algolia index `products_prod_alc1_es`, public keys scraped from the JS bundle; Mercadona is mid-migration to an in-house engine → build behind an interface |
| Product photos | ✅ free | imgix CDN, resizable |
| Add items to cart | ⚠️ possible, fragile | Real endpoints exist (`PUT /api/customers/{id}/cart/`, flattened `{product_id, quantity}`, batched). **Login is reCAPTCHA-gated** → requires a **one-time manual browser login + refresh-token import** (exact same pattern as our Tesla token onboarding). Token then renews headlessly. |
| Place the order headlessly | ❌ don't | Technically reachable after token bootstrap, but ToS/account risk + payment/slots make it a bad idea. Human always checks out. |
| Prefilled-cart deep link | ❌ doesn't exist | Only per-product `share_url` links |

**Design consequence:** the product is *list-build + cart-fill + human checkout*. That is not a
compromise — it's the right UX anyway: a parent wants to eyeball the basket, pick the delivery
slot, and pay. What we remove is the 45 minutes of searching, typing and remembering.

Integration posture: browser User-Agent, 30-min response caching, low concurrency (Akamai
bot-manager is present), spend-cap guardrail on cart writes, and the whole connector behind an
interface so the Algolia→in-house search migration is a swap, not a rewrite.

## 4. Ordering modes (progressive trust)

1. **M0 — Checklist:** priced list in the app; you shop from it (phone in hand at the store, or
   typing into mercadona.es). Ships first, zero account risk, already beats paper.
2. **M1 — Deep-link assist:** each line links its `share_url`; tap → product page → "Add". Tedious
   for 30 items but zero-risk.
3. **M2 — Auto-cart (the goal):** one-time token bootstrap → "Send to Mercadona" fills the real
   cart in one batched write, app shows "32 items, €87.40 in your cart — open Mercadona to pick a
   slot and pay". Explicit confirm + spend cap; never touches checkout. **Opt-in, clearly marked
   experimental.**

## 5. Data model (sketch)

```
Recipe        { id, title, photo, source(url|manual|seed), servingsBase, prepMin, cookMin,
                tags[], cuisine, kidScore, season[], nutrition: {kcal, proteinG, carbsG, fatG,
                estimated: true} /* per serving */, tools[], ingredients: [ {name, qty, unit,
                pantryStaple?} ], steps: [ {phase: 'mise'|'cook', text, timerSec?} ],
                lastCookedAt, ratings{} }
ProductMap    { ingredientKey → { productId, name, photo, unitPrice, packSize,
                confirmedAt, timesUsed } }              // the mapping memory
StaplesItem   { productId, name, defaultQty, cadence(weekly|biweekly|monthly), lastOrderedAt }
MealPlan      { weekStart, days: [ {date, recipeId?, servings, note?} ] }
OrderDraft    { lines: [ {source(recipe|staple|manual|tablet), productId?, ingredientKey, qty,
                packsNeeded?, coverageNote?, checked} ], suggestions: [ {kind(pack|merge|cadence),
                text, state(open|confirmed|ignored)} ], status(draft|filled|submitted),
                targetSlot?: {day, window}, submitBy?, pushedAt?, totalEur }
OrderHistory  { date, lines[], totalEur, deliveredAt? } // feeds "previously ordered" + pantry inference
Household     { members[], allergies[], dislikes[], loves[], weeknightMaxMin, cuisinePrefs[],
                goals: {mode?('weight-loss'|'maintain'|...), kcalPerDay?, highProtein?, notes?},
                showNutritionOnCards }
Reminders     { planWeekAt (default Sun pm), submitOrderBy (default Sun 22:00) → in-app + push }
```

Storage: same pattern as home-scenes — a dedicated section in the API's JSON store (or
`.data/kitchen.json` given recipe payload size), atomic writes. No new database.

## 6. Recipe content — where recipes come from

- **Seed library (ship with it):** ~50 family-dinner recipes curated for this household (Spanish
  market ingredients, kid-tested classics, 30-min weeknight bias), each with photo, tags,
  Mercadona-friendly ingredient names. I generate the seed set; owner prunes in 10 minutes.
- **URL import:** paste any recipe URL → parsed (most sites embed schema.org/Recipe JSON-LD; LLM
  fallback for the rest) → normalised into our model → photo pulled from the page.
- **Manual/quick add:** minimal form, tablet-friendly; photo optional.
- **Later:** photo-of-cookbook-page import (LLM vision), "import my Mercadona order history as
  implicit recipes".

## 7. Architecture fit (survey of the codebase, 2026-07-02)

- **Two new top-level sections** "Cooking" and "Groceries" (D4): nav items in
  `apps/web/src/components/shell/nav.ts`, lazy screens under `apps/web/src/screens/kitchen/`
  (shared module, two routes), routes in `App.tsx`. Web + mobile responsive per the standing
  rule (`ctx.desktop`); on mobile both sections sit in the More sheet.
- **Tablet:** new kiosk sub-screens `screens/tablet/TabletKitchen*.tsx` in the docs/32
  `TabletShell` — Tonight / Cooking mode / Quick add to list. Grocery ticking and cooking mode
  are exactly the "high-touch, low-authority, reversible" actions tablet mode was scoped for.
- **API:** `apps/api/src/connectors/mercadona.ts` (catalog + search + cart behind one interface,
  cached, UA-spoofed) + `apps/api/src/routes/kitchen.ts` (CRUD for recipes/plan/staples/drafts,
  `home-scenes.ts` pattern). Token bootstrap UI reuses the Tesla-token onboarding pattern.
  Kiosk-role writes allowed for list/plan/cooked actions (no admin authority needed).
- **No control-loop involvement** — this module never touches energy actuation; deploys are safe
  by construction. One optional hourly coordinator tick later (staples cadence, price refresh).
- **LLM calls (if D2 = yes):** small server-side Claude API helper for recipe parsing +
  free-form suggestions. First LLM use in the app — isolated helper, fails soft to
  deterministic behaviour, costs cents/month at household volume.

## 8. Phasing

| Phase | Scope | Value shipped |
|---|---|---|
| **P0 spike** | Mercadona connector on the mini (Spain IP): postal-code→`alc1`, category walk, search, product detail, price total. Prove Akamai lets the mini in. **Go/no-go gate for everything price-related.** | Confidence |
| **P1** | Recipes (seed library w/ photos + nutrition + URL import + CRUD) · week planner (suggestion engine, skip, quick-view, servings steppers, AI request box) · goals + loves in Preferences · list builder (dedup, pack-size math, newly-needed check, staples) · priced basket · order-rhythm reminders (submit-by countdown, push) · **M0 checklist**. Web + mobile. | Full plan→list loop; already replaces paper + memory |
| **P2** | Mapping memory UI (pick product once from live search) · token bootstrap · **M2 auto-cart** · smart efficiency suggestions (confirm/ignore) · slot/cutoff read via authed API + order status tracking · order history · `myregulars` staples seeding | The one-tap weekly order |
| **P3** | Cooking mode (3 phases: Prepare → Mise en place → Cook, tablet-first) · Tonight + out-of logging + order status on the kiosk TabletHome · ingredients-on-hand suggestions · cooked/ratings feedback | The wall tablet earns its place |
| **P4** | Claude-powered suggestions & imports · pantry inference from order history · price watch on staples · cookbook-photo import | It gets smarter every week |

Each phase is a separate worktree/PR per the standard workflow; P1 is pure additive UI + read-only
connector, so it deploys without touching the armed state.

## 9. Risks

- **Unofficial API** — could change or challenge us any day. Mitigations: interface-wrapped
  connector, caching, graceful degradation (the planner and recipes work fully offline from
  Mercadona; only prices/cart degrade).
- **Algolia → in-house search migration** is in progress at Mercadona. Mitigation: search behind
  an interface; fallback = category-tree walk.
- **Cart writes = account risk (ToS).** Mitigation: opt-in, human checkout, spend cap, batched
  minimal writes, easy kill-switch. Worst case we fall back to M0/M1 and lose nothing else.
- **Scope gravity.** This is a v1 of a genuinely big product. The phasing is the defence: P1
  alone must be independently useful.

## 10. Out of scope (v1)

Inventory/barcode pantry tracking (inference-only instead) · nutrition/macros · multi-store
comparison (Consum/Carrefour) · breakfast/lunch planning (dinner first) · voice control ·
household member accounts/permissions beyond the existing roles.

## 11. Decisions — LOCKED (owner, 2026-07-02)

- **D1 — Ordering ceiling: YES to M2 auto-cart.** One-time browser token bootstrap (Tesla-token
  pattern), opt-in, spend cap, human always checks out. Built in P2.
- **D2 — Claude API: YES, configurable.** Server-side LLM helper for recipe URL/photo parsing and
  free-form cooking suggestions. Configuration surface: Settings ▸ Intelligence — Anthropic API
  key (`.env` override supported), master on/off, and per-feature toggles (import parsing ·
  cooking suggestions · weekly-plan assist). Every LLM feature fails soft to the deterministic
  path when off/unavailable.
- **D3 — Cuisines: Spanish / Dutch / Japanese / Italian / global.** Seed library (~50–60 dinners)
  balanced across those five, tagged by cuisine so the suggestion engine can balance the week.
  Ingredients carry a **canonical Spanish name** (drives Mercadona SKU search) plus the display
  name; UI copy stays English.
- **D4 — TWO top-level sections: "Cooking" and "Groceries".**
  - **Cooking** = recipe library, week planner, cooking mode, "what can I make with…",
    household/cuisine preferences.
  - **Groceries** = order builder (newly-needed check), staples list, priced basket,
    Mercadona link + order history.
  - Handoff point: "Add week to groceries" on the planner explodes the meal plan into the
    Groceries order draft. Desktop rail: two nav items; mobile: both live in the More sheet
    (TabBar keeps its 4 primary tabs); tablet kiosk gets Tonight + Cooking mode + Quick list.
- **D5 — Household profile = configurable parameters,** not a one-time wizard: Cooking ▸
  Preferences panel — adults/kids count, allergies, hard dislikes, weeknight time budget,
  cuisine weights. Editable anytime; the suggestion engine reads it live.

## 12. Refinements — LOCKED (owner screen-by-screen review, 2026-07-02)

**Planner:** skip-a-night (eating out) with undo · real recipe photography · recipe quick-view
overlay · nutrition per recipe (kcal on card, macros in quick-view, estimated at import) ·
AI request box ("ask for anything") · per-day servings stepper (household default ± guests) ·
**order rhythm**: Monday-evening delivery target, submit-by deadline + countdown, in-app + push
reminders (slot booking stays human; P2 reads real slots/cutoffs via the authed API).

**Groceries** (approved as designed, plus): package-size consolidation math across recipes
(“900 g across 3 recipes → one 1 kg pack”) · smart efficiency suggestions with confirm/ignore
(bigger-pack savings, shared-fresh merges, cadence nudges).

**Tablet:** Tonight card integrated INTO the kiosk TabletHome (not a separate tab) · “we're out
of…” logging (tiles + free text) feeding the order draft · order status card with delivery
window + countdown.

**Cooking mode:** three phases — 1 Prepare (tools + ingredients checklists) → 2 Mise en place
(prep task tiles, early timers like rice) → 3 Cook (the approved step-by-step) — with a
persistent phase bar.

**Configuration:** goals in Preferences (weight loss / calorie budget / high-protein etc.)
weighting suggestions + surfacing nutrition badges, plus a **loved-ingredients list** alongside
dislikes.
