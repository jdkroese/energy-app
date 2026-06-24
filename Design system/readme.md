# Power — Design System

The design system for **Power**, a home Energy Management System (EMS) where solar,
battery, EV/device charging, statistics & reporting, and optimization all come together
in one interface. This repository is the source of truth ("the bible") for any design or
build work on the Power brand — for production code or throwaway prototypes alike.

> **Status:** v1, authored from scratch (greenfield brand). No external codebase, Figma,
> or prior brand assets were provided — the visual language below was established here.
> See **Caveats** at the bottom.

---

## 1. Product context

Power is a single app (desktop dashboard + phone app) for a home with rooftop solar, a
home battery, an EV charger, a heat pump, and a grid connection. The core jobs:

- **Monitor** — see, at a glance and in real time, where energy is coming from and going to.
- **Optimize** — let the system charge the battery, top up the car, and shift loads to the
  cheapest / greenest moments automatically.
- **Report** — understand production, consumption, savings, self-sufficiency and CO₂ over time.
- **Configure** — manage devices, automation rules, tariffs and battery strategy.

The signature concept is the **energy flow**: a live diagram where power animates between
Solar, Battery, Home and Grid. Everything else hangs off that mental model — and the color
system encodes it (green = solar, cyan = battery, amber = grid, lavender = home, violet = EV).

### Sources given
- None (no codebase / Figma / decks). Direction was gathered from the user: product name
  "Power", dark control-room aesthetic, electric-green solar accent, mono digital readouts,
  animated energy-flow charts, medium-rounded corners, mobile + desktop.

---

## 2. Content fundamentals (voice & copy)

- **Tone:** calm, precise, quietly confident. The app is an instrument panel, not a
  cheerleader. It states facts and lets the numbers carry the excitement.
