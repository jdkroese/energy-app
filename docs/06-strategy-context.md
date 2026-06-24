# Strategy Context & Constraints (drives scenarios + optimization)

> Added 2026-06-24 from owner input. Read alongside
> `05-api-capability-matrix.md` and the tariff in `00-project-brief.md` §4.

## 1. Backup / resilience — **Tesla only**
- ⚠️ The **Sonnen does NOT provide grid-outage backup.** It needs a separate
  backup module (not installed). During a power cut, only the **2× Tesla
  Powerwall 3 + Backup Gateway 2 (whole-home)** keep the house running.
- **Implications for control:**
  - Outage resilience = a function of **Tesla `backup_reserve_percent` only**.
    Holding the Sonnen full does nothing for resilience (and wastes a cycle).
  - In "storm/backup" scenarios: raise **Tesla** reserve; let **Sonnen** keep
    cycling for self-consumption/arbitrage (it has no resilience value anyway).
  - The app must never count Sonnen kWh toward "backup available" figures.

## 2. Weather-driven — Jávea (fully electric house)
Weather affects **both supply and demand**, so the optimizer needs a Jávea
forecast feed:
- **Solar supply forecast:** irradiance / cloud cover → predicted PV yield per
  hour (sizes how much battery headroom to keep for the day, and whether to
  grid-charge cheap P3 overnight when tomorrow will be dull).
- **Thermal demand forecast (house is all-electric):**
  - **Heat pump + underfloor heating** → cold days = large heating load.
  - **A/C (airco)** → hot days (**> ~30 °C**) = large cooling load.
  - ⇒ Pre-heat / pre-cool during cheap (P3) or high-solar windows so the battery
    isn't drained during the P1 evening peak; anticipate demand spikes.
- Underfloor heating has **thermal inertia** → ideal for load-shifting
  (pre-heat the slab in cheap hours, coast through peak).

## 3. Appliance / load intelligence
Owner wants tools to **identify specific appliance usage and consumption
patterns** (currently no per-appliance visibility):
- **Disaggregation (NILM)** from whole-home power signal, and/or
- **Per-circuit / smart-plug metering** for the big movable loads.
- Goals: see what's running, learn daily/weekly patterns, and **schedule
  flexible loads** (2× BMW i3 charging, pool pump, water heating, dishwasher/
  laundry, HVAC pre-conditioning) into solar / P3 windows — while staying under
  the **14 kW** grid limit (power-term cap).

## 4. Net effect on scenarios
Scenario profiles (the "configurable scenarios" requirement) must each set, per
situation, a coherent combination of:
- Tesla: mode + **backup reserve (resilience knob)** + grid-charge + export rule + tariff
- Sonnen: mode + setpoints + reserve + forecast-charging
- Flexible-load schedule (EV/pool/HVAC) bounded by 14 kW
…informed by **tariff band (P1/P2/P3), solar forecast, and thermal forecast**.

Example scenario seeds:
- **Summer self-consumption** — reserves low, hold headroom for midday solar,
  pre-cool before P1, batteries carry the evening peak.
- **Storm / outage-risk** — Tesla reserve high (resilience), Sonnen keeps working.
- **Cold snap** — pre-heat slab in P3/solar, protect SoC for evening heating.
- **Dull-day arbitrage** — grid-charge in P3 overnight, discharge through P1.
- **Cheap-night EV** — schedule both i3s in P3, throttle to stay < 14 kW.
