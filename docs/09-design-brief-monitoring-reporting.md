# Design Brief — Monitoring & Reporting section

> For: **Claude design**, using the **Power design system** (`/Design system`, the
> `power-design` skill) — **strictly**. 2026-06-24.
> Scope: the **MVP, read-only** Monitoring & Reporting experience. No control UI yet.

---

## 0. Non-negotiable: adhere to the Power design system
Everything is built **only** from `/Design system`:
- Link `styles.css`; use the tokens — never invent colors, fonts, radii or shadows.
- **Color = meaning (fixed hues):** Solar `#2EE6A0` · Battery `#38D9F5` · Grid `#F5A524`
  · Home `#C4A6FF` · EV `#8B8CFF`. A node is always its colour.
- **Type:** Space Grotesk (UI) + **JetBrains Mono for every numeral** (tabular).
- **Aesthetic:** dark control-room; flat panels + hairline borders; **glow only on
  live / energy-carrying elements**. Sentence case; UPPERCASE only for small eyebrows.
- **Voice:** calm instrument panel, numbers-first, units always, verbs for states
  (Producing / Charging / Discharging / Importing / Exporting / Idle / Offline).
- **Components:** reuse `Card, StatTile, RadialGauge, Sparkline, ProgressBar, Badge,
  StatusDot, SegmentedControl`, and the signature **`EnergyFlow`**. Charts via the
  kit's `AreaChart` / `BarChart`. Lucide line icons only. No emoji.
- Start from the existing `ui_kits/desktop/OverviewScreen.jsx` and
  `StatisticsScreen.jsx` — this brief **adapts** them to our real site, it does not
  start from scratch. Deliver **desktop + mobile**, dark canonical (light theme works).

---

## 1. What's different from the generic kit (must be reflected)
Our real installation (Jávea, Spain) differs from the kit's mock home:
- **Two battery systems**, not one: **Sonnen** (sonnenBatterie 10, ~9.2 kWh usable /
  11 kWh nominal) + **Tesla** (2× Powerwall 3, **27 kWh**). Total ~36 kWh.
- **Two solar arrays**: Array A (24× Sungrow, ~11 kWp) + Array B (16× via Tesla PW3,
  ~7.2 kWp) — combined **~18.2 kWp**.
- **Backup = Tesla only.** The Sonnen does **not** back up the house. Any
  "backup ready" figure uses **Tesla kWh only** — never Sonnen.
- **Spanish 2.0TD tariff** with **three bands P1/P2/P3** (not generic cheap/normal/
  peak): P1 €0.2093 · P2 €0.1309 · P3 €0.0957 /kWh. **Export pays almost nothing**
  (€0.003–0.029/kWh).
- **All-electric house:** heat pump + underfloor heating, A/C; **2× BMW i3** EVs.
- **Single-phase, 14 kW** grid limit (power term ~€36/mo).
- Currency **€**, locale Europe/Madrid.

---

## 2. Screen A — Live (Monitoring)  [adapt OverviewScreen]
Purpose: "is everything OK, and what's my energy doing right now?" — at a glance.

**Hero — `EnergyFlow` (the signature, the thing the owner loves):**
- Must represent **two batteries and two solar arrays** without losing the clean
  hub-and-spoke read. Recommended approach (designer to resolve):
  - **Solar** node = combined production; the two arrays shown as a small split
    (A / B) in the node or a hover/legend.
  - **Battery** node = combined SoC/power, but rendered as **two stacked sub-nodes
    or a split node "Sonnen + Tesla"** so both are legible — each with its own SoC.
  - Keep Grid and Home as-is. Live direction + flowing-dash animation per DS rules.
- Live state label per node (Producing / Charging / Idle / Exporting…).

**Live readouts (right of hero):**
- `StatTile` Solar now (e.g. **11.1 kW**, tone solar, footnote peak today).
- `StatTile` Home load (e.g. **5.5 kW**, tone home).
- **Two battery gauges** (`RadialGauge`): Sonnen SoC + Tesla SoC, each labelled,
  with storage kWh + state ("Idle", "Charging 1.1 kW").
- A combined self-sufficiency `ProgressBar` (solar vs grid share).

**Tariff band (NEW, prominent):** a compact **P1/P2/P3 indicator** for the current
band with €/kWh, plus the next-band countdown (e.g. "P1 peak in 1h 12m"). Reuse the
24h tariff strip idea from the kit but as **three named bands**, grid amber for P1.

**Backup readiness tile (NEW):** Tesla-only kWh + estimated hours of autonomy, with
a clear "Tesla backup" label. Never include Sonnen here.

