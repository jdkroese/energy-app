# 43 — Kitchen: decouple Regulars from Staples (fix + rework)

_Owner-reported 2026-07-03: "Seed staples from your regulars" imported **all 131** Mercadona
regulars as **weekly staples** (`cadence:'weekly'`), and re-opening the modal showed every row
green-checked but "Add 0 as staples" (all `alreadyStaple`) with no way to see/undo it. Root cause:
Mercadona "my regulars" is the entire repeat-purchase history (131 items), which is the wrong
thing to dump into a curated weekly-staples list. The 131 mis-added staples were already cleared
live (PUT /staples {[]}, 131→0). **Owner decision: treat regulars as a SEPARATE browse-to-quick-add
source; staples stays a small, hand-curated list.**_

## Goal

Regulars become a **browse-and-add-to-this-week's-order** surface (they're real, already-mapped,
already-priced Mercadona products). They no longer touch Staples. Staples remains manually curated.

## Server (`apps/api`)

1. **Remove the staples path for regulars.** Delete `POST /api/kitchen/staples/import-regulars`
   and its handler (routes/kitchen.ts ~1214). No auto-seed of regulars into staples anywhere
   (confirm the account-link flow never seeds staples either).
2. **Regulars endpoint = read for browsing.** Keep `GET /api/kitchen/staples/regulars` but:
   - Rename the response field `alreadyStaple` → **`inDraft`**, computed from the current order
     draft: `orderDraft.lines.some((l) => l.productId === p.id)`. (Field rename in
     `KitchenRegularHit` / `KitchenRegularsResponse` types both sides.)
   - Optionally also expose it at `GET /api/kitchen/regulars` (alias) for clarity; either is fine
     since it's an internal API — just keep the client in sync.
3. **Add `'regular'` to the `OrderLine.source` union** (`kitchen/types.ts` + web `types.ts`), so
   basket grouping can label these. Basket card (Groceries) groups by source — add a
   **"From your regulars"** bucket (own dot color, e.g. `--battery`) alongside recipe/staple/
   manual; or fold into the existing "Added by hand" bucket if simpler — builder's call, but it
   must render and price correctly.
4. No new write endpoint required: regulars are added to the draft via the existing
   `PUT /api/kitchen/order/draft` (the tablet quick-add already builds `OrderLine[]` and calls
   `setOrderDraft`). Server already re-prices/validates draft lines on PUT — verify a line with a
   real `productId` prices via the connector as usual.

## Web (`apps/web/src/screens/kitchen/Groceries.tsx`)

5. **Repurpose `RegularsModal` → a Regulars *browser*** that adds to the ORDER, not staples:
   - Title/subtitle → "Your Mercadona regulars" / **"Tap to add to this week's order."**
   - **No pre-selection** (the old bug pre-checked all 131). Start with nothing selected.
   - **Add a search/filter box** at the top — 131 items needs filtering by name.
   - Rows show `inDraft` state (greyed + "· in your order") instead of "already a staple";
     `inDraft` items aren't re-addable.
   - Keep the `recommendedQty` display; the added line uses `qty = recommendedQty || 1`.
   - Footer button → **"Add N to order"** (disabled at 0). On click, build `OrderLine[]` (append
     to the current draft, mirroring `kitchenWidgets.tsx` `quickAdd`: `source:'regular'`,
     `productId:p.id`, `label:p.name`, `qty`, `ingredientKey` from `clientIngredientKey(name)`,
     `checked:true`, price from `unitPrice*qty`), call `api.kitchen.setOrderDraft({lines})`,
     refetch draft, close. Success note: "Added N items from your regulars ✓".
6. **Move/rename the entry point.** The current button reads "Seed staples from your regulars" and
   lives in the staples area — change it to **"Add from your regulars"** and place it where it
   belongs to the ORDER (e.g. the Groceries toolbar next to "Order history", shown only when
   Mercadona is linked). It must be reachable regardless of which segment (Recipes/Staples/Basket)
   is active.
7. **Staples tab: manual curation only.** Remove the regulars-seed affordance from it. Keep the
   existing "＋ Add a staple" (manual). (If "＋ Add a staple" today does nothing useful, wiring it
   to the existing product search / mapping-memory picker is a nice-to-have but NOT required for
   this PR — the required outcome is that staples is no longer auto-populated from regulars.)
8. Remove `api.kitchen.importRegulars` from `lib/api.ts`; update the `KitchenRegularHit` type
   (`alreadyStaple`→`inDraft`). Grep for any other `importRegulars` / `alreadyStaple` / "as
   staples" references and update (incl. the tablet widgets if they reference regulars — they
   shouldn't).

## Out of scope

Per-item qty steppers in the browser (recommendedQty default is fine); pantry inference; anything
in the P4 backlog. No cart/checkout changes. No staples data migration needed (already cleared
live; and there's no provenance flag, so don't mass-delete staples in a migration — a fresh
account simply starts empty).

## Workflow & acceptance

Standing rules (worktree `kitchen-regulars`, no Prettier, both viewports, rebase before push,
review-first PR titled `fix(kitchen): regulars browse-to-order, decoupled from staples`, commit
this brief, **do not merge** — orchestrator reviews/lands). Acceptance:
1. Linked account: "Add from your regulars" opens the browser; search filters; nothing
   pre-selected; selecting N + "Add N to order" adds N priced lines to the draft (basket count +
   total rise) with `source:'regular'`; re-opening shows those N as `inDraft`/greyed.
2. Staples tab no longer offers or performs any regulars import; adding a regular does NOT create
   a staple (staples stays at its curated count).
3. `GET …/regulars` returns `inDraft` (not `alreadyStaple`); `import-regulars` route is gone (404)
   and no client references it.
4. Both viewports (desktop modal + mobile sheet) verified with screenshots in the PR.
5. `npm run build` + full kitchen test suite green post-rebase; add/adjust a unit test for the
   `inDraft` computation and (if present) any regulars serializer.
