# Energy App — Status & Authority Roadmap (handoff)

> 2026-06-25. Read this first in a fresh session. It captures **where the system is**
> and — the priority — **how to safely give the brain more control authority** over time.
> Companion docs: `10-energy-brain-blueprint.md` (the brain design), `05-api-capability-matrix.md`
> (what each device allows), `04-deployment.md` (infra), `08/09` (design), `06-strategy-context.md`.

---

## 1. Where we are (all live)

**App:** `https://energy.hirobo.nl` — installable PWA, "Power" design system, secured behind login.
Screens: **Live, Reports, Batteries, Alerts, Settings, Scenarios, Autopilot.**

**Built + deployed (in order):**
1. **Monitoring & reporting MVP** — Live two-battery EnergyFlow, Reports (2.0TD cost by band,
   captured-vs-lost story), Alerts, Settings; mobile bottom-tab + desktop collapsing rail.
2. **Functionality made real** — JSON persistence (`/opt/energy/state.json`), editable WhatsApp,
   working/persisted toggles, scenario apply/save, **Web Push**, 60s alert loop, dynamic Live insight,
   upstream TTL cache to bound the pay-as-you-go Tesla API.
3. **Security** — email+password (bcrypt), sessions, **trusted devices**, **2FA (WhatsApp/email OTP)**,
   password reset, admin user-management. Every `/api/*` gated except `/api/health` + `/api/auth/*`.
4. **Email** — wired via **Resend** (shared with the Hirobo app) → 2FA-by-email + reset + email alerts deliver.
5. **Battery control** — write-connectors (Sonnen + Tesla), a **guardrail layer**, a **coordinator**,
   and the **Autopilot** control UI. **DEPLOYED BUT DISARMED** (see §3).

**Infra:** TransIP VPS `149.210.189.239` (systemd `energy-api`, nginx, Resend); **WireGuard VPN** to the
Spain home LAN (reaches Sonnen + Teslas); **GitHub CI/CD** (`github.com/jdkroese/energy-app`, deploy.yml).
Tesla **Fleet API** (cloud, EU) + Sonnen **local API** (over VPN). ⚠️ Possible **hosting migration to a
Mac mini + Cloudflare** is in flight in a parallel track — if it lands, update connector hosts + the
deploy hook signatures.

**Guardrails (always enforced, any mode):** SoC floor 10%, Tesla reserve ≥15%, grid-charge only in P3 +
when the active scenario opts in, never push grid import >14 kW, **read-back confirm** after every write,
60s per-lever rate-limit, **revert-to-safe** (both batteries → self-consumption) on disarm, and the app
**boots DISARMED on every restart** regardless of persisted state.

---

## 2. Safety + ops rules (don't relearn the hard way)

- **NEVER run the API locally** — it refreshes the shared Tesla token and rotates it, breaking the VPS.
  (Recover by writing a valid `{"teslaRefreshToken":"…"}` to `/opt/energy/state.json` + restart.)
- **Commit + push before deploying.** Parallel agents/forks share one VPS and clobber each other's
  builds. A global **`PreToolUse(Bash)` hook** (`~/.claude/hooks/pull-before-deploy.sh`) now blocks any
  deploy (ssh to the VPS / `systemctl restart energy-api` / `git push`) when local is behind
  `origin/main`. It catches *committed* drift only — so still **commit your work first**.
- **Control is admin-gated + arm-gated.** Operator override: edit `/opt/energy/state.json` over SSH
  (boots disarmed anyway). Lockout recovery for auth: same file, or regenerate a setup token.

---

## 3. Immediate next action — the supervised first command

Control is **deployed, disarmed**. The agreed next step (with the owner watching):
1. Open **Autopilot** → see live device state (currently Tesla reserve 20% / self-consumption /
   grid-charge allowed / pv-only; Sonnen mode 2).
2. **Arm in Manual**, set **Tesla backup reserve 20% → a chosen value**, watch it **read back** in the
   "what the boss did" log (proves the write→confirm path on real hardware).
3. Then flip to **Auto** and watch the coordinator's first tick.

---

## 4. ★ Empowering the system / delegating authority — the roadmap ★

The design intent is to hand the brain **graduated autonomy**, earning trust at each rung. Guardrails
stay the hard floor at every level; the kill switch is always one tap away.

