# UX Upgrade Plan — app-wide polish, consistency, light/dark theme

_Owner request (2026-06-28): an overall UX upgrade across the app — animations, consistency,
a light/dark theme setting, etc. This is the plan from a three-part audit (theming,
consistency, motion/accessibility). No build started yet; sequencing + scope to be confirmed._

## Why now / the read

The **foundation is strong**: ~140 CSS tokens (`apps/web/src/index.css`), a clean token-driven
primitive library (`apps/web/src/components/ui`), `<html data-theme="dark">` already present,
and isolated examples of excellent craft (PlanTimeline's reduced-motion staggered animation).
The problem is **drift from velocity** — months of parallel agents each solving the same UI
problems locally. The fix is leverage: a few shared primitives + finishing tokenization, and
the theme, the consistency, and the polish all fall out of the same work.

## Audit findings (synthesized)

**Theming** — token foundation solid; `data-theme` ready; Settings has a "Theme" stub. Blockers:
~156 hardcoded colors (worst: `components/energy/DayChart.tsx` SVG series/band palette; also
rgba accent borders in `Devices.tsx`, fallback hex in `index.css`/`dsStyles.ts`). A light theme =
define `:root[data-theme="light"]` token overrides + tokenize the hotspots + theme switch infra.

**Consistency** — top drifts: (1) screen headers split across raw `<h1>` (Live/Reports/Settings/
Scenarios/Autopilot) vs `TopBar` vs `MobileHeader`; (2) **5+ modal/overlay implementations**
(ConfirmDialog, EditRuleOverlay, VoltageHistoryOverlay, SetupSheet, ScenesAndSchedules [z-index 60
BUG], Autopilot nested) — inconsistent z-index/blur/animation; (3) no shared empty/loading/error
states; (4) ad-hoc list-row dividers everywhere; (5) bespoke tab strips instead of `SegmentedControl`;
(6) spacing as ad-hoc px not `--space-*`; (7) copy-tone + icon-name drift.

**Motion / a11y** — motion is ad-hoc with hardcoded durations/easings (tokens exist, underused);
no route/page transitions; `prefers-reduced-motion` honored in only 2 places (index.css block +
PlanTimeline); gaps: focus-trap/auto-focus in modals, `--text-3`/`--text-disabled` contrast FAILS
WCAG AA on surfaces, small mobile touch targets (device-row control buttons 26–28px), no aria-live,
no keyboard nav on custom controls (ModeChip/Stepper/PowerToggle).

## The plan — six tracks, each shippable in small PRs

### Track A — Foundation (do FIRST; additive, low-conflict)
- **A1** Tokenize the hardcoded-color hotspots: DayChart series/band palette → tokens (read via
  `getComputedStyle` for SVG, or a theme-aware config); `Devices.tsx` rgba accent borders → tokens;
  fallback hex in `index.css`/`dsStyles.ts`.
- **A2** Motion foundation: replace hardcoded durations/easings with `--dur-*`/`--ease-*`; promote a
  `usePrefersReducedMotion()` hook (from PlanTimeline) and a global reduced-motion gate covering ALL
  keyframes (sync dot, status/alarm pulse, spinner, splash, overlays).
- **A3** Fix dark-theme contrast failures (`--text-3`/`--text-disabled` on surfaces) — benefits dark
  today and de-risks light.

### Track B — Light/Dark theme (the headline; depends on A1/A3)
- **B1** Define `:root[data-theme="light"]` token set: invert neutrals, darken+saturate energy hues
  (solar #0d9b6f, battery #1488c4, grid #8a560a-range) for contrast on white, re-tune washes/glows/shadows.
- **B2** Theme infra: `lib/theme.ts` (`dark | light | system` + localStorage + apply on mount; reactive
  `<html data-theme>`); initialize in `AppShell`.
- **B3** Settings: replace the Theme stub with a real Dark/Light/System control. Exercise on the
  `/Design system` showcase route in both themes.
- **B4** Contrast/QA pass — both themes, both viewports.

### Track C — Shared primitives (kills drift; high leverage)
- **C1** `<Modal>`/`<Overlay>` primitive: unified backdrop + fade/rise, z-index hierarchy (overlay 1000 /
  nested 1010 / toast 1020), focus trap + auto-focus + Escape, reduced-motion. Migrate the 5+ overlays
  (fixes the z-60 bug AND the focus-trap a11y gap at once).
- **C2** `<ScreenHeader>` consolidation: one header entry (eyebrow + h1), both viewports; kill raw-`<h1>` drift.
- **C3** `<EmptyState>` / `<LoadingState>` (skeleton) / `<ErrorState>` family, promoted to `components/ui`.

### Track D — Motion & interaction polish (the "feel"; depends on A2 + C1)
- **D1** Route/page transitions (subtle fade/slide on deeper nav; reduced-motion aware).
- **D2** Interactive feedback: animate card/row hover (not instant translate), animate optimistic-pending
  (row dim, not just the sync dot), expand/collapse for inline editors, pressed/active states on custom controls.
- **D3** Touch-target sizing on mobile control buttons (→ ≥40px).

### Track E — Accessibility (cross-cutting; mostly rides B/C/D)
aria-live for async/sync; focus management (via C1); contrast (via A3/B); touch targets (via D3);
keyboard nav for custom widgets (ModeChip/Stepper/PowerToggle).

### Track F — Consistency sweeps (incremental, AFTER primitives exist; lowest priority)
Migrate screens to the shared primitives (headers, rows, states); spacing-token migration; copy-tone
pass; semantic icon glossary. Done screen-by-screen in small PRs.

## Sequencing & conflict strategy

The repo is under **heavy parallel feature churn** (Devices.tsx/store.ts/types.ts edited constantly).
So favor **additive foundation work first** and stage screen-touching migrations:

1. **A** (foundation) — additive, low conflict. Unblocks B + D.
2. **B** (theme) + **C** (primitives) — largely additive (new files + token blocks); migrating existing
   overlays/headers is the only screen-touch, staged in small batches.
3. **D** + **E** — ride on the foundation.
4. **F** — the long tail; do opportunistically, ideally once feature velocity slows, to avoid rebase pain.

**Rule:** new-component/new-token PRs before big screen-by-screen sweeps. Keep migrations in small,
fast-merging batches so they don't sit and rot against churn.

## Rough effort
A ~2–3 days · B ~1 week · C ~1 week · D ~3–5 days · E folded in · F ongoing. ~3–4 weeks for a polished
result, but it ships incrementally — every track is independently deployable.

## Recommended start
**Track A**, then **B + C in parallel**. A is small, safe, and the substrate everything else needs;
B is the visible headline the owner asked for; C delivers the biggest consistency win and carries the
modal-focus-trap a11y fix for free.
