# 34 — Blinds: timed partial positioning

## Problem

All 8 house blinds are Tuya `cl`/`clkg` motors that expose **only** open/stop/close —
none advertise a `percent_control` DP, so `supportsPosition` is `false` and the card shows
no slider. The owner wants to set a blind to an arbitrary % (e.g. 50%).

The blinds take the **same time** to fully open as to fully close. So position can be
simulated by timing: run the motor for `travelSec × Δ% / 100`, then Stop.

## Mechanism

Per-blind config stores one number: `travelSec` (seconds for a full open **or** close).

A move to `target%`:

```
Δ         = target − assumedPct           (signed)
direction = Δ > 0 ? open : close
duration  = travelSec × |Δ| / 100
→ send <direction> · wait(duration) · send stop
```

- Full **Open** (100) / **Close** (0) send the raw command with **no timer** and set
  `assumedPct` to the known end (100 / 0). These are the re-anchor points.
- The **timer runs server-side** (API), not the client, so a locked phone / closed tab
  mid-move still gets its Stop.

### Accuracy: re-anchor when unknown (owner decision, 2026-07-01)

There is no position feedback, so `assumedPct` can be stale after a restart or a manual
physical operation. Track `anchored: boolean` per blind:

- Full open/close → `anchored = true`, `assumedPct = 100 | 0`.
- Timed partial move completes → `assumedPct = target`, stays anchored.
- API restart / never-moved → `anchored = false`.
- **First partial move while `anchored === false`:** prepend a full close to 0
  (known end), then open to target. Guarantees an exact result at the cost of extra travel.
- While anchored, partial moves are relative (fast path).

## Data model

`DeviceSettings` (`apps/api/src/store.ts`) — add alongside `invertPosition`:

```ts
travelSec?: number;   // full-travel seconds; enables timed positioning when set
```

Runtime position tracking lives server-side (not in `deviceSettings`, which is
user config). Add a small in-memory/state map keyed by device id:

```ts
{ assumedPct: number, anchored: boolean, moveToken?: string }
```

`moveToken` cancels a superseded move: if a new command arrives mid-travel, invalidate the
pending Stop and start fresh from a re-anchor.

## API

- `getBlinds` normaliser: a blind is position-capable when
  `supportsPosition || (travelSec != null)`. Expose `positionMode: 'native' | 'timed' | null`
  and echo `assumedPct` so the card can render the slider for timed blinds.
- `commandBlind` (`apps/api/src/routes/blinds.ts`), `lever: 'position'`:
  - native blind → existing behaviour (write `percent_control`).
  - timed blind → run the sequence above with a cancellable timer; return immediately with
    `moving: true`. Persist `assumedPct` + `anchored` when the Stop fires.
- `lever: 'open' | 'close'` on a timed blind → raw command + set anchor.
- Guard: clamp `travelSec` to a sane range (5–90s). Ignore timed position if `travelSec` unset.

## UI (web + mobile — one responsive card)

`apps/web/src/screens/Blinds.tsx`, `BlindCard`:

1. **Settings panel** (below "Invert direction"): a "Travel time" row — seconds stepper
   (`Input`/`Button`, step 5, 5–90s) + helper `Full travel {n}s · each 10% ≈ {n/10}s`.
   Saves via existing `api.devices.setSettings(id, { travelSec })`.
   (Calibrate wand = v2, not this pass.)
2. **Position control**: render the existing `Slider` (0–100, unit `%`) + preset chips
   (0/25/50/75/100) whenever `positionMode` is set. Debounce drag; on release send
   `lever:'position', value`. Optimistic `positionPct` override already exists — reuse it.
   Above the slider, a **window silhouette** (self-contained illustration with its own
   fixed colours, so it's theme-independent) whose venetian shade drops to the current
   position and animates as the slider moves (short finger-tracking transition on drag,
   a longer eased glide on preset/Open/Close; reduced-motion disables it).

   **Display convention — "% CLOSED" (owner decision, 2026-07-01):** the UI shows percent
   **closed** (0% = fully open, 100% = fully closed), NOT percent open. This is a
   display-only inversion at the UI boundary — the API/internal model stays "% open"
   (`positionPct`/`assumedPct` where 100 = open, and the `lever:'position'` value stays
   open-convention). The card converts at the render/command edge: displayed value and
   slider = `closedPct = 100 − openPct`; on send `openTarget = 100 − closedTarget`. The
   shade height = `closedPct`%. Presets 0/25/50/75/100 mean % closed; **Open → 0% closed**
   (open lever), **Close → 100% closed** (close lever). Live line reads in closed terms
   ("60% closed"). The invert-direction setting is a separate raw↔open flip below this and
   is unaffected by the closed display.
3. Keep Open / Stop / Close as the full-travel shortcuts. Show a live state line
   (in CLOSED terms: "60% closed" while moving; "Holding · 60% closed" at rest).
4. Verify **both** viewports (`preview_resize` ≥768 and <768) per the standing rule.

Design language: "Power" dark control-room; mono numerals for the %. No new design-system
primitives — `Slider`, `Switch`, `Input`, `Button` already ship and are used on this card.

## Out of scope (follow-ups)

- Calibrate: one-tap full close→open that times travel and stores `travelSec`.
- Schedules targeting a % (the Schedules block already exists on this screen).
- Tilt (venetian slat angle) — separate DP, not requested.

## Deploy

Ship as a PR off latest `origin/main`; **do not merge** — owner reviews. This is
motor-control logic; a deliberately-safe review-first rollout. `main` is the only branch
that deploys.