### Authority ladder (move up only after observing the level below)
| Level | What the system may do | How to grant | Exit criteria to advance |
|---|---|---|---|
| **L0 Shadow** *(done)* | Plan + advise only, no writes | default | plan looks sane vs reality |
| **L1 Manual** | Owner-issued single commands write to devices | arm "Manual" | a few clean read-backs |
| **L2 Auto-conservative** *(built, not armed)* | Coordinator sets Tesla mode/reserve/grid-charge + keeps Sonnen self-consuming + stops grid-charging a full battery | arm "Auto" | days of a clean command log, "stuck-at-100%" fixed |
| **L3 Auto-active** | + Sonnen manual setpoint peak-shaving in P1; dynamic Tesla reserve; P3 grid-charge for dull-day arbitrage | relax guardrails (below) + scenario opt-ins | savings tracked, no surprises |
| **L4 Forecast/MPC** | Day-ahead optimization over weather + thermal + prices (the blueprint) | build the optimizer | beats rule-based in shadow-compare |
| **L5 Loads** | Schedule EV (2× i3), pool, water heater, **HVAC pre-conditioning** | add load connectors | loads land in solar/P3 under 14 kW |
| **L6 House modes** | Normal/Eco/**Critical** tiered load-shedding | install smart switches/relays | autonomy stretches backup hrs |
| **L7 V2X** | Bidirectional EV as another battery | capable car + charger | — |

### Concrete "give it more authority" work items (roughly in order)
1. **Arm L2 and watch** — the coordinator already fixes the two headline problems (Sonnen idling at 100%,
   dueling masters). Lowest-effort, highest-value. Just needs the supervised arm.
2. **Relax the Tesla-reserve guardrail to two-way** within the 15% floor (today it only *raises* reserve)
   so Auto can lower reserve for arbitrage scenarios. (`apps/api/src/control/guardrails.ts → checkTeslaReserve`.)
3. **Re-enable Sonnen setpoint peak-shaving** (the non-flapping version) for precise P1 shaving
   (`coordinator.ts → coordinateSonnen`). Keep it guardrailed.
4. **Dynamic Tesla reserve** driven by storm/outage-risk (weather) — resilience that breathes.
5. **Wire forecasts into decisions** — Open-Meteo solar + temperature already available (`weather.ts`);
   feed them to the coordinator, then graduate to the **MPC optimizer** (blueprint §4).
6. **Flexible loads** — EV charge windows + pool/water/HVAC scheduling; later appliance disaggregation.
7. **House modes + smart switches** — circuit tiers (Critical/Comfort/Discretionary) + the `setMode()`
   abstraction already designed; multiplies backup autonomy.

### Delegation controls worth adding to the UI (so authority is tunable, not all-or-nothing)
- An **autonomy level selector** (L1–L6) instead of just Off/Manual/Auto.
- **Approval thresholds** — auto-apply small changes, ask the owner for big ones (e.g. reserve swings
  beyond ±X%, or grid-charging spend over €Y).
- **Scheduled autonomy** — Auto during the day, Manual/observe overnight, until trust is high.
- **Budgets** — daily battery-throughput (cycle-life) and grid-charge € caps the coordinator must respect.
- **Per-scenario authority** — e.g. "Storm-ready" may raise reserve autonomously; "Max savings" may
  grid-charge in P3; a "Holiday" profile may run fully hands-off.

---

## 5. Open items / tech debt
- Coordinator is **rule-based** (MPC is the upgrade); Sonnen autonomous setpoints currently disabled.
- Tesla reserve guardrail is **one-way (raise only)** — relax to two-way within the floor.
- **WhatsApp *sending* is LIVE** (2026-06-25) via **CallMeBot** (`CALLMEBOT_KEY` in `/opt/energy/.env`)
  to `+31624277919` — verified end-to-end (login OTP / reset links deliver). Caveat: CallMeBot is a
  free, best-effort, **single-recipient** service; for robust multi-recipient alerting the upgrade is
  the **Meta Cloud API** (`WHATSAPP_TOKEN`+`WHATSAPP_PHONE_ID`, already supported in `notify.ts`).
  Email works via Resend; every OTP/reset link is also logged server-side as a fallback.
- Reports production bars + Brain "projected saved" figures want **tuning** against real history.
- VPS is small (1 GB) — watch memory if workloads grow; Mac-mini migration may supersede this.
- Two-fork coordination — the deploy hook helps, but keep work committed+pushed.

---

## 6. First moves for a fresh session
1. Skim this file + `10-energy-brain-blueprint.md`.
2. If continuing control: do the **supervised first command** (§3), then **arm L2** and watch the log.
3. Then pick the next authority rung from §4.
4. Always: **commit + push before deploying** (the hook enforces sync, not commits).