- **Person:** address the user as **you** / **your home** ("Your home produced more than it
  used today"). The system refers to itself in the third person ("Optimizer estimates €41/mo").
- **Casing:** Sentence case for everything — headings, buttons, labels. UPPERCASE only for
  small eyebrow/overline labels (e.g. `LIVE FLOW`, `SOLAR TODAY`) with wide letter-spacing.
- **Numbers first:** lead with the value and unit (`4.21 kW`, `28.4 kWh`, `€6.85`, `74%`).
  Always pair a number with its unit, set in mono. Use real units: kW (power), kWh (energy),
  %, €, kg CO₂, °C, km (range).
- **Verbs for states:** Producing, Charging, Discharging, Importing, Exporting, Idle, Offline.
  Short, present-tense, one word where possible.
- **Brevity:** labels are 1–3 words. Descriptions (e.g. automation rules) are one plain
  sentence: "Charge the car between 02:00–05:00 when grid tariff is lowest."
- **No hype, no jargon dumps.** Avoid exclamation marks. Avoid "smart", "seamless",
  "revolutionary". Prefer "saves €41/mo" over "maximizes your energy potential".
- **Emoji:** none. The brand expresses energy through color, glow and motion — not emoji.
  Iconography is line icons (Lucide), never emoji or unicode glyphs.

**Examples**
- Eyebrow: `LIVE OVERVIEW` · Heading: `Your home, right now`
- Stat: label `SELF-SUFFICIENCY`, value `74%`, footnote `vs avg`
- Button: `Optimize now`, `Charge now`, `Apply strategy`, `Add device`
- Status: `Producing 4.2 kW`, `Charging · 78%`, `Inverter offline`

---

## 3. Visual foundations

### Aesthetic
Dark **control-room**: a near-black cool canvas, flat dark panels, hairline borders, and
**glow reserved for live / energy-carrying elements only**. The room is dark so the energy
glows. A light theme exists (`[data-theme="light"]`) for daytime wall panels but dark is canonical.

### Color
- **Energy palette (fixed hues, the soul of the brand):** Solar `#2EE6A0` (electric green,
  brand signature), Battery `#38D9F5` (cyan), Grid `#F5A524` (amber), Home `#C4A6FF`
  (lavender), EV `#8B8CFF` (violet). These hues are *semantic* — a given node is always its
  color, everywhere.
- **Accent:** solar green is the single brand accent (primary buttons, focus, active nav).
- **Neutrals:** canvas `#06090B` → panels `#0F1619` → `#141D21` → `#1B262B` → `#233136`.
  Text `#E9F5F2` / `#9BB0AD` / `#5F7672`.
- **Semantic reuses energy hues:** success = solar, warning = grid, danger `#FF5D5D`, info = battery.
- **Washes:** each energy hue has a ~12% alpha "wash" for soft tinted fills behind metrics/badges.

### Type
- **Space Grotesk** — all UI & display. Geometric, slightly technical; tight tracking
  (`-0.02em` display, `-0.01em` headings). Weights 400/500/600/700.
- **JetBrains Mono** — *every* numeral & data readout, with **tabular figures** so live
  values don't jitter as digits change. This mono/sans split is the core type signature.
- Scale: display 40 · h1 30 · h2 24 · h3 20 · h4 17 · body 15 · sm 13 · xs 11.
  Metrics: xl 56 (hero) · lg 36 (card) · md 24 (inline).

### Spacing & shape
- 4px base grid (`--space-1`=4 … `--space-16`=64). Control heights 30/38/46.
- Radii: sm 6 · md 10 · **card/lg 14** · xl 20 · pill. Medium-rounded shape language.

### Surfaces, borders & elevation
- **Cards:** flat `--surface-1` panel, 1px hairline border (`--border-1`), soft deep shadow
  (`--shadow-2`/`--shadow-card`) + a faint top inner-highlight (`--hairline-top`). Radius 14.
  Never heavy/black drop shadows. Optional **top accent rail** (2px, tinted to an energy node)
  and optional **glow** for the live/active panel.
- **Borders** carry structure (they're how panels read on dark), not color — color is for energy.

### Glow, transparency & blur
- **Glow** = "this is live / carrying power." Used on: the primary button, the active energy
  node, the flow lines, gauge arcs, live status dots. Never decorative on static chrome.
- **Glass blur** (`--blur-glass` 18px over `--glass-fill`) only for floating layers over
  content — the mobile tab bar, popovers, modals.

### Motion
- Easing: `--ease-out` (cubic-bezier(.2,.7,.2,1)) for most; `--ease-spring` for toggles.
- Durations: 120ms (hover/press) · 200ms (default) · 360ms (gauge/bar fills).
- Signature animations: **flowing dashes** along energy-flow lines, a **pulsing ring** on the
  hub and on live status dots, gauge arcs animating to value. All respect
  `prefers-reduced-motion: reduce`.
- **Hover:** surfaces lighten (`--surface-2/3`), borders strengthen, cards lift 2px.
  **Press:** scale down slightly (0.92–0.99). Primary button hover brightens + intensifies glow.

### Imagery
- The brand is **diagram- and data-led**, not photographic. No hero photos. "Imagery" =
  the energy-flow diagram, gauges, sparklines and charts. If photography is ever needed
  (e.g. a device thumbnail), keep it cool-toned and let the dark UI frame it.

---

## 4. Iconography

- **System:** [Lucide](https://lucide.dev) — thin (≈2px) line icons, rounded caps/joins.
  Matches the technical-but-friendly control-room feel. Loaded from CDN
  (`https://unpkg.com/lucide@0.453.0/...`) and rendered via `<i data-lucide="name"></i>`,
  then `lucide.createIcons()`. **Substitution flag:** there was no provided icon set, so
  Lucide is the chosen standard — swap if you adopt a different one.
- **Sizes:** 15px (compact/inline), 18px (default UI), 22px (nav/tab bar). Icons inherit
  `currentColor`; energy icons take their node's hue.
- **Energy node icons:** Solar `sun`, Battery `battery-charging`, Grid `utility-pole`,
  Home `house`, EV `plug-zap`, Hub `zap`.
- **No emoji, no unicode-glyph icons.** The only custom-drawn mark is the logo (`assets/logo-mark.svg`):
  a lightning bolt inside the same rounded chip used for energy nodes, in solar green.

---

## 5. Index / manifest

**Foundations**
- `styles.css` — the single entry point consumers link (imports only).
- `base.css` — resets + element defaults + `.pwr-mono` / `.pwr-eyebrow` helpers.
- `tokens/` — `colors.css`, `typography.css`, `spacing.css`, `effects.css`, `fonts.css`.
- `assets/logo-mark.svg` — the Power logomark.
- `guidelines/*.card.html` — foundation specimen cards (Colors, Type, Spacing, Effects, Brand).

**Components** (`window.PowerDesignSystem_138199`) — see each `*.prompt.md` for usage:
- `components/core/` — Button, IconButton, Card, Badge, StatusDot.
- `components/forms/` — Switch, SegmentedControl, Slider, Input, Select.
- `components/data/` — StatTile, RadialGauge, Sparkline, ProgressBar, **EnergyFlow** (signature).

**UI kits**
- `ui_kits/desktop/` — full desktop dashboard (Overview, Statistics, Devices, Optimization).
- `ui_kits/mobile/` — phone app (Home, Flow, Charge, Stats).

**Other**
- `SKILL.md` — Agent-Skill manifest for use in Claude Code.
- `_ds_bundle.js`, `_ds_manifest.json`, `_adherence.oxlintrc.json` — generated by the compiler; do not edit.

---

## 6. Caveats
- **Fonts load from Google Fonts CDN** (Space Grotesk + JetBrains Mono) — no self-hosted
  binaries are bundled, so the design system reports 0 packaged fonts and consumers need
  internet (or should self-host for offline/production). Provide woff2 files to bundle them.
- **Greenfield brand:** the logo, palette and type were created here, not derived from an
  existing brand. Treat them as a strong v1 starting point to refine, not a locked identity.
- **Lucide is a chosen standard,** not a provided asset set.
