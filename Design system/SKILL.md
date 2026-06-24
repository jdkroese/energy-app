---
name: power-design
description: Use this skill to generate well-branded interfaces and assets for Power, the home Energy Management System (solar, battery, charging, statistics, optimization) — either for production or throwaway prototypes/mocks. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the `readme.md` file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and
create static HTML files for the user to view. If working on production code, you can copy
assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build
or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_
production code, depending on the need.

## Quick orientation
- **Brand:** Power — home energy management. Dark control-room aesthetic; electric-green
  solar accent; mono digital readouts; animated solar→battery→home→grid energy flow.
- **Tokens & global CSS:** `styles.css` (entry, imports only) → `tokens/*.css` + `base.css`.
  Link `styles.css` and you get every CSS custom property + the font stack.
- **Color = meaning:** Solar `#2EE6A0` (green, brand accent), Battery `#38D9F5`, Grid `#F5A524`,
  Home `#C4A6FF`, EV `#8B8CFF`. Reuse these hues; don't invent new ones.
- **Type:** Space Grotesk (UI) + JetBrains Mono (all numerals, tabular). Sentence case;
  UPPERCASE only for small eyebrow labels. No emoji.
- **Icons:** Lucide (thin line), via CDN + `<i data-lucide="name">` then `lucide.createIcons()`.
- **Logo:** `assets/logo-mark.svg`.

## Components
Reusable React primitives compile into a bundle exposed as `window.PowerDesignSystem_138199`.
In an HTML file: link `styles.css`, load React 18 + Babel + Lucide + `_ds_bundle.js`, then
`const { Card, StatTile, EnergyFlow, ... } = window.PowerDesignSystem_138199`.
Groups: core (Button, IconButton, Card, Badge, StatusDot), forms (Switch, SegmentedControl,
Slider, Input, Select), data (StatTile, RadialGauge, Sparkline, ProgressBar, EnergyFlow).
Each component has a `.prompt.md` with a usage snippet.

## UI kits (full screens to copy from)
- `ui_kits/desktop/` — dashboard: Overview, Statistics, Devices, Optimization.
- `ui_kits/mobile/` — phone app: Home, Flow, Charge, Stats.

## Building a throwaway artifact
1. Copy `styles.css`, `tokens/`, `base.css`, and `assets/logo-mark.svg` next to your HTML
   (keep relative paths intact), or self-host the bundle.
2. Recreate components inline OR load the bundle if available.
3. Follow the voice + visual rules in `readme.md`. Lead with numbers; glow = live; dark canvas.
