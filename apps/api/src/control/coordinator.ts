// The coordinator loop. Runs every 90s but ACTS only when armed && mode==='auto'.
// Each tick: take a fresh snapshot, compute the desired device settings from the
// active scenario + tariff band + live flows, and issue() only the deltas. The
// whole tick is wrapped so it can never crash the process.
//
// On DISARM / mode->'off', revertToSafe() returns both batteries to safe vendor
// behaviour (Sonnen self-consumption, Tesla self_consumption) with no lingering
// manual setpoint.

import * as store from '../store';
import type { ControlDevice, TariffArbitrageParams, ArbitrageEvent, ArbitrageEventType } from '../store';
import { issue, _resetRateLimits } from './execute';
import { checkSonnenWatts } from './guardrails';
import { takeSnapshot, type RichSnapshot } from './snapshot';
import { planBatteryPriority, type PriorityPlan } from './battery-priority';
import * as trace from './decision-trace';
import { planArbitrage, arbitrageSpreadEur, type ArbitragePlan } from './arbitrage';
import { appendArbitrageEvent, accrueArbitrageCharge } from './arbitrage-log';
import { config } from '../config';
import * as weather from '../connectors/weather';
import { TZ, bandCodesForDay } from '../tariff';
import { effectivePR } from '../solar-model';
import { solarForecast, loadForecast } from '../routes/brain';

const TICK_MS = 90_000;
let timer: ReturnType<typeof setInterval> | null = null;

// Discharge-priority deadband (W). The Sonnen only force-discharges when the house
// residual (load − PV) clears this, and stands down when PV covers the load. Prevents
// meter-noise flapping around the zero-crossing and never lets it dump to grid.
export const DISCHARGE_DEADBAND_W = 300;

/**
 * Decide the discharge-priority target from the Sonnen's OWN meter (self-consistent
 * and, unlike the grid-meter + battery-flow reconstruction it replaced, NOT corrupted
 * by the Sonnen's own discharge). `residualW` = house load the PV isn't covering; the
 * Sonnen force-discharges at most that, so it can never push power to the grid, and it
 * STANDS DOWN entirely on a PV surplus (PV ≥ load). This kills the discharge↔soak-charge
 * runaway that dumped the battery to grid (the old `drawW` self-latched to 4.6 kW because
 * it counted the Sonnen's own discharge as "load").
 */
export function decideDischargeTarget(
  pvW: number,
  loadW: number,
  deadbandW = DISCHARGE_DEADBAND_W,
): { residualW: number; standDown: boolean } {
  const residualW = Math.max(0, loadW - pvW);
  // Stand down on a PV surplus (PV ≥ load − deadband) or a negligible residual.
  const standDown = pvW >= loadW - deadbandW || residualW <= deadbandW;
  return { residualW, standDown };
}

// ---- Tariff-arbitrage forecast cache ----------------------------------------
// The arbitrage decision needs a forecast-derived pre-peak SoC target. The forecast is a
// network fetch, so cache the computed ArbitragePlan and refresh it at most every 15 min.
// The cache is only ever populated when the rule is enabled+armed+auto (computeArbitragePlan
// is called lazily from coordinateArbitrage), so a disabled rule never even fetches weather.
const ARB_CACHE_TTL_MS = 15 * 60_000;
interface ArbForecast {
  /** 48h horizon solar forecast (kW/h), hours 0..47 = today 0..23 ++ tomorrow 0..23. */
  solarKw: number[];
  /** 48h horizon load forecast (kW/h). */
  loadKw: number[];
}
let arbCache: { at: number; plan: ArbitragePlan; fc: ArbForecast; targetParams: string } | null = null;
/** Last weather forecast the planner fetched — reused by liveForecastNow() for event capture
 *  (a diagnostic readout) so it never triggers its own network fetch. */
let arbWeatherCache: weather.WeatherForecast | null = null;

/**
 * Build the 48h forecast horizon (today ++ tomorrow). The Open-Meteo forecast we fetch only
 * covers the next 24h (one calendar day's hourly arrays), so the TOMORROW slice REPEATS today's
 * forecast shape (same hourly solar/load pattern). That's a deliberate, documented fallback: the
 * primary overnight case (P3 valley → tomorrow's 10:00 P1) only needs a plausible morning-peak
 * load/solar shape, and a same-shape repeat is the best zero-extra-fetch estimate we have.
 */
function buildArbForecast(wf: weather.WeatherForecast | null, prEff: number): ArbForecast {
  const solarToday = solarForecast(wf?.shortwaveRadiation ?? null, prEff);
  const loadToday = loadForecast(wf?.temperature ?? null);
  // Repeat today's shape for tomorrow (fallback — see doc above).
  return {
    solarKw: [...solarToday, ...solarToday],
    loadKw: [...loadToday, ...loadToday],
  };
}

/** 48h band codes: today's 24 ++ tomorrow's 24 (so an overnight valley can see tomorrow's peak). */
function bandCodes48(now: Date = new Date()): number[] {
  const tomorrow = new Date(now.getTime() + 24 * 3_600_000);
  return [...bandCodesForDay(now), ...bandCodesForDay(tomorrow)];
}

/** Compute (or reuse a cached) ArbitragePlan from the live forecast for the given params +
 *  current combined SoC. Best-effort: returns null if the forecast is unavailable. The
 *  returned `freshPlan` flag is true on a cache miss/recompute (so the caller can emit a
 *  `plan` event only when a genuinely new plan was built). The plan targets the NEXT peak
 *  at/after the current local hour over a 48h horizon, so overnight it targets tomorrow's
 *  morning peak. `fc` is the 48h forecast the plan used (for forecast-vs-actual deviation). */
