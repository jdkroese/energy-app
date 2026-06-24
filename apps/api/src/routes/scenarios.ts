import { config } from '../config';
import * as store from '../store';
import { applyActiveScenario } from '../control/coordinator';
import { takeSnapshot } from '../control/snapshot';

// Scenarios are now persisted in the store (definitions + active selection).

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function getScenarios(): unknown {
  const state = store.get();
  const active = state.activeScenario;
  return {
    ts: new Date().toISOString(),
    active,
    scenarios: Object.entries(state.scenarios).map(([id, def]) => ({
      id,
      name: def.name,
      icon: def.icon,
      active: id === active,
      weights: def.weights,
      reserve: def.reserve,
      dynReserve: def.dynReserve,
      gridCharge: def.gridCharge,
      exportRule: def.exportRule,
      ev: def.ev,
      precondition: def.precondition,
      activation: def.activation,
      trigger: def.trigger,
    })),
  };
}

export function applyScenario(id: string): unknown {
  const exists = store.get().scenarios[id];
  if (!exists) throw new Error(`scenario ${id} not found`);
  store.update((s) => {
    s.activeScenario = id;
  });

  // If control is armed, also push the newly-active scenario to the devices.
  // Best-effort + fully detached: each issue() logs its own outcome and never
  // throws, so this can never break the (read-only) scenario-selection response.
  const ctrl = store.get().control;
  if (ctrl.armed && ctrl.mode !== 'off') {
    void (async () => {
      try {
        const snap = await takeSnapshot();
        await applyActiveScenario(snap, `scenario->${id}`);
      } catch (e) {
        store.update((s) => {
          s.control.lastError = `apply-on-select failed: ${(e as Error).message}`;
        });
      }
    })();
  }

  return { ts: new Date().toISOString(), active: id };
}

/** Persist (create or replace) a scenario definition. Partial defs merge over existing. */
export function saveScenario(id: string, def: Partial<store.ScenarioDef>): unknown {
  const saved = store.update((s) => {
    const existing = s.scenarios[id] ?? store.DEFAULT_SCENARIOS.balanced;
    const merged: store.ScenarioDef = {
      name: def.name ?? existing.name,
      icon: def.icon ?? existing.icon,
      weights: { ...existing.weights, ...(def.weights ?? {}) },
      reserve: clamp(def.reserve ?? existing.reserve, 0, 100),
      dynReserve: def.dynReserve ?? existing.dynReserve,
      gridCharge: def.gridCharge ?? existing.gridCharge,
      exportRule: def.exportRule ?? existing.exportRule,
      ev: def.ev ?? existing.ev,
      precondition: def.precondition ?? existing.precondition,
      activation: def.activation ?? existing.activation,
      trigger: def.trigger ?? existing.trigger,
    };
    s.scenarios[id] = merged;
    return merged;
  });
  return { ts: new Date().toISOString(), id, def: saved };
}

export interface PreviewInput {
  weights?: Partial<store.ScenarioWeights>;
  reserve?: number;
  gridCharge?: boolean;
}

/**
 * Brain-twin projected impact for an arbitrary scenario weighting.
 * Heuristic model: maps weights/reserve/gridCharge to self-sufficiency, daily savings,
 * and backup autonomy. Not a full MPC — a monotonic, explainable estimate.
 */
export function previewScenario(input: PreviewInput): unknown {
  const w = {
    save: input.weights?.save ?? 0.4,
    self: input.weights?.self ?? 0.3,
    indep: input.weights?.indep ?? 0.2,
    comfort: input.weights?.comfort ?? 0.1,
  };
  const reserve = clamp(input.reserve ?? 20, 0, 100);
  const gridCharge = input.gridCharge ?? false;

  // Baseline figures for the site, then nudge by the levers.
  const baseSelf = 62; // %
  const baseSaved = 3.2; // €/day

  // Higher self/indep weight → more self-sufficiency. Grid-charge trades a little of it.
  let selfSufficiencyPct =
    baseSelf + (w.self - 0.3) * 40 + (w.indep - 0.2) * 20 - (gridCharge ? 4 : 0);
  // Higher save weight + grid-charge (cheap P3 charging) → more €. High reserve costs flexibility.
  let savedPerDayEur =
    baseSaved + (w.save - 0.4) * 3.5 + (gridCharge ? 0.7 : 0) - (reserve - 20) * 0.012;

  selfSufficiencyPct = Math.round(clamp(selfSufficiencyPct, 0, 100));
  savedPerDayEur = round(clamp(savedPerDayEur, 0, 10), 2);

  // Backup autonomy from the reserve floor on the combined battery tank.
  const tankKwh = config.assets.sonnenUsableKwh + config.assets.teslaUsableKwh;
  const backupHours = round((tankKwh * (reserve / 100)) / config.assets.criticalLoadKw, 1);

  return { selfSufficiencyPct, savedPerDayEur, backupHours };
}
