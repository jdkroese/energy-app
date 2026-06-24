import { config } from '../config';

// In-memory scenario store (resets on restart — fine for MVP).

interface Scenario {
  id: string;
  name: string;
  icon: string;
  active: boolean;
  weights: { save: number; self: number; indep: number; comfort: number };
  reserve: number;
  gridCharge: boolean;
}

const scenarios: Scenario[] = [
  {
    id: 'balanced',
    name: 'Balanced',
    icon: 'scale',
    active: true,
    weights: { save: 0.4, self: 0.3, indep: 0.2, comfort: 0.1 },
    reserve: 20,
    gridCharge: false,
  },
  {
    id: 'max-savings',
    name: 'Max savings',
    icon: 'piggy-bank',
    active: false,
    weights: { save: 0.7, self: 0.2, indep: 0.05, comfort: 0.05 },
    reserve: 10,
    gridCharge: true,
  },
  {
    id: 'self-sufficient',
    name: 'Self-sufficient',
    icon: 'leaf',
    active: false,
    weights: { save: 0.2, self: 0.5, indep: 0.25, comfort: 0.05 },
    reserve: 20,
    gridCharge: false,
  },
  {
    id: 'resilient',
    name: 'Storm-ready',
    icon: 'shield',
    active: false,
    weights: { save: 0.15, self: 0.25, indep: 0.5, comfort: 0.1 },
    reserve: 50,
    gridCharge: true,
  },
];

export function getScenarios(): unknown {
  const active = scenarios.find((s) => s.active)?.id ?? null;
  return {
    ts: new Date().toISOString(),
    active,
    scenarios: scenarios.map((s) => ({ id: s.id, name: s.name, icon: s.icon, active: s.active })),
  };
}

export function applyScenario(id: string): unknown {
  const target = scenarios.find((s) => s.id === id);
  if (!target) throw new Error(`scenario ${id} not found`);
  for (const s of scenarios) s.active = s.id === id;
  return { ts: new Date().toISOString(), active: id };
}

export interface PreviewInput {
  weights?: Partial<Scenario['weights']>;
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