async function computeArbitragePlan(
  params: TariffArbitrageParams,
  startSoc: number,
): Promise<{ plan: ArbitragePlan; freshPlan: boolean; fc: ArbForecast }> {
  const paramsKey = JSON.stringify(params);
  const now = Date.now();
  if (arbCache && now - arbCache.at < ARB_CACHE_TTL_MS && arbCache.targetParams === paramsKey) {
    return { plan: arbCache.plan, freshPlan: false, fc: arbCache.fc };
  }
  let wf: weather.WeatherForecast | null = null;
  try {
    wf = await weather.getForecast();
  } catch {
    wf = null;
  }
  arbWeatherCache = wf;
  const { prEff } = effectivePR();
  const fc = buildArbForecast(wf, prEff);
  const bandCodes = bandCodes48(new Date());
  const capKwh = config.assets.sonnenUsableKwh + config.assets.teslaUsableKwh;
  const maxKw = config.assets.sonnenMaxKw + config.assets.teslaMaxKw;
  // Target the NEXT peak relative to now (item 1): pass the current local hour as fromHour.
  const plan = planArbitrage(fc.solarKw, fc.loadKw, bandCodes, startSoc, capKwh, maxKw, params, currentLocalHour());
  arbCache = { at: now, plan, fc, targetParams: paramsKey };
  return { plan, freshPlan: true, fc };
}

/** Test/diagnostic helper — drop the arbitrage forecast cache. */
export function _resetArbitrageCache(): void {
  arbCache = null;
  arbWeatherCache = null;
}

/**
 * Is the tariff-arbitrage automation enabled AND in 'active' execution mode? Read the
 * same way coordinateArbitrageValleyCharge reads its params (a persisted rule missing
 * executionMode counts as 'advisory' — never active). This is the ONLY condition that
 * warrants handing the Tesla to its vendor optimizer ('autonomous'): the old
 * favoursArbitrage(scenario) heuristic pinned the Tesla to autonomous for ANY scenario
 * with gridCharge (max-savings / storm-ready), surrendering the discharge decision to
 * Tesla's own optimizer — which happily idled at 100% through P1/P2 while the house
 * imported expensive grid (observed 2026-07-02 evening: 3.7 kW P2 import, Tesla full).
 */
function tariffArbitrageActiveMode(): boolean {
  const automation = store
    .get()
    .automations.find((a) => a.type === 'tariff_arbitrage' && a.enabled);
  if (!automation || automation.type !== 'tariff_arbitrage') return false;
  return (automation.params as TariffArbitrageParams).executionMode === 'active';
}

/**
 * PURE Tesla-mode decision (unit-tested — coordinator-tesla-mode.test.ts):
 *  • 'autonomous'       ONLY while active-mode tariff arbitrage runs (the one rule that
 *                       genuinely wants the vendor optimizer's buy/hold freedom);
 *  • 'backup'           when the discharge-priority hold wants it in 'auto' authority
 *                       (Sonnen covers the house; the Tesla refuses to discharge and holds);
 *  • 'self_consumption' otherwise — the Tesla discharges for the house. Scenario weights /
 *                       gridCharge no longer select 'autonomous' (deliberate change; the
 *                       scenario's gridCharge still gates the P3 grid-charge enable below).
 */
export function decideTeslaMode(
  arbitrageActive: boolean,
  wantHold: boolean,
  holdAuthority: store.BatteryPriorityAuthority,
): { mode: 'autonomous' | 'backup' | 'self_consumption'; reason: string } {
  if (arbitrageActive) {
    return { mode: 'autonomous', reason: 'tariff-arbitrage active mode — vendor optimizer manages the Tesla' };
  }
  if (wantHold && holdAuthority === 'auto') {
    return { mode: 'backup', reason: 'discharge-priority hold (Tesla backup-only, Sonnen discharges first)' };
  }
  return { mode: 'self_consumption', reason: 'self-consumption — Tesla discharges for the house' };
}

/** Append a SHADOW decision to the control log (intended action, no write). */
function logShadow(device: ControlDevice, lever: string, reason: string, detail: string): void {
  store.update((s) => {
    s.control.log.push({ ts: Date.now(), device, lever, from: null, to: null, reason, ok: true, detail });
    s.control.log = store.pruneLog(s.control.log);
    s.control.updatedAt = Date.now();
  });
}

/**
 * Compute + issue the desired settings for the active scenario. Used by both the
 * auto coordinator tick and the manual "apply scenario" endpoint. Best-effort:
 * each issue() logs its own outcome and never throws.
 */