**KPI row (today):** Produced · Consumed · Self-sufficiency % · **Saved today €**
(StatTiles with sparklines, as the kit does).

**Day chart:** Production & consumption (kW) — `AreaChart`, solar + home series.

**States to design:** live · data-stale ("Updated 4 min ago") · a device offline
(StatusDot danger) · **grid outage / island mode** banner (house on Tesla backup).

---

## 3. Screen B — Reports (Reporting / History)  [adapt StatisticsScreen]
Purpose: understand production, self-consumption, **money**, and patterns over time.

**Range control:** `SegmentedControl` — Day · Week · Month · Year.

**KPI tiles (top row):** Produced · Consumed · **Self-sufficiency %** · **Saved €**
(and a secondary row or toggle for Exported kWh · Imported kWh · CO₂ avoided).

**Core charts:**
- **Production vs consumption** (`BarChart`, solar vs home) over the range.
- **Cost & savings by tariff band** (NEW, important): stacked/grouped bars or a
  breakdown showing **€ and kWh split across P1 / P2 / P3** (import cost where the
  money actually goes), plus the fixed power term as context.
- **Self-consumption vs export** (NEW, the key money story): show how much solar was
  **self-consumed vs exported**, and frame export honestly as **low-value** —
  e.g. "Exported 625 kWh → €13.72 back · would've been €131 if self-consumed."
  This "value captured vs lost" framing is the centrepiece insight of the app.
- **Battery SoC over time** (area/line) for both batteries.

**Consumption breakdown (by load), all-electric house:** list with `ProgressBar`
per category, tones per the palette — **Heat pump + underfloor** (grid/amber),
**A/C cooling** (battery/cyan), **EV charging (2× BMW i3)** (ev/violet), **Water
heating**, **Appliances**, **Lighting & other**. (Pre-disaggregation these may be
estimates — label as such; per-appliance detail comes in a later phase.)

**States:** empty/no-data for a range · partial data · loading (skeleton).

---

## 4. Specific design problems to solve (call these out)
1. **Two batteries inside one `EnergyFlow`** without clutter — the most important
   visual problem. Propose 1–2 options (split battery node vs. two sub-nodes).
2. **Tariff band visualization** — a clear, glanceable P1/P2/P3 system used on both
   screens (live band + historical cost split). Amber = P1 peak.
3. **The export-value story** — make "self-consumed €€ vs exported pennies" instantly
   legible (this is *why* the app exists).
4. **Backup readiness** — unambiguously "Tesla only".

---

## 5. Out of scope (do NOT design here)
- Any **control** affordances (mode/reserve/charge buttons), Optimization rules,
  Devices configuration, Scenarios — these are later phases. If a control entry point
  must appear, show it disabled / "coming soon", not functional.
- No new colours, fonts, icon sets, or components beyond the Power system.

---

## 6. Deliverables
- **Screen A (Live)** and **Screen B (Reports)** — **desktop + mobile**, dark theme.
- All states listed above. Built from Power DS components; static HTML artifacts to
  view (per the skill), real values from the Data appendix (no lorem).
- Note any new small component you had to add (e.g. a "TariffBand" or "BackupTile")
  so it can be folded back into the design system.

---

## 7. Data appendix (use these real values — no placeholders)
**Live now (sample, 2026-06-24 16:48):** solar 11.1 kW · home 5.5 kW · grid exporting
5.56 kW · Sonnen 100% (9.2 kWh) idle · Tesla 100% (27 kWh) idle · band P2 (€0.131).
**Tariff 2.0TD:** P1 €0.2093 (Mon–Fri 10–14 & 18–22) · P2 €0.1309 · P3 €0.0957
(nights + weekends). Export €0.0038–0.0289/kWh. Power term ~€36.19/mo (14 kW).
**A real month (30 Apr–31 May):** consumed 444 kWh (P1 35 / P2 77 / P3 332) = €48.10;
exported 625 kWh → €13.72 credit. Self-sufficiency target metric ~70%+.
**Systems:** Sonnen 11 kWh (4.6 kW) · Tesla 2× PW3 27 kWh · Solar 18.2 kWp (2 arrays)
· EV 2× BMW i3 · heat pump + A/C · single-phase 14 kW.
**Available API fields** (for realistic readouts): solar kW, home load kW, grid ±kW,
per-battery SoC% + kWh + charge/discharge W, self-sufficiency, € cost/savings,
historical kWh by source (Tesla `calendar_history` + logged Sonnen series).
