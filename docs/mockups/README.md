# Power — MVP design mockups (monitoring & reporting)

High-fidelity, **working** mockups built strictly on the Power design system
(`/Design system`, runtime copied to `_ds/`), with real data from this house.
They are React apps (load the DS bundle), so **serve them** — they don't render in
the static preview panel:

```
python -m http.server 8777     # from repo root
# then open http://localhost:8777/docs/mockups/<file>
```

## Screens
| File | Screen | Notes |
|---|---|---|
| `live-mobile.html` | Live (monitoring) — **mobile** | today totals, two-battery EnergyFlow, tariff, Tesla-only backup, bottom tab bar |
| `reports-mobile.html` | Reports — **mobile** | range, captured-vs-lost story, cost by 2.0TD band, prod vs cons, load breakdown |
| `alerts-mobile.html` | Alerts — **mobile** | severity feed (Tesla dropout), WhatsApp + Push channels, rules |
| `settings-mobile.html` | Settings — **mobile** | connections health, 2.0TD tariff, my system, app/install |
| `desktop.html` | Live + Reports — **desktop** | **collapsing icon-rail** (toggle bottom-left), switch screens via the rail |
| `live.html` | Live — desktop (standalone) | earlier desktop-only Live; `desktop.html` supersedes |
| `dashboard.html` | first concept sketch | pre-design-system; superseded |

## Design language (must hold in the build)
Dark control-room · color = meaning (solar `#2EE6A0`, battery `#38D9F5`, grid
`#F5A524`, home `#C4A6FF`, EV `#8B8CFF`) · Space Grotesk UI + JetBrains Mono for
all numerals · glow only on live elements · sentence case · Lucide icons · bottom
tab bar on mobile, collapsing rail on desktop. Brief: `../09-design-brief-monitoring-reporting.md`.

## For the build (`apps/web`, React 19 + Vite + Tailwind 4)
- Implement these screens with Tailwind tokens mirroring the DS variables (don't
  ship the React-18 + Babel mockup runtime).
- The signature **two-battery EnergyFlow** is custom (the DS `EnergyFlow` is a
  fixed 4-node hub) — port the `pwr2` flow from these files.
- Drop in the **PWA kit** (`../pwa-kit/`) for iPhone installability.