export async function applyActiveScenario(snap: RichSnapshot, reason: string): Promise<void> {
  const gr = store.get().control.guardrails;
  const scenario = snap.scenario;
  const band = snap.band;

  // Decision trace (Phase 0 visibility): open a per-tick record. Every trace.* call is
  // fail-soft (wrapped inside decision-trace.ts) so it can never break the tick.
  trace.beginDecision(snap, reason);

  // Battery-priority plan (Sonnen-first discharge / Tesla-first charge). It only
  // ever RAISES the Tesla reserve (to hold it) or idles the Sonnen — and only in
  // 'auto' authority; 'shadow' rules just log what they would have done.
  const baseReserve = Math.max(scenario.reserve, gr.teslaReserveMinPct);
  const plan = planBatteryPriority(snap, store.get().control.batteryPriority, baseReserve, gr.socFloorPct);

  // ---- Tesla (policy layer) ----
  // Discharge-priority HOLD intent: when the rule wants the Sonnen to discharge first
  // (and active-mode arbitrage isn't running), put the Tesla in `backup` mode so it
  // refuses to discharge for the house. The Sonnen load-following branch in
  // coordinateSonnen() then covers the whole house draw, so the Tesla idles and holds
  // its charge. The mode is re-issued EVERY tick, so it auto-reverts to self_consumption
  // the moment the hold releases (Sonnen depleted / throughput cap / surplus / offline).
  const dp = plan.discharge;
  const arbActive = tariffArbitrageActiveMode();
  const wantHold = dp.active && dp.holdTesla && !arbActive;

  const teslaDecision = decideTeslaMode(arbActive, wantHold, dp.authority);
  const teslaMode = teslaDecision.mode;
  trace.recordTesla(teslaMode, teslaDecision.reason);
  if (teslaMode !== 'backup') {
    // Why the discharge-priority hold did NOT put the Tesla in backup this tick.
    trace.recordStandDown(
      'discharge-priority',
      arbActive && dp.active && dp.holdTesla
        ? 'active-mode arbitrage runs — hold stands down'
        : dp.active && dp.holdTesla && dp.authority === 'shadow'
          ? `shadow: ${dp.reason}`
          : dp.reason,
    );
  }
  await issue('tesla', 'mode', teslaMode, `${reason}: ${teslaDecision.reason}`, snap);
  if (wantHold && dp.authority === 'shadow') {
    logShadow('tesla', 'mode', `discharge-priority (shadow): ${dp.reason}`, 'would set Tesla → backup (hold for Sonnen-first)');
  }

  // Tesla reserve: always the scenario floor. We no longer raise the reserve to hold the
  // Tesla (the Tesla often ignored that write and the cap was only 80%) — the `backup`
  // mode above + the Sonnen load-following primary mechanism do the holding now.
  await issue('tesla', 'reserve', baseReserve, `${reason}: scenario reserve floor`, snap);
  trace.recordTeslaReserve(baseReserve);

  const enableGridCharge = scenario.gridCharge && band === 'P3';
  await issue(
    'tesla',
    'gridExport',
    { enableGridCharge, exportRule: 'pv_only' },
    `${reason}: grid-charge=${enableGridCharge} (band ${band}), export pv_only`,
    snap,
  );

  // ---- Sonnen (fast valve) ----
  await coordinateSonnen(snap, reason, plan);

  // Seal the tick's decision record (persists the ring; emits an event ONLY on a
  // stance change). Fail-soft — commit can never throw into the tick.
  trace.commitDecision();
}

// ---- Force-charge-to-soak-export (hysteresis deadband) ----------------------
// When solar is exporting to the grid (worth ~nothing in Spain), force-charge the
// Sonnen to absorb the would-be-export BEFORE it spills to the grid. The Sonnen's
// own self-consumption firmware ('2') only offsets house load — it does NOT chase
// net grid export — so without this the surplus is wasted.
//
// A hysteresis deadband (startW high / stopW low) prevents flapping between manual
// ('1') and self-consumption ('2') when export hovers near the threshold. The rule's
// enable flag + thresholds are user-tunable in store.control.soakExport (defaults
// 400 / 150 / 98 — see store.defaultSoakExport()).

/**
 * Sonnen logic.
 *  • Stuck-at-100 bug: charging from the grid while full → force self-consumption.
 *  • Force-charge-to-soak-export (NEW): when there's net grid export, put the Sonnen
 *    in manual ('1') and force-charge at the would-be-export (clamped to 4600 W) so
 *    the surplus is absorbed instead of spilled to the grid. Re-evaluated every tick
 *    so the setpoint tracks live export. A hysteresis deadband + a hard revert to
 *    self-consumption guard against a surplus collapse leaving a stale manual charge
 *    importing from the grid. This SUPERSEDES the Tesla-first 0 W idle in the export
 *    case (owner's preference: never waste surplus to grid).
 *  • Charge-priority (Tesla-first): while there's surplus and the Tesla isn't full
 *    (within the throughput cap), IDLE the Sonnen in manual (0 W) so all surplus
 *    charges the Tesla first. 'shadow' just logs the intended idle.
 *  • Otherwise → self-consumption, which discharges to cover the house load.
 */
// ---- Tariff arbitrage (task #15) -------------------------------------------
// Combined battery SoC (%) across Sonnen + Tesla, energy-weighted (mirrors brain.ts).
function combinedSoc(snap: RichSnapshot): number | null {
  const sKwh = config.assets.sonnenUsableKwh;
  const tKwh = config.assets.teslaUsableKwh;
  if (snap.sonnen && snap.tesla) {
    return (snap.sonnen.soc * sKwh + snap.tesla.soc * tKwh) / (sKwh + tKwh);
  }
  return snap.tesla?.soc ?? snap.sonnen?.soc ?? null;
}

/** Current local hour (0..23) in the tariff timezone (Europe/Madrid). */
function currentLocalHour(d: Date = new Date()): number {
  return (
    Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d),
    ) % 24
  );
}

// ---- Arbitrage event logging -----------------------------------------------
// To keep the JSONL/ring volume sane, the chatty states (engage/revert/standdown) are only
// logged on a STATE TRANSITION (tracked in module scope). `plan` and `deviation` always log
// when they occur. Not a 90s heartbeat.
let lastArbActionState: ArbitrageEventType | null = null;

// ---- Deviation latch (item 4) ----------------------------------------------
// A forecast divergence triggers ONE re-plan + `deviation` event per crossing. After it fires,
// re-planning rebuilds the SAME forecast (re-planning can't make the forecast match live), so a
// naive check would re-fire every tick while the divergence persists. The latch suppresses
// repeats until the divergence CLEARS (live re-converges to forecast) or the local hour rolls
// over (a new forecast hour is a fresh comparison). Keyed on the hour the latch was set.
let deviationLatchHour: number | null = null;
/** Test/diagnostic helper — clear the deviation latch. */
export function _resetDeviationLatch(): void {
  deviationLatchHour = null;
}

/** The latest live solar/load forecast for the current hour (for deviation/event capture).
 *  Best-effort: 0/0 when the forecast isn't available. */
