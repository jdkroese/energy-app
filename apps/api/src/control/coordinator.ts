// The coordinator loop. Runs every 90s but ACTS only when armed && mode==='auto'.
// Each tick: take a fresh snapshot, compute the desired device settings from the
// active scenario + tariff band + live flows, and issue() only the deltas. The
// whole tick is wrapped so it can never crash the process.
//
// On DISARM / mode->'off', revertToSafe() returns both batteries to safe vendor
// behaviour (Sonnen self-consumption, Tesla self_consumption) with no lingering
// manual setpoint.

import * as store from '../store';
import type { ControlDevice } from '../store';
import { issue, _resetRateLimits } from './execute';
import { checkSonnenWatts } from './guardrails';
import { takeSnapshot, type RichSnapshot } from './snapshot';
import { planBatteryPriority, type PriorityPlan } from './battery-priority';

const TICK_MS = 90_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Does this scenario lean toward savings/arbitrage (→ Tesla 'autonomous')? */
function favoursArbitrage(scenario: store.ScenarioDef): boolean {
  const w = scenario.weights;
  return w.save >= 0.5 || scenario.gridCharge;
}

/** Append a SHADOW decision to the control log (intended action, no write). */
function logShadow(device: ControlDevice, lever: string, reason: string, detail: string): void {
  store.update((s) => {
    s.control.log.push({ ts: Date.now(), device, lever, from: null, to: null, reason, ok: true, detail });
    if (s.control.log.length > 100) s.control.log = s.control.log.slice(-100);
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

  // Battery-priority plan (Sonnen-first discharge / Tesla-first charge). It only
  // ever RAISES the Tesla reserve (to hold it) or idles the Sonnen — and only in
  // 'auto' authority; 'shadow' rules just log what they would have done.
  const baseReserve = Math.max(scenario.reserve, gr.teslaReserveMinPct);
  const plan = planBatteryPriority(snap, store.get().control.batteryPriority, baseReserve, gr.socFloorPct);

  // ---- Tesla (policy layer) ----
  const teslaMode = favoursArbitrage(scenario) ? 'autonomous' : 'self_consumption';
  await issue('tesla', 'mode', teslaMode, `${reason}: scenario favours ${teslaMode}`, snap);

  // Discharge-priority may HOLD the Tesla by raising its reserve to its SoC so the
  // Sonnen discharges first. In shadow we log the intended hold but issue the base.
  let teslaReserve = baseReserve;
  let reserveReason = `${reason}: scenario reserve floor`;
  const dp = plan.discharge;
  if (dp.active && dp.holdTesla && dp.reserveHoldPct !== null) {
    if (dp.authority === 'auto') {
      teslaReserve = dp.reserveHoldPct;
      reserveReason = `${reason}: discharge-priority — ${dp.reason}`;
    } else {
      logShadow('tesla', 'reserve', `discharge-priority (shadow): ${dp.reason}`, `would hold reserve at ${dp.reserveHoldPct}% (issuing base ${baseReserve}%)`);
    }
  }
  await issue('tesla', 'reserve', teslaReserve, reserveReason, snap);

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
}

// ---- Force-charge-to-soak-export thresholds (hysteresis deadband) -----------
// When solar is exporting to the grid (worth ~nothing in Spain), force-charge the
// Sonnen to absorb the would-be-export BEFORE it spills to the grid. The Sonnen's
// own self-consumption firmware ('2') only offsets house load — it does NOT chase
// net grid export — so without this the surplus is wasted.
//
// A hysteresis deadband (START_W high / STOP_W low) prevents flapping between
// manual ('1') and self-consumption ('2') when export hovers near the threshold.
const FC_START_W = 400; // engage/continue force-charge once export exceeds this
const FC_STOP_W = 150; // revert to self-consumption once export drops below this
const FC_SOC_CEILING = 98; // don't force-charge an (almost) full battery

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
async function coordinateSonnen(snap: RichSnapshot, reason: string, plan: PriorityPlan): Promise<void> {
  const s = snap.sonnen;
  if (!s) return; // offline — nothing to do

  // Core bug fix: battery charging from the grid while essentially full.
  if (s.gridFeedInW < -50 && s.soc >= 95 && s.dir === 'charging') {
    await issue('sonnen', 'mode', '2', `${reason}: stop grid-charging a full battery (SoC ${s.soc}%)`, snap);
    return;
  }

  // ---- Force-charge-to-soak-export ------------------------------------------
  // Only acts in armed+auto (the coordinator/tick is already self-gated on that,
  // and issue() refuses when !armed, so the manual "apply scenario" endpoint can
  // never leave the Sonnen in a stale manual charge either).
  const ctrl = store.get().control;
  if (ctrl.armed && ctrl.mode === 'auto') {
    const exportW = Math.max(0, snap.gridExportKw * 1000);
    const socPct = s.soc;
    const inManual = s.mode === 'manual'; // currently force-charging?

    // REVERT (safety-critical): export collapsed OR battery (near-)full → hand
    // control back to self-consumption firmware. Manual mode disables firmware
    // self-consumption, so a stale manual charge during a cloud-driven surplus
    // collapse would IMPORT from the grid — the revert must always be able to fire,
    // so it bypasses the per-lever rate-limit (priority).
    if (inManual && (exportW <= FC_STOP_W || socPct >= FC_SOC_CEILING)) {
      const why = socPct >= FC_SOC_CEILING ? `SoC ${socPct}% ≥ ceiling` : `export ${Math.round(exportW)}W ≤ ${FC_STOP_W}W`;
      await issue('sonnen', 'mode', '2', `${reason}: end soak-export (${why}) — back to self-consumption`, snap, {
        priority: true,
      });
      return;
    }

    // ENGAGE / CONTINUE (hysteresis): battery has headroom (SoC < ceiling) AND
    //   • not yet charging → engage only once export clears the HIGH threshold; or
    //   • already charging → keep charging until export drops below the LOW one
    //     (the revert above handles the < FC_STOP_W case), tracking live export.
    // So within the deadband we hold whatever state we're in — no flapping.
    // Issue the mode FIRST (the charge setpoint is rejected unless the Sonnen
    // reports manual). checkSonnenWatts clamps to [0, sonnenMaxW=4600].
    const engageThreshold = inManual ? FC_STOP_W : FC_START_W;
    if (exportW > engageThreshold && socPct < FC_SOC_CEILING) {
      const watt = checkSonnenWatts(Math.min(exportW, store.get().control.guardrails.sonnenMaxW), 'charge', snap);
      await issue('sonnen', 'mode', '1', `${reason}: soak-export — absorb surplus before it spills to grid`, snap);
      await issue('sonnen', 'charge', watt.value, `${reason}: soak-export ${watt.value}W (export ${Math.round(exportW)}W, SoC ${socPct}%)`, snap);
      return;
    }
    // Below FC_START_W and NOT already charging (or at the ceiling): fall through
    // to the existing self-consumption / Tesla-first idle logic below.
  }

  const cp = plan.charge;
  if (cp.active && cp.holdSonnen) {
    if (cp.authority === 'auto') {
      // Manual mode + 0 W setpoint = Sonnen idle, so the Tesla absorbs the surplus.
      await issue('sonnen', 'mode', '1', `${reason}: charge-priority — ${cp.reason}`, snap);
      await issue('sonnen', 'charge', 0, `${reason}: charge-priority idle (Tesla charges first)`, snap);
      return;
    }
    logShadow('sonnen', 'mode', `charge-priority (shadow): ${cp.reason}`, 'would idle Sonnen (manual 0 W) so Tesla charges first');
  }

  // Keep Sonnen in self-consumption — it discharges to cover the house load.
  await issue('sonnen', 'mode', '2', `${reason}: self-consumption (cover the house)`, snap);
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
