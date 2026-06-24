import * as tesla from '../connectors/tesla';
import {
  RATES,
  POWER_TERM_EUR_MONTH,
  EXPORT_MID,
  bandHourWeights,
  type Band,
} from '../tariff';

type Range = 'day' | 'week' | 'month' | 'year';

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

interface EnergyRow {
  timestamp?: string;
  total_solar_generation?: number;
  solar_energy_exported?: number;
  grid_energy_imported?: number;
  grid_energy_exported_from_solar?: number;
  grid_energy_exported_from_battery?: number;
  consumer_energy_imported_from_grid?: number;
  consumer_energy_imported_from_solar?: number;
  consumer_energy_imported_from_battery?: number;
  battery_energy_imported_from_solar?: number;
}

function rowHome(r: EnergyRow): number {
  return (
    (r.consumer_energy_imported_from_grid ?? 0) +
    (r.consumer_energy_imported_from_solar ?? 0) +
    (r.consumer_energy_imported_from_battery ?? 0)
  );
}
function rowSolar(r: EnergyRow): number {
  // Real PV produced this bucket. Tesla's `total_solar_generation` is the metered
  // figure; if absent, reconstruct from where the solar energy went (self-use +
  // battery + export) so `series.prod` carries real generation, not zeros.
  if (typeof r.total_solar_generation === 'number') return r.total_solar_generation;
  const reconstructed =
    (r.consumer_energy_imported_from_solar ?? 0) +
    (r.battery_energy_imported_from_solar ?? 0) +
    (r.grid_energy_exported_from_solar ?? 0);
  if (reconstructed > 0) return reconstructed;
  return r.solar_energy_exported ?? 0;
}
function rowExport(r: EnergyRow): number {
  return (r.grid_energy_exported_from_solar ?? 0) + (r.grid_energy_exported_from_battery ?? 0);
}
function rowImport(r: EnergyRow): number {
  return r.grid_energy_imported ?? r.consumer_energy_imported_from_grid ?? 0;
}

function powerTermFor(range: Range): number {
  // Capacity term billed monthly; pro-rate to the range window.
  switch (range) {
    case 'day':
      return round((POWER_TERM_EUR_MONTH / 30), 2);
    case 'week':
      return round((POWER_TERM_EUR_MONTH / 30) * 7, 2);
    case 'month':
      return round(POWER_TERM_EUR_MONTH, 2);
    case 'year':
      return round(POWER_TERM_EUR_MONTH * 12, 2);
  }
}

// Best-effort estimated load disaggregation for an all-electric Jávea house.
// Flagged estimated:true. Weights are a fixed annual-typical split.
const LOAD_SPLIT: Array<{ name: string; icon: string; tone: string; pct: number }> = [
  { name: 'Heat pump + floor', icon: 'thermometer', tone: 'home', pct: 0.3 },
  { name: 'A/C', icon: 'wind', tone: 'home', pct: 0.18 },
  { name: 'EV (2× BMW i3)', icon: 'car', tone: 'ev', pct: 0.2 },
  { name: 'Water heating', icon: 'droplet', tone: 'home', pct: 0.14 },
  { name: 'Appliances', icon: 'washing-machine', tone: 'home', pct: 0.12 },
  { name: 'Lighting', icon: 'lightbulb', tone: 'home', pct: 0.06 },
];

export async function getHistory(range: Range): Promise<unknown> {
  let rows: EnergyRow[] = [];
  try {
    const raw = (await tesla.getCalendarHistory('energy', range)) as {
      time_series?: EnergyRow[];
    };
    rows = raw.time_series ?? [];
  } catch {
    rows = [];
  }

  let solar = 0;
  let consumed = 0;
  let exported = 0;
  let imported = 0;
  const prod: number[] = [];
  const cons: number[] = [];
  const labels: string[] = [];

  for (const r of rows) {
    const s = rowSolar(r);
    const h = rowHome(r);
    solar += s;
    consumed += h;
    exported += rowExport(r);
    imported += rowImport(r);
    prod.push(round(s / 1000, 2));
    cons.push(round(h / 1000, 2));
    labels.push(formatLabel(r.timestamp, range, labels.length));
  }

  const producedKwh = round(solar / 1000);
  const consumedKwh = round(consumed / 1000);
  const exportedKwh = round(exported / 1000);
  const importedKwh = imported / 1000;
  const selfSufficiencyPct =
    consumedKwh > 0
      ? Math.max(0, Math.min(100, Math.round((1 - importedKwh / consumedKwh) * 100)))
      : 0;

  // Cost by band — APPROXIMATION: split grid-imported energy across P1/P2/P3 using
  // the typical band-hours weighting, then multiply by each band's rate. This is a
  // weighting estimate, not metered per-band consumption (Tesla history is not
  // band-resolved). Documented as such.
  const weights = bandHourWeights();
  const byBand = (Object.keys(RATES) as Band[]).map((band) => {
    const kwh = round(importedKwh * weights[band]);
    return { band, kwh, eur: round(kwh * RATES[band], 2), rate: RATES[band] };
  });

  // Solar value: self-used vs exported.
  const selfUsedKwh = Math.max(0, producedKwh - exportedKwh);
  const selfUsedPct = producedKwh > 0 ? Math.round((selfUsedKwh / producedKwh) * 100) : 0;
  const exportEur = round(exportedKwh * EXPORT_MID, 2);
  // Average import rate (band-weighted) used to value what export *would* have saved.
  const avgImportRate =
    RATES.P1 * weights.P1 + RATES.P2 * weights.P2 + RATES.P3 * weights.P3;
  const worthIfSelfUsedEur = round(exportedKwh * avgImportRate, 2);

  // savedEur: value of solar+battery energy that displaced grid imports.
  const displacedKwh = Math.max(0, consumedKwh - importedKwh);
  const savedEur = round(displacedKwh * avgImportRate, 2);
  const co2Kg = round(displacedKwh * 0.19, 1); // ~0.19 kg CO2/kWh Spanish grid

  // By-load estimated split over consumed energy.
  const byLoad = LOAD_SPLIT.map((l) => ({
    name: l.name,
    icon: l.icon,
    tone: l.tone,
    kwh: round(consumedKwh * l.pct),
    pct: Math.round(l.pct * 100),
    estimated: true as const,
  }));

  return {
    ts: new Date().toISOString(),
    range,
    totals: {
      producedKwh,
      consumedKwh,
      exportedKwh,
      selfSufficiencyPct,
      savedEur,
      co2Kg,
    },
    solarValue: { selfUsedPct, exportedKwh, exportEur, worthIfSelfUsedEur },
    byBand,
    powerTermEur: powerTermFor(range),
    // series.prod = real per-bucket solar generation (Tesla calendar_history);
    // series.cons = real per-bucket home consumption. byBand (above) is the
    // documented weighting APPROXIMATION since Tesla history is not band-resolved.
    series: { prod, cons, labels },
    byLoad,
  };
}

function formatLabel(ts: string | undefined, range: Range, idx: number): string {
  if (!ts) return String(idx);
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(idx);
  if (range === 'day') {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      hour12: false,
    }).format(d);
  }
  if (range === 'year') {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', month: 'short' }).format(d);
  }
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
  }).format(d);
}