function liveForecastNow(): { solarKw: number; loadKw: number } {
  try {
    // Reuse whatever the cache already fetched (computeArbitragePlan populates it). We don't
    // force a network fetch here — this is a diagnostic readout only.
    const wf = arbWeatherCache;
    const { prEff } = effectivePR();
    const h = currentLocalHour();
    const solar = solarForecast(wf?.shortwaveRadiation ?? null, prEff)[h] ?? 0;
    const load = loadForecast(wf?.temperature ?? null)[h] ?? 0;
    return { solarKw: Math.round(solar * 100) / 100, loadKw: Math.round(load * 100) / 100 };
  } catch {
    return { solarKw: 0, loadKw: 0 };
  }
}

/**
 * Build + record one arbitrage event. `transitionGated` types (engage/revert/standdown) are
 * suppressed when the action-state hasn't changed since the last tick; `plan`/`deviation`
 * always record. Returns nothing — best-effort, never throws (the writer is wrapped).
 */
function emitArbEvent(
  type: ArbitrageEventType,
  snap: RichSnapshot,
  params: TariffArbitrageParams,
  plan: ArbitragePlan | null,
  soc: number | null,
  opts: {
    action?: { mode: string; chargeW: number } | null;
    chargedKwhTick?: number;
    deviation?: ArbitrageEvent['deviation'];
  } = {},
): void {
  // State-transition de-dup for the chatty action states.
  if (type === 'engage' || type === 'revert' || type === 'standdown') {
    if (lastArbActionState === type) return;
    lastArbActionState = type;
  }

  const spreadEur = arbitrageSpreadEur(params);
  const hour = currentLocalHour();
  const expectedSocFromPlan = plan && plan.socPct.length === 24 ? plan.socPct[hour] : null;
  const socDeviationPct =
    soc !== null && expectedSocFromPlan !== null ? Math.round((soc - expectedSocFromPlan) * 10) / 10 : null;
  const fc = liveForecastNow();
  const chargedKwhTick = opts.chargedKwhTick ?? 0;

  const ev: ArbitrageEvent = {
    ts: Date.now(),
    type,
    executionMode: params.executionMode,
    band: snap.band,
    spreadEur: Math.round(spreadEur * 10000) / 10000,
    plan: plan
      ? {
          active: plan.active,
          targetSocPct: plan.targetSocPct,
          valleyBuyKwh: plan.valleyBuyKwh,
          peakDeficitKwh: plan.peakDeficitKwh,
          reason: plan.reason,
        }
      : null,
    live: {
      combinedSoc: soc !== null ? Math.round(soc * 10) / 10 : null,
      sonnenSoc: snap.sonnen?.soc ?? null,
      teslaSoc: snap.tesla?.soc ?? null,
      solarKw: fc.solarKw,
      loadKw: fc.loadKw,
      gridExportKw: Math.round(snap.gridExportKw * 100) / 100,
      expectedSocFromPlan,
      socDeviationPct,
    },
    action: opts.action ?? null,
    deviation: opts.deviation ?? null,
    chargedKwhTick: Math.round(chargedKwhTick * 1000) / 1000,
    estSavedEurTick: Math.round(chargedKwhTick * spreadEur * 1000) / 1000,
  };
  appendArbitrageEvent(ev);
}

/**
 * Tariff-arbitrage VALLEY GRID-CHARGE execution. Returns true when it took authority over
 * the Sonnen this tick (so the caller stops). Acts ONLY when:
 *   • the rule is enabled + we're armed+auto,
 *   • the live band is the configured valley (P3) — NEVER P1/P2,
 *   • the spread ≥ minSpreadEur,
 *   • we are NOT exporting (surplusOverridesGridCharge: free solar / #34 soak-export wins),
 *   • the forecast pre-peak SoC target isn't met yet (live combined SoC < target).
 * It force-charges the Sonnen from grid at min(shortfall-rate, maxGridChargeKw, sonnenMaxW)
 * via manual mode + forceCharge. It mirrors #34's safety-revert: if we drift out of the
 * valley, the spread fails, the target is met, or surplus appears, it hands the Sonnen back
 * to self-consumption (priority write, can't be rate-limited) so a stale manual charge can
 * never keep importing. Returns false (no authority) so the caller falls through otherwise.
 *
 * The PEAK DISCHARGE half is NOT a separate command: self-consumption (the fallback below)
 * already discharges the battery to cover the house through the peak, and the SoC floor +
 * Tesla reserve guardrails enforce the discharge floor — so we compose with the existing
 * discharge logic rather than double-commanding.
 *
 * PRODUCTION ROLLOUT (advisory/shadow gate): every tick the rule is enabled+armed+auto it
 * computes its plan, runs deviation detection, and EMITS LOG EVENTS regardless of mode. It
 * only calls issue() (commands the battery) when params.executionMode === 'active'. In
 * 'advisory' it logs the intended action (what it WOULD charge + the modelled saving) and
 * returns FALSE (no authority), so self-consumption proceeds untouched and the battery is
 * never commanded. The revert path is likewise advisory-gated (advisory never issued a
 * charge, so there's nothing to revert — it just logs the stand-down).
 */
// One coordinator tick is 90s — the energy bought/would-buy this tick (kWh) at a given W.
const TICK_HOURS = TICK_MS / 3_600_000;

