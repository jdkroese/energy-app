# 42 — Kitchen Hub P3 build brief (tablet Tonight · 3-phase cooking mode · cooked feedback)

_Follows docs/39 (P0+P1, live) and docs/41 (P2, live). Concept: docs/38 (§2 Loop C, §12).
Approved screens: `docs/mockups/kitchen-hub-v4.html` — the two tablet frames (TabletHome with
Tonight integrated; cooking mode phases 1–3) are THE spec for this PR._

## Scope (one PR)

### 1. Kiosk / tablet surfaces (docs/32 shell)

**First: verify what exists.** `AppShell` was reported to branch to a lazy `TabletShell`
(`useKiosk()` from `apps/web/src/lib/kiosk.ts`, screens under `apps/web/src/screens/tablet/`).
If that kiosk shell exists, extend it; if it does NOT exist yet, build the minimal kiosk frame
per `docs/32-tablet-mode.md` (localStorage opt-in `power.tablet.kiosk`, icon rail, no auth
prompts for the kiosk role) as part of this PR — but keep it minimal: home + kitchen tabs +
alarm; the other tabs can be stubs if they don't exist.

- **TabletHome — Tonight integrated (v4 frame 5):** today's planned dinner (photo, title, time,
  kcal, servings, kids badge) + "Start cooking" + "Cook something else" (opens the planner's
  library in a kiosk-friendly picker); scenes quick row (reuse existing home-scenes apply API if
  present); "We're out of…" quick-add tiles (top staples by order frequency) + "Type it…"
  free-text → adds to the order draft with `source:'tablet'` (unmapped items go through mapping
  memory later on desktop/mobile); week strip (7 mini-days); **order status card** (reuse P2
  `syncOrderStatus` data: filled/submitted/delivery window + countdown).
- **Kiosk kitchen tab (chef-hat):** tonight's recipe detail + cooking mode entry + the week.
- **Kiosk authority:** quick-add, cooked!, timers = allowed for the kiosk role; **cart fill and
  account/settings surfaces must never render on the kiosk** (docs/32: authority stays off the
  wall). Check what role/token the kiosk uses; if `requireKioskOrAdmin` exists, gate the new
  writes accordingly; the fill-cart route stays requireAuth (non-kiosk).

### 2. Cooking mode — 3 phases (v4 frames 6a/6b/6c) — ALL surfaces, tablet-first

Route `/cook/:recipeId` (works on desktop/mobile too — entered from quick-view "Cook now",
planner, and the tablet). Layout per the mockup, huge type, ≥46px targets.

- **Phase bar** (1 · Prepare → 2 · Mise en place → 3 · Cook) always visible; "Skip checks"
  jumps straight to Cook.
- **Phase 1 Prepare:** tools checklist (from `Recipe.tools[]`) + ingredients checklist with
  amounts **rescaled to tonight's servings** (plan servings if launched from the plan, else
  household default; stepper in the header).
- **Phase 2 Mise en place:** steps tagged `phase:'mise'` as check-off task rows; a task with
  `timerSec` gets an inline start button; **started timers persist across phases/steps** and
  render as a compact countdown chip in the header (in-memory + localStorage so a reload
  survives; no server clock needed).
- **Phase 3 Cook:** one step per screen (`phase:'cook'`), step counter + dots, inline rescaled
  ingredient chips (parse quantities referenced in the step where the seed data provides them —
  the seed steps already carry `ingredientRefs` if present; otherwise show the step text only),
  per-step timer, Back / Next (next button previews the next step's title).
- **Screen-awake:** use the Screen Wake Lock API while cooking mode is open (feature-detect;
  re-acquire on visibilitychange; release on exit).
- **Cooked! completion screen:** one tap logs `lastCookedAt` (feeds rotation) + optional
  rating (👍 / 😐 / 👎) stored on `Recipe.ratings` → suggestion engine boost/penalty (small,
  e.g. ±10%); logs a `kitchen` event.

### 3. "What can I make with…" (ingredients on hand)

On Cooking (all viewports) + kiosk kitchen tab: input a few ingredients (chips, free text) →
deterministic ranking of library recipes by % ingredient coverage (normalise names; pantry
staples count as always-available), show coverage badge ("7 of 9 on hand"). If Intelligence ON
and the "Cooking suggestions" toggle is ON: a "More ideas" action asks Claude for free-form
ideas (existing `connectors/claude.ts` helper; fails soft to the deterministic list).

### 4. Small follow-through

- Quick-view "Cook now" wires to `/cook/:id`.
- Planner day cards: after cooking, show a subtle ✓ cooked state for past days.
- Mobile/desktop parity for everything (standing rule) — cooking mode and what-can-I-make are
  NOT tablet-only.

## Out of scope

P4 (pantry inference, price watch, photo-of-cookbook import, weekly-plan Claude assist beyond
the existing toggle). Any cart/checkout changes. Tablet tabs unrelated to kitchen (lights/
climate/shades) beyond what already exists.

## Workflow & acceptance

Standing rules as docs/39/41 (worktree `kitchen-hub-p3`, no Prettier, rebase before push,
review-first PR, no merge; commit this brief). Acceptance: (1) cooking mode E2E on a seed recipe
at 1280px + 390px + a ~1024px landscape viewport — phase transitions, timer persisting across
phase change AND a reload, wake-lock acquired/released (log it), Cooked! updates lastCookedAt/
rating and the planner shows ✓; (2) rescaling: 2+2 → 2+2+2 changes phase-1/3 amounts correctly;
(3) kiosk: Tonight shows the plan's actual today entry (and a sane empty state when nothing
planned/skipped), quick-add lands in the draft with source 'tablet', order-status card renders
the P2 data, NO cart-fill/settings surface reachable in kiosk mode; (4) what-can-I-make ranking
unit-tested (coverage math, pantry-always-available) + Intelligence-off fallback verified;
(5) `npm run build` + full suite green post-rebase; screenshots (3 viewports) in the PR.
