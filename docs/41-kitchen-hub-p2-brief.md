# 41 — Kitchen Hub P2 build brief (cart link · smart suggestions · slots · hardening)

_Follows docs/39 (P0+P1, shipped as PR #190 → `b59d1be`, live). Concept: docs/38 (§3 API facts,
§4 ordering modes, §12 refinements). Screens: `docs/mockups/kitchen-hub-v4.html` — the Groceries
frame already shows the P2 states (enabled Fill-cart, interactive suggestions strip, slot row)._

## Scope (one PR)

### 1. Mercadona account link (M2 token bootstrap — Tesla-token pattern)

- Settings ▸ Connections ▸ Mercadona: "Link account" flow. Guided UI (step-by-step copy) for the
  one-time manual bootstrap: log in at tienda.mercadona.es in a browser → copy the refresh token
  (give exact instructions: DevTools → Application/Storage or the token response in Network; make
  it dummy-proof, with screenshots-in-words). Paste token + customer id (or fetch customer id
  server-side from the token).
- Server: `connectors/mercadona-auth.ts` — refresh-token session management. **Tokens rotate on
  every use**: persist the newest refresh token atomically IMMEDIATELY on rotation (a lost
  rotation = owner must re-bootstrap). Access token cached in memory only. All auth state under
  `kitchen.mercadona.account` in the store; never log tokens; mask in any GET (pattern: P1's
  `maskedKey()`).
- Status surfaced on the Connections row: linked-as (name/email if the API exposes it), token
  health, "Unlink".

### 2. Cart fill (the headline)

- `POST /api/kitchen/order/fill-cart` (requireAuth): reads the current draft's checked+mapped
  lines → batched write to `PUT /api/customers/{id}/cart/` with **flattened
  `{product_id, quantity}`** (the endpoint rejects nested product objects; batch to avoid the
  eventual-consistency race — see exwyezed/mercadona-cli endpoint notes in docs/38 §3).
- Guardrails (all server-side): spend cap (config `kitchen.mercadona.spendCapEur`, default 150,
  editable in UI) — refuse above cap with a clear error; explicit confirm modal client-side
  ("32 items · 87,40 € → your Mercadona cart"); **never touch checkout/order endpoints**;
  warehouse must match the linked account's delivery address (fail with a readable message if
  not); kill-switch = unlink.
- On success: draft `status: 'filled'`, UI shows "in your cart — open Mercadona to pick a slot
  and pay" + link to tienda.mercadona.es; event-log entry (`kitchen`, action). Enable the P1
  disabled button; keep "Send as checklist" as fallback.
- **Dry-run mode** (`kitchen.mercadona.dryRun`, default ON until the owner links): builds and
  validates the exact payload, logs it, returns it in the response without sending. E2E with the
  real account happens post-deploy with the owner; ship with dry-run defaulting appropriately.

### 3. Interactive smart suggestions (v4 mockup, cyan strip)

- Engine (deterministic, `kitchen/suggestions.ts`): (a) **bigger-pack savings** — compare mapped
  product `unit_price` vs `bulk_price`/larger sibling products (same search, larger pack) when
  usage history supports it; (b) **merge fresh** — same fresh ingredient across ≥2 recipes this
  week → single line; (c) **cadence nudge** — staple's typical order interval (from OrderHistory)
  exceeded. Each suggestion: `{kind, text, state}` on the draft (type shipped in P1).
- Confirm applies the change to the draft; Ignore records it; **ignored twice for the same
  (kind, subject) → suppressed permanently** (per review guidance). UI per mockup: strip card on
  desktop, inline rows on mobile.

### 4. Slots + order status

- `GET /api/kitchen/order/slots` (authed account): read available delivery slots/cutoffs via
  `GET /api/customers/{id}/addresses/{id}/slots/`; surface the REAL cutoff for the Monday-evening
  target in the rhythm strip + basket slot row (replacing the static label). Booking stays human.
- Order status tracking: poll (on Groceries open + coordinator tick) the account's orders
  endpoint → move draft `filled → submitted` when a matching order appears; store
  `OrderHistory` entries with delivery window; status card per mockup (also feeds P3 tablet).
- `myregulars` (`GET /api/customers/{id}/recommendations/myregulars/`) → "seed staples from your
  regulars" one-tap import on the Staples tab.

### 5. Hardening (review follow-ups from PR #190 — all four)

1. **SSRF guard** on `/recipes/import`: resolve the hostname, reject RFC1918 / loopback /
   link-local / .local before fetching (and re-check on redirects).
2. **`enrichLines` parallel + negative cache**: fetch through the existing 2-slot gate with
   `Promise.all`; on first hard connector failure short-circuit the rest; negative-cache
   unreachability for 5 min so a 30-line draft can't stall minutes when Mercadona is down.
3. **Surface the mixed-unit flag**: copy `incomparable` onto the OrderLine; UI shows a small
   amber "check quantity" hint on such lines.
4. **Algolia key scrape**: require the 32-hex match within ~200 chars of an
   `algolia|apiKey|searchKey` token (case-insensitive) to avoid webpack-hash false positives.

## Out of scope

P3 (tablet Tonight/kiosk screens, 3-phase cooking mode, out-of logging) — next PR. Any checkout/
payment/slot-booking automation — never.

## Workflow & acceptance

Same standing rules as docs/39 (worktree `kitchen-hub-p2` via scripts/new-worktree.sh, no
Prettier, both viewports, rebase before push, review-first PR, no merge). Commit this brief in
the PR. Acceptance: unit tests for suggestion kinds + suppression, spend-cap refusal, token
rotation persistence (inject fs), SSRF guard matrix (10.x/127.x/169.254/192.168/fe80/::1/
redirect), enrichLines degraded-latency test (mock 8s timeouts → assert fast return); dry-run
fill-cart returns the exact batched payload for a hand-checked draft; UI verified at ≥768px and
<768px with screenshots in the PR; `npm run build` + full test suite green post-rebase.