async function coordinateArbitrageValleyCharge(snap: RichSnapshot, reason: string): Promise<boolean> {
  const automation = store
    .get()
    .automations.find((a) => a.type === 'tariff_arbitrage' && a.enabled);
  // Disabled / absent → never act. (Type-narrow to the battery param shape.)
  if (!automation || automation.type !== 'tariff_arbitrage') {
    trace.recordStandDown('tariff-arbitrage', 'disabled');
    return false;
  }
  // Default any fields a pre-refinement persisted rule (PR #59) may lack, so the new gates read
  // sane values even before the rule is next saved (sanitize fills them on save). Defaults match
  // defaultTariffArbitrageParams(); a missing field never silently flips a gate on.
  const raw = automation.params as TariffArbitrageParams;
  const params: TariffArbitrageParams = {
    ...raw,
    solarConfidencePct: Number.isFinite(raw.solarConfidencePct) ? raw.solarConfidencePct : 70,
    prePeakSurplusGuardHours: Number.isFinite(raw.prePeakSurplusGuardHours) ? raw.prePeakSurplusGuardHours : 2,
    prePeakSurplusMarginPct: Number.isFinite(raw.prePeakSurplusMarginPct) ? raw.prePeakSurplusMarginPct : 30,
    deviationThresholdPct: Number.isFinite(raw.deviationThresholdPct) ? raw.deviationThresholdPct : 30,
    deviationMinKw: Number.isFinite(raw.deviationMinKw) ? raw.deviationMinKw : 0.8,
  };
  const advisory = params.executionMode !== 'active';

  const s = snap.sonnen;
  if (!s) {
    trace.recordStandDown('tariff-arbitrage', 'Sonnen offline');
    return false; // Sonnen offline — nothing to do
  }
  // In ADVISORY we never issued a charge, so the Sonnen is never "our" arbitrage manual; treat
  // it as not-ours so we neither revert (nothing to revert) nor claim authority.
  const inManual = !advisory && s.mode === 'manual';

  // Is the Sonnen currently OUR arbitrage charge? We only ever take over to grid-charge in
  // the valley; if it's in manual for another reason (#34 soak-export), that branch already
  // ran first and returned, so reaching here in manual means a prior arbitrage charge.
  const exportW = Math.max(0, snap.gridExportKw * 1000);
  const soak = store.get().control.soakExport;
  const exporting = exportW > soak.stopW;

  // Valley-band + spread gate. Outside the valley, or if the spread is too small, OR if
  // surplus appeared, REVERT any lingering arbitrage manual charge to self-consumption.
  const inValley = snap.band === params.valleyBand;
  const spreadOk = arbitrageSpreadEur(params) >= params.minSpreadEur;
  const surplusDefers = params.surplusOverridesGridCharge && exporting;

  // Pre-peak SoC target from the forecast (cached). Best-effort; if unavailable, do NOT
  // grid-charge (conservative: no forecast ⇒ no speculative buy). We compute the plan
  // whenever the headline gates pass so we can run deviation detection + emit a plan event.
  const soc = combinedSoc(snap);
  let plan: ArbitragePlan | null = null;
  let targetMet = true;
  let targetReason = 'no forecast — standing down (conservative)';
  // PRE-PEAK SURPLUS GUARD (item 3) — when tripped, do not engage this tick (no grid-buy).
  let prePeakSurplusStandDown = false;
  let prePeakSurplusWhy = '';
  if (inValley && spreadOk && !surplusDefers && soc !== null) {
    const res = await computeArbitragePlan(params, soc);
    plan = res.plan;
    if (res.freshPlan) emitArbEvent('plan', snap, params, plan, soc);

    // ---- Deviation detection + immediate re-plan (item 4) -------------------
    // Compare LIVE solar/load to the FORECAST values for the current hour (the same 48h arrays
    // the plan used). When either input diverges by ≥ max(deviationMinKw, threshold%·forecast),
    // the forecast that built the plan is stale: invalidate the cache, re-plan now, and emit a
    // `deviation` event capturing which input diverged + the forecast-vs-actual gap. The re-
    // planned target drives THIS tick. The floor (deviationMinKw) stops tiny forecasts tripping
    // on noise, and threshold% scales with the forecast — so under steady conditions it does NOT
    // fire every tick: only a genuine solar/load swing crosses it, and once re-planned the new
    // forecast tracks live, so it settles to a single re-plan per crossing.
    const hour = currentLocalHour();
    const fSolar = res.fc.solarKw[hour] ?? 0;
    const fLoad = res.fc.loadKw[hour] ?? 0;
    const liveSolar = (s.productionW ?? 0) / 1000;
    const liveLoad = (s.consumptionW ?? 0) / 1000;
    const solarTol = Math.max(params.deviationMinKw, (params.deviationThresholdPct / 100) * fSolar);
    const loadTol = Math.max(params.deviationMinKw, (params.deviationThresholdPct / 100) * fLoad);
    const solarDiverged = Math.abs(liveSolar - fSolar) >= solarTol;
    const loadDiverged = Math.abs(liveLoad - fLoad) >= loadTol;
    const diverged = solarDiverged || loadDiverged;
    if (!diverged) {
      // Live re-converged to forecast (or never diverged) → clear the latch so the NEXT genuine
      // crossing fires again.
      deviationLatchHour = null;
    } else if (deviationLatchHour !== hour) {
      // A genuine crossing we haven't acted on for this forecast hour → re-plan ONCE. The latch
      // (keyed on the hour) suppresses a per-tick storm while the divergence persists; it clears
      // when live re-converges (above) or the hour rolls over.
      deviationLatchHour = hour;
      _resetArbitrageCache();
      const re = await computeArbitragePlan(params, soc);
      plan = re.plan;
      const which = solarDiverged && loadDiverged ? 'solar+load' : solarDiverged ? 'solar' : 'load';
      emitArbEvent('deviation', snap, params, plan, soc, {
        deviation: {
          input: which,
          solarForecastKw: Math.round(fSolar * 100) / 100,
          solarLiveKw: Math.round(liveSolar * 100) / 100,
          loadForecastKw: Math.round(fLoad * 100) / 100,
          loadLiveKw: Math.round(liveLoad * 100) / 100,
        },
      });
    }

    if (plan.active) {
      targetMet = soc >= plan.targetSocPct;
      targetReason = `SoC ${Math.round(soc)}% ${targetMet ? '≥' : '<'} target ${Math.round(plan.targetSocPct)}%`;

      // PRE-PEAK SURPLUS GUARD (item 3): if the next P1 is imminent AND the house is already in
      // strong live solar surplus, don't grid-buy — even before we're net-exporting. Composes
      // with (and fires earlier than) the export-defer surplusOverridesGridCharge above.
      const liveSolarKw = (s.productionW ?? 0) / 1000;
      const liveLoadKw = (s.consumptionW ?? 0) / 1000;
      if (plan.nextPeakHour !== null) {
        const hoursToPeak = plan.nextPeakHour - currentLocalHour();
        const marginFactor = 1 + params.prePeakSurplusMarginPct / 100;
        if (
          hoursToPeak >= 0 &&
          hoursToPeak <= params.prePeakSurplusGuardHours &&
          liveLoadKw > 0 &&
          liveSolarKw >= marginFactor * liveLoadKw
        ) {
          prePeakSurplusStandDown = true;
          const overPct = Math.round((liveSolarKw / liveLoadKw - 1) * 100);
          prePeakSurplusWhy = `pre-peak surplus: solar ${overPct}% over load, ${params.peakBand} in ${hoursToPeak}h`;
        }
      }
    }
  }

  // Never grid-charge a (near-)full battery (mirrors the soak-export SoC ceiling).
  const nearFull = soc !== null && soc >= soak.socCeilingPct;
  const shouldCharge =
    inValley && spreadOk && !surplusDefers && soc !== null && !targetMet && !nearFull && !prePeakSurplusStandDown;

  if (!shouldCharge) {
    // The gating reason this tick is standing down.
    const why = !inValley
      ? `band ${snap.band} ≠ valley ${params.valleyBand}`
      : !spreadOk
        ? `spread < €${params.minSpreadEur.toFixed(2)}`
        : surplusDefers
          ? 'surplus present — defer to soak-export'
          : nearFull
            ? `SoC ${Math.round(soc ?? 0)}% ≥ ceiling`
            : prePeakSurplusStandDown
              ? prePeakSurplusWhy
              : targetReason;
    // REVERT a lingering arbitrage manual charge (safety): only reachable in ACTIVE mode
    // (advisory never took the Sonnen, so inManual is forced false above). Hand back to
    // self-consumption with a priority write so it can never be rate-limited, and log the
    // stand-down. (Not in manual ⇒ just fall through — no command.)
    if (inManual) {
      await issue('sonnen', 'mode', '2', `${reason}: end arbitrage grid-charge (${why}) — back to self-consumption`, snap, {
        priority: true,
      });
      emitArbEvent('revert', snap, params, plan, soc, { action: { mode: '2', chargeW: 0 } });
      trace.recordSonnen('arbitrage', 'revert → self-consumption', `end arbitrage grid-charge (${why})`);
      return true;
    }
    // Enabled but not charging — log the stand-down (state-transition gated). Advisory never
    // had authority; active simply isn't charging this tick. Either way no battery command.
    emitArbEvent('standdown', snap, params, plan, soc);
    trace.recordStandDown('tariff-arbitrage', why);
    return false;
  }

  // ENGAGE valley grid-charge. Per-tick rate = maxGridChargeKw, clamped to the sonnenMaxW
  // guardrail (the SoC-target check above stops us at target; near-full is gated above),
  // favouring a steady safe fill.
  const wantW = Math.min(params.maxGridChargeKw * 1000, store.get().control.guardrails.sonnenMaxW);
  const watt = checkSonnenWatts(wantW, 'charge', snap);
  const chargedKwhTick = (watt.value / 1000) * TICK_HOURS;
  const spreadEur = arbitrageSpreadEur(params);
  const now = Date.now();

  if (advisory) {
    // ADVISORY (shadow): log the intended engage (transition-gated) + accrue THIS tick's modelled
    // energy/saving every tick, but command NOTHING. Return false so self-consumption proceeds
    // untouched — the battery is never written.
    emitArbEvent('engage', snap, params, plan, soc, {
      action: null,
      chargedKwhTick,
    });
    accrueArbitrageCharge('advisory', chargedKwhTick, spreadEur, now);
    trace.recordStandDown('tariff-arbitrage', `advisory — would grid-charge ${watt.value}W (${targetReason})`);
    return false;
  }

  // ACTIVE: command the Sonnen. Mode FIRST (a charge setpoint is rejected unless the Sonnen
  // reports manual).
  await issue('sonnen', 'mode', '1', `${reason}: arbitrage valley grid-charge (${targetReason}, band ${snap.band})`, snap);
  await issue(
    'sonnen',
    'charge',
    watt.value,
    `${reason}: arbitrage grid-charge ${watt.value}W — pre-buy ${params.valleyBand} for ${params.peakBand} peak`,
    snap,
  );
  // Log the engage (transition-gated, one readable line per engagement) + accrue THIS tick's
  // realized energy/saving every tick, so a multi-hour charge accumulates over its full duration.
  emitArbEvent('engage', snap, params, plan, soc, {
    action: { mode: '1', chargeW: watt.value },
    chargedKwhTick,
  });
  accrueArbitrageCharge('active', chargedKwhTick, spreadEur, now);
  trace.recordSonnen('arbitrage', `manual charge ${watt.value}W`, `valley grid-charge (${targetReason}, band ${snap.band})`);
  return true;
}

