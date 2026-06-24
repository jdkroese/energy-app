// The coordinator loop. Runs every 90s but ACTS only when armed && mode==='auto'.
// Each tick: take a fresh snapshot, compute the desired device settings from the
// active scenario + tariff band + live flows, and issue() only the deltas. The
// whole tick is wrapped so it can never crash the process.
//
// On DISARM / mode->'off', revertToSafe() returns both batteries to safe vendor
// behaviour (Sonnen self-consumption, Tesla self_consumption) with no lingering
// manual setpoint.

import * as store from '../store';
import { issue, _resetRateLimits } from './execute';
import { takeSnapshot, type RichSnapshot } from './snapshot';

const TICK_MS = 90_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Does this scenario lean toward savings/arbitrage (→ Tesla 'autonomous')? */
function favoursArbitrage(scenario: store.ScenarioDef): boolean {
  const w = scenario.weights;
  return w.save >= 0.5 || scenario.gridCharge;
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

  // ---- Tesla (policy layer) ----
  const teslaMode = favoursArbitrage(scenario) ? 'autonomous' : 'self_consumption';
  await issue('tesla', 'mode', teslaMode, `${reason}: scenario favours ${teslaMode}`, snap);

  const teslaReserve = Math.max(scenario.reserve, gr.teslaReserveMinPct);
  await issue('tesla', 'reserve', teslaReserve, `${reason}: scenario reserve floor`, snap);

  const enableGridCharge = scenario.gridCharge && band === 'P3';
  await issue(
    'tesla',
    'gridExport',
    { enableGridCharge, exportRule: 'pv_only' },
    `${reason}: grid-charge=${enableGridCharge} (band ${band}), export pv_only`,
    snap,
  );

  // ---- Sonnen (fast valve) ----
  await coordinateSonnen(snap, reason);
}

/**
 * Sonnen logic — CONSERVATIVE first-version: mode changes only, no autonomous
 * manual setpoints (those are available via manual UI control + a later refinement).
 *  • Stuck-at-100 bug: charging from the grid while full → force self-consumption.
 *  • Otherwise → self-consumption, which discharges to power the house (the actual
 *    fix for "Sonnen stuck at 100%"). Stable, non-flapping, fully guardrailed.
 */
async function coordinateSonnen(snap: RichSnapshot, reason: string): Promise<void> {
  const s = snap.sonnen;
  if (!s) return; // offline — nothing to do

  // Core bug fix: battery charging from the grid while essentially full.
  if (s.gridFeedInW < -50 && s.soc >= 95 && s.dir === 'charging') {
    await issue('sonnen', 'mode', '2', `${reason}: stop grid-charging a full battery (SoC ${s.soc}%)`, snap);
    return;
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
