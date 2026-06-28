import * as tesla from '../connectors/tesla';
import {
  RATES,
  POWER_TERM_EUR_MONTH,
  EXPORT_MID,
  bandHourWeights,
  bandFor,
  type Band,
} from '../tariff';

export type Range = 'hour' | 'day' | 'week' | 'month' | 'year';

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// How far back the Reports period navigator can step, per range (offset 0 = now).
// Hour is always "now". Bounds keep the picker finite and disable ◀ at the edge.
export const MAX_BACK: Record<Range, number> = { hour: 0, day: 60, week: 26, month: 24, year: 5 };

const TZ = 'Europe/Madrid';
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Minutes Europe/Madrid is ahead of UTC at instant `d` (handles CET/CEST). */
function madridOffsetMin(d: Date): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUTC - d.getTime()) / 60000);
}

/** The UTC instant whose Madrid wall-clock equals the given Y-M-D H:Mi:S.mmm. */
function madridInstant(y: number, m: number, d: number, H: number, Mi: number, S: number, ms: number): Date {
  let guess = Date.UTC(y, m - 1, d, H, Mi, S, ms);
  for (let i = 0; i < 2; i++) {
    const off = madridOffsetMin(new Date(guess));
    guess = Date.UTC(y, m - 1, d, H, Mi, S, ms) - off * 60000;
  }
  return new Date(guess);
}

/** Madrid calendar fields for instant `d` (wd 0=Sun..6=Sat). */
function madridCal(d: Date): { y: number; m: number; day: number; wd: number } {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const wmap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: Number(g('year')), m: Number(g('month')), day: Number(g('day')), wd: wmap[g('weekday')] ?? 1 };
}

const DAY_MS = 86_400_000;

/**
 * The Tesla `start_date`/`end_date` window + a display label for a given range
 * and offset (0 = current period, negative = into the past). Returns null for the
 * live/current period (no window → unchanged current-period behaviour).
 */
function periodWindow(range: Range, offset: number): { startDate: string; endDate: string; label: string } | null {
  if (offset === 0 || range === 'hour') return null;
  const today = madridCal(new Date());

  if (range === 'year') {
    const y = today.y + offset;
    return {
      startDate: madridInstant(y, 1, 1, 0, 0, 0, 0).toISOString(),
      endDate: madridInstant(y, 12, 31, 23, 59, 59, 999).toISOString(),
      label: String(y),
    };
  }
  if (range === 'month') {
    const base = today.m - 1 + offset;
    const y = today.y + Math.floor(base / 12);
    const m = ((base % 12) + 12) % 12 + 1;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      startDate: madridInstant(y, m, 1, 0, 0, 0, 0).toISOString(),
      endDate: madridInstant(y, m, lastDay, 23, 59, 59, 999).toISOString(),
      label: `${MONTHS[m - 1]} ${y}`,
    };
  }
  // day / week — anchor on Madrid-noon and step in whole days (DST-safe).
  const anchor = madridInstant(today.y, today.m, today.day, 12, 0, 0, 0);
  if (range === 'day') {
    const c = madridCal(new Date(anchor.getTime() + offset * DAY_MS));
    return {
      startDate: madridInstant(c.y, c.m, c.day, 0, 0, 0, 0).toISOString(),
      endDate: madridInstant(c.y, c.m, c.day, 23, 59, 59, 999).toISOString(),
      label: `${WD[c.wd]} ${c.day} ${MONTHS[c.m - 1]} ${c.y}`,
    };
  }
  // week — Monday..Sunday, shifted by `offset` weeks.
  const isoWd = today.wd === 0 ? 7 : today.wd; // Mon=1..Sun=7
  const mondayInstant = new Date(anchor.getTime() + (offset * 7 - (isoWd - 1)) * DAY_MS);
  const monday = madridCal(mondayInstant);
  const sunday = madridCal(new Date(mondayInstant.getTime() + 6 * DAY_MS));
  const label =
    monday.m === sunday.m
      ? `${monday.day}–${sunday.day} ${MONTHS[monday.m - 1]} ${monday.y}`
      : `${monday.day} ${MONTHS[monday.m - 1]} – ${sunday.day} ${MONTHS[sunday.m - 1]} ${sunday.y}`;
  return {
    startDate: madridInstant(monday.y, monday.m, monday.day, 0, 0, 0, 0).toISOString(),
    endDate: madridInstant(sunday.y, sunday.m, sunday.day, 23, 59, 59, 999).toISOString(),
    label,
  };
}