async function coordinateSonnen(snap: RichSnapshot, reason: string, plan: PriorityPlan): Promise<void> {
  const s = snap.sonnen;
  if (!s) {
    trace.recordSonnen('offline', '—', 'Sonnen offline — nothing to command');
    return; // offline — nothing to do
  }

  // Core bug fix: battery charging from the grid while essentially full.
  if (s.gridFeedInW < -50 && s.soc >= 95 && s.dir === 'charging') {
    await issue('sonnen', 'mode', '2', `${reason}: stop grid-charging a full battery (SoC ${s.soc}%)`, snap);
    trace.recordSonnen('stuck-full-guard', 'self-consumption', `stop grid-charging a full battery (SoC ${s.soc}%)`);
    return;
  }

  // ---- Force-charge-to-soak-export ------------------------------------------
  // Only acts in armed+auto (the coordinator/tick is already self-gated on that,
  // and issue() refuses when !armed, so the manual "apply scenario" endpoint can
  // never leave the Sonnen in a stale manual charge either).
  const ctrl = store.get().control;
  const soak = ctrl.soakExport;
  if (ctrl.armed && ctrl.mode === 'auto') {
    const exportW = Math.max(0, snap.gridExportKw * 1000);
    const socPct = s.soc;
    const inManual = s.mode === 'manual'; // currently force-charging?
    const exporting = exportW > soak.stopW;

    // PRIORITY ORDER: free solar (soak-export, #34) > valley grid-charge (arbitrage, #37) >
    // battery-through-peak / Tesla-first / self-consumption (below).
    //
    // (A) FREE SOLAR — soak-export. When there's net export, the surplus is worth ~nothing in
    //     Spain, so absorb it. This OUTRANKS arbitrage grid-charge: while exporting we never
    //     grid-buy. Thresholds + the enable flag come from store.control.soakExport (tunable).
    if (exporting || (inManual && exportW > 0)) {
      if (!soak.enabled) {
        // DISABLED un-strand (safety-critical): the rule was turned off while it still had the
        // Sonnen force-charging (manual AND actively charging) → hand control back to
        // self-consumption immediately so a stale setpoint can't import from the grid (priority
        // bypasses the rate-limit). Gated on dir === 'charging' so it ignores the legitimate
        // charge-priority manual-0W idle below and never flaps with it; otherwise fall through.
        if (inManual && s.dir === 'charging') {
          await issue('sonnen', 'mode', '2', `${reason}: soak disabled — end force-charge, back to self-consumption`, snap, {
            priority: true,
          });
          trace.recordSonnen('soak-export', 'revert → self-consumption', 'soak disabled — end force-charge');
          return;
        }
        trace.recordStandDown('soak-export', 'disabled');
      } else {
        // REVERT (safety-critical): export collapsed OR battery (near-)full → hand control back
        // to self-consumption. A stale manual charge during a surplus collapse would IMPORT, so
        // this revert must always be able to fire (priority bypasses the rate-limit).
        if (inManual && (exportW <= soak.stopW || socPct >= soak.socCeilingPct)) {
          const why = socPct >= soak.socCeilingPct ? `SoC ${socPct}% ≥ ceiling` : `export ${Math.round(exportW)}W ≤ ${soak.stopW}W`;
          await issue('sonnen', 'mode', '2', `${reason}: end soak-export (${why}) — back to self-consumption`, snap, {
            priority: true,
          });
          trace.recordSonnen('soak-export', 'revert → self-consumption', `end soak-export (${why})`);
          return;
        }
        // ENGAGE / CONTINUE (hysteresis): headroom (SoC < ceiling) AND export over the threshold
        // (HIGH startW to engage; once charging, hold down to LOW stopW — the revert handles
        // < stopW). Issue the mode FIRST (the charge setpoint is rejected unless Sonnen reports
        // manual). checkSonnenWatts clamps to [0, sonnenMaxW=4600].
        const engageThreshold = inManual ? soak.stopW : soak.startW;
        if (exportW > engageThreshold && socPct < soak.socCeilingPct) {
          const watt = checkSonnenWatts(Math.min(exportW, store.get().control.guardrails.sonnenMaxW), 'charge', snap);
          await issue('sonnen', 'mode', '1', `${reason}: soak-export — absorb surplus before it spills to grid`, snap);
          await issue('sonnen', 'charge', watt.value, `${reason}: soak-export ${watt.value}W (export ${Math.round(exportW)}W, SoC ${socPct}%)`, snap);
          trace.recordSonnen('soak-export', `manual charge ${watt.value}W`, `absorb surplus before it spills (export ${Math.round(exportW)}W, SoC ${socPct}%)`);
          return;
        }
        // Below startW and not already charging (or at the ceiling): fall through.
        trace.recordStandDown('soak-export', `export ${Math.round(exportW)}W ≤ start ${engageThreshold}W or SoC ≥ ceiling`);
      }
    } else {
      // (B) VALLEY GRID-CHARGE — tariff arbitrage. Runs ONLY when NOT exporting (free solar
      //     above always wins). Pre-buys cheap valley grid up to the forecast pre-peak target,
      //     and reverts any lingering arbitrage manual charge to self-consumption when it
      //     should stop. Takes Sonnen authority (returns true) when it acts.
      if (await coordinateArbitrageValleyCharge(snap, reason)) return;
    }
  }

  const cp = plan.charge;
  if (cp.active && cp.holdSonnen) {
    if (cp.authority === 'auto') {
      // Manual mode + 0 W setpoint = Sonnen idle, so the Tesla absorbs the surplus.
      await issue('sonnen', 'mode', '1', `${reason}: charge-priority — ${cp.reason}`, snap);
      await issue('sonnen', 'charge', 0, `${reason}: charge-priority idle (Tesla charges first)`, snap);
      trace.recordSonnen('charge-priority', 'manual idle 0W', cp.reason);
      return;
    }
    logShadow('sonnen', 'mode', `charge-priority (shadow): ${cp.reason}`, 'would idle Sonnen (manual 0 W) so Tesla charges first');
    trace.recordStandDown('charge-priority', `shadow: ${cp.reason}`);
  } else {
    trace.recordStandDown('charge-priority', cp.reason);
  }

  // ---- Discharge-priority (Sonnen-first) load-following ----------------------
  // PRIMARY mechanism for "discharge the Sonnen before the Tesla". When the rule wants
  // to hold the Tesla and the house is drawing (deficit regime, no meaningful export),
  // force-discharge the Sonnen to cover the WHOLE non-PV house draw, re-tracked each tick.
  // The Sonnen then supplies everything, so the Tesla (in backup/self_consumption) sees
  // ~no residual demand and idles → it holds its charge. Needs ZERO Tesla cooperation.
  const dp = plan.discharge;
  // Deficit regime only. The target is the house residual (load − PV) from the Sonnen's
  // OWN meter — bounded, so the Sonnen covers real demand and NEVER pushes to grid — and
  // it stands down on a PV surplus (PV ≥ load) per decideDischargeTarget(). This replaced
  // the old self-referential `drawW = sonnenDischarge + teslaDischarge + gridImport`, which
  // counted the Sonnen's own discharge as load, latched to 4.6 kW, dumped to grid, and
  // flip-flopped with soak-export every tick.
  const notExporting = snap.gridExportKw <= 0.2;
  const pvW = s.productionW ?? 0;
  const loadW = s.consumptionW ?? 0;
  const { residualW, standDown } = decideDischargeTarget(pvW, loadW);
  if (dp.active && dp.holdTesla && notExporting && !standDown) {
    const targetW = checkSonnenWatts(
      Math.min(residualW, store.get().control.guardrails.sonnenMaxW),
      'discharge',
      snap,
    ).value;
    const meta = `load ${Math.round(loadW)}W − PV ${Math.round(pvW)}W`;
    if (dp.authority === 'auto') {
      if (targetW > 150) {
        // Sonnen covers the house residual; Tesla idles and holds. Clamped to the residual,
        // so it can't over-discharge into the grid.
        await issue('sonnen', 'mode', '1', `${reason}: discharge-priority — Sonnen covers house so Tesla holds`, snap);
        await issue('sonnen', 'discharge', targetW, `${reason}: discharge-priority ${targetW}W (${meta}) — Sonnen first`, snap);
        trace.recordSonnen('discharge-priority', `manual discharge ${targetW}W`, `covers the house residual (${meta}) — Sonnen first`);
        return;
      }
      // Negligible residual: don't force; fall through to self-consumption.
    } else {
      logShadow('sonnen', 'discharge', `discharge-priority (shadow): ${dp.reason}`, `would force-discharge Sonnen ~${targetW}W (${meta}) so Tesla idles`);
      // shadow → fall through to normal self-consumption (current behaviour) for comparison.
    }
  }

  // SAFETY REVERT: if we're NOT force-discharging this tick but the Sonnen is still in a
  // manual DISCHARGE we left behind (hold released / surplus appeared / draw gone), hand it
  // back to self-consumption with a PRIORITY write so a stale setpoint can't strand. Gated
  // on dir === 'discharging' so it never touches a manual CHARGE (soak-export / arbitrage,
  // which return early in the export/valley regime above).
  if (s.mode === 'manual' && s.dir === 'discharging') {
    await issue('sonnen', 'mode', '2', `${reason}: end discharge-priority — back to self-consumption`, snap, { priority: true });
    trace.recordSonnen('discharge-revert', 'revert → self-consumption', 'end discharge-priority — back to self-consumption');
    return;
  }

  // Keep Sonnen in self-consumption — it discharges to cover the house load.
  await issue('sonnen', 'mode', '2', `${reason}: self-consumption (cover the house)`, snap);
  trace.recordSonnen('self-consumption', 'self-consumption', 'cover the house load');
}

