# Overnight App Audit — 2026-06-25

Full-app sweep for dummy features, bugs, and missing/broken pieces, run via four parallel
read-only investigators (frontend, backend, auth/security/PWA, integration) plus manual
verification of every fix against the real `main` source. Safe, isolated fixes were applied
and deployed; everything risky or judgment-heavy is documented below for review.

**Scope note:** the working checkout was mid-flight on branch `intesis-climate` with uncommitted
work (Intesis climate connector + screen cleanups) that is NOT mine. All fixes were made in an
isolated worktree off `origin/main` so that in-progress work was never touched or entangled.

---

## A. Fixed & DEPLOYED  ✅

A tight "chart robustness + accessibility" bundle — zero behaviour change, build-verified, in
component files that don't overlap the in-flight branch work.

- **AreaChart divide-by-zero / NaN crash** — `apps/web/src/components/energy/AreaChart.tsx` — `stepX = w/(len-1)` went to `Infinity → NaN` path coords for an empty/single-point series; now guarded (`firstLen > 1 ? … : 0`).
- **AreaChart gradient-id collision** — same file — id came from `Math.random()`; two charts on one page (BatteryDetail renders two) could collide and cross-wire fills. Switched to React `useId()`.
- **RadialGauge accessibility** — `apps/web/src/components/ui/RadialGauge.tsx` — SVG-only gauge had no accessible value; added `role="img"` + `aria-label` ("State of charge: 92%" etc.). Affects every SoC/health gauge.
- **Chart a11y** — `Sparkline.tsx` marked `aria-hidden` (decorative), `BarChart.tsx` given `role="img"` + label.

## B. Built on a branch — needs your review

- None this run. The deployed set above was the only fully-safe, non-entangling work; everything
  else is a judgment call or touches auth/control/in-flight files (see C/D).

## C. Found but NOT fixed — prioritised (recommendations)

### Security (highest priority — review first)
- **Unthrottled OTP & reset** — `apps/api/src/routes/auth.ts` (`/login` OTP issuance, `/request-reset`) — no rate-limit; an attacker can spam the victim's WhatsApp/email and mint unlimited live reset tokens. → add per-user/per-IP throttle + min re-send interval.
- **Secrets logged in plaintext** — `auth.ts:105` (login OTP), `auth.ts:172` (full reset link), `users.ts:186` (setup link) — land in the server journal. There's a documented "recover from journal" workflow, so this is partly intentional, but it's a standing credential-in-logs exposure. → gate behind a dev-only flag.
- **WhatsApp 2FA is default but can silently fail** — `apps/api/src/auth/users.ts` (new users default to `whatsapp`), `notify.ts:99-148` (no-ops with no provider key), `auth.ts:71-74` (OTP goes to one *shared* number, not per-user). A 2FA user can be locked out or have their code sent to the wrong phone. → default new users to email; block enabling WhatsApp-2FA until a provider is configured; add a per-user phone field.
- **2FA toggle desync** — `apps/web/src/screens/Settings.tsx:~280` — the toggle boots from `useState(false)` and never reads real 2FA state, so toggling it can *disable* a user's actual 2FA. → seed from a `me`/`get2fa` field.

### Correctness — savings/energy math (numbers shown as real)
- **`/api/live` fabricated today-totals** — `apps/api/src/routes/live.ts:157-167` — when Tesla history is unavailable, `producedKwh = solarKw*5`, `consumedKwh = homeKw*12` (extrapolated from one instantaneous sample) and `savedEur` values all self-use at the *current* band rate. Shown without an "estimated" badge. → flag `estimated:true` or return `—`; value at a band-weighted average.
- **Savings formula inconsistent across endpoints** — `live.ts` vs `history.ts` use different definitions; the brain plan (`brain.ts`) treats Sonnen+Tesla as one lossless tank with summed max-power and **no round-trip losses**, overstating `savedEur`/`p1AvoidedKwh`. → unify on `displaced-grid-imports × avg-rate`; apply ~0.88 round-trip efficiency.
- **`byBand` cost split uses fixed weekly-hour weights** — `history.ts:121-129` — a single weekday gets weekend-weighted P3 share. → derive band per history bucket from its timestamp.
- **Spanish national holidays billed as weekday bands** — `apps/api/src/tariff.ts:51-57` — holidays are P3 all-day but charged P1/P2 here. → add a holiday calendar.
- **`rule-reserve` hardcodes 20% target** — `apps/api/src/routes/alerts.ts:22,140` — fires even when the active scenario intentionally set a lower reserve → false "reserve low" alerts. → compare against the active scenario's reserve.