interface EnergyRow {
  timestamp?: string | number;
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
    case 'hour':
      return round(POWER_TERM_EUR_MONTH / 30 / 24, 2);
    case 'day':
      return round(POWER_TERM_EUR_MONTH / 30, 2);
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

export async function getHistory(range: Range, rawOffset = 0): Promise<unknown> {
  // Period navigator: clamp the requested offset into the allowed look-back. Hour
  // is always "now" (offset 0); other ranges step back day/week/month/year.
  const offset = range === 'hour' ? 0 : Math.max(-MAX_BACK[range], Math.min(0, Math.round(rawOffset)));
  const win = periodWindow(range, offset);

  // Tesla calendar_history has no sub-day period, so the Hour view reuses the day
  // series and keeps only the last 60 minutes.
  const period = range === 'hour' ? 'day' : range;
  let rows: EnergyRow[] = [];
  try {
    const raw = (await tesla.getCalendarHistory('energy', period, win ?? undefined)) as {
      time_series?: EnergyRow[];
    };
    rows = raw.time_series ?? [];
  } catch {
    rows = [];
  }
  if (range === 'hour') {
    const cutoff = Date.now() - 60 * 60 * 1000;
    rows = rows.filter((r) => {
      const d = toDate(r.timestamp);
      return d != null && d.getTime() >= cutoff;
    });
  }

  let solar = 0;
  let consumed = 0;
  let exported = 0;
  let imported = 0;

  // Tesla calendar_history returns FINE-GRAINED samples, not summary buckets:
  // ~2105 points for a year (every ~2h), ~163 for a week (every 30 min). Summing
  // them gives correct totals, but charting one bar per sample yields a wall of
  // thousands of bars whose leading labels are all the first period ("Jan, Jan…").
  // So aggregate the chart series into the natural bucket per range
  // (year→months, week/month→days, day→hours, hour→5-min), summing energy.
  // Per-bucket grid import is also attributed to the REAL tariff band each sample
  // falls in (time-of-use, via `bandFor(timestamp)` in Europe/Madrid) — this is a
  // true split, not the WEEKLY_BAND_HOURS weighting used for the aggregate `byBand`.
  // It backs the Reports "Grid purchase by band" chart and follows the range selector.
  const zeroBand = (): Record<Band, number> => ({ P1: 0, P2: 0, P3: 0 });
  const buckets = new Map<
    string,
    { label: string; p: number; c: number; imp: number; band: Record<Band, number> }
  >();
  for (const r of rows) {
    const s = rowSolar(r);
    const h = rowHome(r);
    const imp = rowImport(r);
    solar += s;
    consumed += h;
    exported += rowExport(r);
    imported += imp;
    const d = toDate(r.timestamp);
    if (!d) continue;
    const { key, label } = bucketOf(d, range);
    const b = buckets.get(key) ?? { label, p: 0, c: 0, imp: 0, band: zeroBand() };
    b.p += s / 1000;
    b.c += h / 1000;
    b.imp += imp / 1000;
    b.band[bandFor(d)] += imp / 1000;
    buckets.set(key, b);
  }
  // Map preserves insertion order; Tesla returns rows chronologically.
  const ordered = [...buckets.values()];
  const prod = ordered.map((b) => round(b.p, 2));
  const cons = ordered.map((b) => round(b.c, 2));
  const labels = ordered.map((b) => b.label);
  // Per-bucket grid-import split by real band (kWh) for the by-band purchase chart.
  const bandKwh = {
    P1: ordered.map((b) => round(b.band.P1, 2)),
    P2: ordered.map((b) => round(b.band.P2, 2)),
    P3: ordered.map((b) => round(b.band.P3, 2)),
  };
  // Per-bucket self-sufficiency (autonomy) = share of consumption NOT bought from grid.
  const autonomy = ordered.map((b) =>
    b.c > 0 ? Math.max(0, Math.min(100, Math.round((1 - b.imp / b.c) * 100))) : 0,
  );

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
    // Period navigator: which period this payload is for + whether older/newer exist.
    offset,
    isCurrent: offset === 0,
    hasPrev: range !== 'hour' && offset > -MAX_BACK[range],
    hasNext: offset < 0,
    periodLabel: win?.label ?? null,
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
    // series.cons = real per-bucket home consumption; series.autonomy = per-bucket
    // self-sufficiency %; series.bandKwh = real per-bucket grid import split by tariff
    // band (time-of-use). byBand (above) is the documented weighting APPROXIMATION.
    series: { prod, cons, labels, autonomy, bandKwh },
    byLoad,
  };
}

/**
 * Parse a Tesla sample timestamp. Usually an ISO string, but numeric epochs also
 * appear — and a 10-digit value is epoch *seconds*: handing that to `new Date()`
 * (which expects ms) collapses everything to Jan 1970. Scale seconds → ms first.
 */
function toDate(ts: string | number | undefined): Date | null {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number' || /^\d+$/.test(String(ts).trim())) {
    const n = Number(ts);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Date parts in the site timezone (so buckets align to local calendar days/months). */
function madridParts(d: Date): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
} {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

/**
 * Map a sample timestamp to its chart bucket for the given range. `key` groups
 * samples (sums within it); `label` is the x-axis text. hour→5-min, day→hour,
 * week/month→day, year→month. Keys include enough date parts to never collide.
 */
function bucketOf(d: Date, range: Range): { key: string; label: string } {
  const { year, month, day, hour, minute } = madridParts(d);
  if (range === 'hour') {
    const m5 = String(Math.floor(Number(minute) / 5) * 5).padStart(2, '0');
    return { key: `${day}-${hour}-${m5}`, label: `${hour}:${m5}` };
  }
  if (range === 'day') return { key: `${year}-${month}-${day}-${hour}`, label: `${hour}:00` };
  if (range === 'year') return { key: `${year}-${month}`, label: MONTHS[Number(month) - 1] ?? month };
  // week + month → daily buckets
  return { key: `${year}-${month}-${day}`, label: `${day}/${month}` };
}