/**
 * REVERT-TO-SAFE — issued once on disarm / mode->'off'. Returns devices to safe
 * vendor behaviour. Runs even though armed may already be false, so it does its
 * writes directly through the connectors' safe modes via a temporary armed gate.
 *
 * Implementation note: issue() refuses when !armed, so revert briefly arms in
 * 'manual' to push the two safe mode-changes, then restores the off state.
 */
export async function revertToSafe(reasonLabel = 'revert-to-safe'): Promise<void> {
  try {
    const snap = await takeSnapshot();
    // Revert-to-safe is a SAFETY action: clear rate-limit memory so the safe-mode
    // writes can never be skipped as "too soon after the last write".
    _resetRateLimits();
    // Temporarily allow writes for the revert only (issue() refuses when !armed).
    store.update((st) => {
      st.control.armed = true;
      st.control.mode = 'manual';
    });
    try {
      await issue('sonnen', 'mode', '2', reasonLabel, snap);
      await issue('tesla', 'mode', 'self_consumption', reasonLabel, snap);
    } finally {
      // Always land DISARMED / 'off' after a revert, regardless of write outcomes.
      store.update((st) => {
        st.control.armed = false;
        st.control.mode = 'off';
        st.control.updatedAt = Date.now();
      });
    }
  } catch (e) {
    store.update((st) => {
      st.control.lastError = `revert-to-safe failed: ${(e as Error).message}`;
    });
  }
}

async function tick(): Promise<void> {
  try {
    const ctrl = store.get().control;
    if (!ctrl.armed || ctrl.mode !== 'auto') return; // self-gated: inert unless armed+auto

    const snap = await takeSnapshot();
    if (snap.ageMs > 120_000) {
      store.update((st) => {
        st.control.lastError = 'coordinator: live data stale — tick skipped';
      });
      return;
    }
    await applyActiveScenario(snap, 'auto');
  } catch (e) {
    // Never crash the process.
    store.update((st) => {
      st.control.lastError = `coordinator tick failed: ${(e as Error).message}`;
    });
    console.error('[control] coordinator tick failed:', (e as Error).message);
  }
}

export function startCoordinator(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  console.log(`[control] coordinator started (every ${TICK_MS / 1000}s, self-gated on armed+auto)`);
}

export function stopCoordinator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
