import type { Band, HistoryDayResponse, TariffBandSegment } from './types';

/* ============================================================================
 * dayMetrics — ONE aggregate over the day's 5-minute samples, serving the whole
 * Live screen (docs/53). V1 computed self-sufficiency and "saved" two different
 * ways on the same screen and disagreed with itself; every consumer now reads
 * these numbers from here so that can't happen again.
 *
 * Two rules this encodes:
 *
 *  1. Self-sufficiency is LOAD MET WITHOUT THE GRID. Grid kWh that filled the
 *     packs (a night pre-charge) is not household import — folding it into the
 *     numerator makes import exceed household consumption and the metric
 *     collapses to 0%.
 *  2. "Saved · vs grid-only" must never be NEGATIVE on a night pre-charge.
 *     Booking the charge's cost against the whole day's avoided cost keeps it
 *     honest and positive.
 * ==========================================================================*/

/** Spain 2.0TD energy rates — mirrors apps/api/src/tariff.ts RATES. */
export const BAND_RATE: Record<Band, number> = { P1: 0.2093, P2: 0.1309, P3: 0.0957 };
export const BAND_WORD: Record<Band, string> = { P1: 'peak', P2: 'shoulder', P3: 'off-peak' };

/** 288 five-minute buckets per day; one bucket is 1/12 h. */
export const DAY_BUCKETS = 288;
const STEP_H = 5 / 60;

/** Default Spain 2.0TD weekday segments — used when the API sends none. */
const DEFAULT_BANDS: TariffBandSegment[] = [
  { startH: 0, endH: 8, band: 'P3' },
  { startH: 8, endH: 10, band: 'P2' },
  { startH: 10, endH: 14, band: 'P1' },
  { startH: 14, endH: 18, band: 'P2' },
  { startH: 18, endH: 22, band: 'P1' },
  { startH: 22, endH: 24, band: 'P2' },
];

/** Band lookup by fractional hour, from the day's own tariff segments. */
export function bandAtHour(segments: TariffBandSegment[] | undefined, h: number): Band {
  const segs = segments && segments.length ? segments : DEFAULT_BANDS;
  const x = ((h % 24) + 24) % 24;
  for (const s of segs) if (x >= s.startH && x < s.endH) return s.band;
  return segs[segs.length - 1].band;
}

/** "14:15" for a 5-minute bucket index. */
export function bucketTime(i: number): string {
  const mins = Math.round(i * 5);
  return `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/** Fractional hour for a 5-minute bucket index. */
const bucketHour = (i: number) => (i * 5) / 60;

/** Cumulative day aggregate, up to and including bucket `upTo`. */
export interface DayAggregate {
  /** Bucket the aggregate runs to (inclusive). */
  index: number;
  producedKwh: number;
  consumedKwh: number;
  exportedKwh: number;
  /** Grid kWh that served the HOUSE (excludes grid used to fill the packs). */
  householdImportKwh: number;
  /** Grid kWh that filled the PACKS. */
  chargeImportKwh: number;
  /** Total kWh pushed into the packs today, from any source. */
  chargeKwh: number;
  /** € actually spent on grid energy so far (household + pack charging). */
  costEur: number;
  /** € the same consumption would have cost bought entirely from the grid. */
  gridOnlyEur: number;
  /** gridOnlyEur − costEur. Non-negative by construction on a night pre-charge. */
  savedEur: number;
  /** 0–100, load met without the grid. */
  selfSufficiencyPct: number;
}

/**
 * Aggregate the measured day up to `upTo` (default: the last measured bucket).
 * Only measured samples are counted — forecast buckets never enter a "today" KPI.
 */
export function aggregateDay(day: HistoryDayResponse, upTo?: number): DayAggregate {
  const s = day.series;
  const last = day.nowIndex ?? DAY_BUCKETS - 1;
  const end = Math.max(0, Math.min(last, upTo ?? last));

  let producedKwh = 0;
  let consumedKwh = 0;
  let exportedKwh = 0;
  let householdImportKwh = 0;
  let chargeImportKwh = 0;
  let chargeKwh = 0;
  let costEur = 0;
  let gridOnlyEur = 0;

  for (let i = 0; i <= end; i++) {
    const p = s.solarKw[i] ?? 0;
    const c = s.homeKw[i] ?? 0;
    const charge = s.chargeKw[i] ?? 0;
    const discharge = s.dischargeKw[i] ?? 0;
    const rate = BAND_RATE[bandAtHour(day.tariffBands, bucketHour(i))];

    const solarToHouse = Math.min(p, c);
    const householdImport = Math.max(0, c - solarToHouse - discharge);
    const chargeImport = Math.max(0, charge - Math.max(0, p - c));

    producedKwh += p * STEP_H;
    consumedKwh += c * STEP_H;
    exportedKwh += (s.gridExportKw[i] ?? 0) * STEP_H;
    householdImportKwh += householdImport * STEP_H;
    chargeImportKwh += chargeImport * STEP_H;
    chargeKwh += charge * STEP_H;
    costEur += (householdImport + chargeImport) * STEP_H * rate;
    gridOnlyEur += c * STEP_H * rate;
  }

  const selfSufficiencyPct =
    consumedKwh > 0.1 ? Math.max(0, Math.min(100, Math.round((1 - householdImportKwh / consumedKwh) * 100))) : 100;

  return {
    index: end,
    producedKwh,
    consumedKwh,
    exportedKwh,
    householdImportKwh,
    chargeImportKwh,
    chargeKwh,
    costEur,
    gridOnlyEur,
    savedEur: gridOnlyEur - costEur,
    selfSufficiencyPct,
  };
}

/** Peak measured production of the day + when it happened. */
export function peakProduction(day: HistoryDayResponse): { kw: number; at: string } | null {
  const last = day.nowIndex ?? DAY_BUCKETS - 1;
  let best = -1;
  let at = 0;
  for (let i = 0; i <= last; i++) {
    const v = day.series.solarKw[i] ?? 0;
    if (v > best) {
      best = v;
      at = i;
    }
  }
  return best > 0 ? { kw: best, at: bucketTime(at) } : null;
}

/**
 * Money, written with the typographic minus — never a hyphen. `−€0.21`, `€4.16`.
 * The sign is taken from the ROUNDED value so a −0.001 never prints as "−€0.00".
 */
export function eur(v: number): string {
  const cents = Math.round(v * 100);
  return `${cents < 0 ? '−€' : '€'}${(Math.abs(cents) / 100).toFixed(2)}`;
}