### Dummy / placeholder data
- **Seeded fake alerts always injected** — `apps/api/src/routes/alerts.ts:34-57,185` — "Sonnen back online" / "High solar forecast tomorrow" are hardcoded into every `/api/alerts` response. → remove (needs a graceful empty-state in `Alerts.tsx`, which is being edited on `intesis-climate` — hence deferred, not done, to avoid a merge tangle).
- **`byLoad` appliance split is a fixed % guess** — `history.ts:72-79` — correctly flagged `estimated:true`, but once Intesis HVAC data is wired the A/C slice should be real.
- **Scenario preview is a hand-tuned heuristic** — `apps/api/src/routes/scenarios.ts:101-129` — labelled "estimate"; ideally reuse the brain plan with the candidate scenario.
- **Hardcoded weather "26° sunny · Jávea"** — `Live.tsx`, `Batteries.tsx`, `shell/TopBar.tsx` — static, not from the Open-Meteo source Settings advertises. **"Updated just now"** desktop subtitle is also a constant (`Live.tsx`).

### UX / dead affordances
- **Cold-start mock masking** — Live/Reports/Brain/Batteries/Settings fall back to `MOCK_*` on a first-load API failure with no error surface (the stale banner only appears after a prior success), so a real outage can look like a healthy house. → render an explicit error/empty state when `data===null && stale`. *(Note: Scenarios was flagged for this but is actually fine — it already renders the banner.)*
- **Scenarios & Autopilot unreachable on mobile** — `shell/TabBar.tsx` "More" → `/settings`, but `Settings.tsx` has no links onward to `/scenarios` or `/brain`. → add nav rows.
- **Inert chevron rows** — `Settings.tsx` "Edit tariff & rates", "Theme", connection rows, and the **"+ New" scenario tile** (`Scenarios.tsx:173`) render tappable affordances that do nothing. → wire or drop the chevrons.
- **Keyboard a11y** — alert rows (`Alerts.tsx`) and scenario cards (`Scenarios.tsx`) are click-`div`s with no `role`/`tabIndex`/key handler. → mirror the existing `LinkRow` pattern.
- **Capacity bar can exceed 100%** — `apps/web/src/screens/BatteryDetail.tsx:119-134` — if live `soc < reservePct` the reserve+available+headroom segments overflow. → clamp reserve to `min(soc, reservePct)`.

### Cost / robustness
- **Uncached Tesla `/site_info` on every control-status poll** — `connectors/tesla.ts` `readControlConfig()` is deliberately uncached and `routes/control.ts getStatus()` calls it on each `/api/control/status` poll → a pay-as-you-go Tesla call per poll. → cache 15–30s, or only read uncached right after a write.
- **In-process day buffers reset on restart** — `live.ts` (and the batteries route) — the "today" curves wipe on every deploy and are running-averaged. → persist, or back with Tesla `calendar_history`; label as session-only.
- **Unverified device conventions** — Sonnen `GridFeedIn_W` sign, Tesla `nameplate_energy` Wh/kWh heuristic, Tesla `island` defaulting to on-grid when the field is absent, Intesis temp ÷10 heuristic — all "validated live" but unconfirmed; each can invert an alert or misreport a number. → confirm against the real devices.

### PWA
- **SW version never bumped** — `public/sw.js` `VERSION='power-v1'` + `skipWaiting`/`clients.claim` + no update prompt → stale unhashed assets (icons/offline.html/manifest) stick across releases. → bump VERSION per release (or wire to build hash) and add a reload prompt.
- **Logout leaves push live** — `auth/AuthProvider.tsx`, `routes/push.ts` — no unsubscribe on logout, and subscriptions aren't bound to a user (alerts broadcast to all stored endpoints). → add unsubscribe on logout + bind subs to userId.

### Tooling
- **API build skips typechecking** — `apps/api/build.mjs` (esbuild) + every route returning `Promise<unknown>` means contract drift is invisible to TS (this is exactly how a committed `solar.arrays` object-vs-array bug slipped through). → chain `pnpm -r typecheck` into CI before build; type route returns against the shared contract.

## D. Skipped for safety

- **Battery-control core** (`apps/api/src/control/*` — execute/guardrails/coordinator) — read-only only; never touched. No command was ever issued; control remains DISARMED.
- **All auth/security changes** — flagged in C, not auto-applied: they need careful testing and the API cannot be run locally (it rotates the shared Tesla token). Best done supervised.
- **In-flight `intesis-climate` files** — `routes/live.ts`, `screens/{Alerts,Brain,Live,Reports}.tsx` — left to that branch. They look healthy and even **fix a real bug** (the committed `solar.arrays` object-vs-array shape mismatch). Recommend committing that branch.

---

### Bottom line
The app is in good shape; nothing dangerous shipped overnight and control stayed disarmed. The
deployed bundle hardens charts + accessibility. The highest-value follow-ups are **(1) auth
rate-limiting + stop logging OTP/reset secrets**, **(2) make the savings/self-sufficiency math
consistent and honest about estimates**, and **(3) surface real outages instead of silently
falling back to mock data**. None should be auto-deployed unsupervised.
