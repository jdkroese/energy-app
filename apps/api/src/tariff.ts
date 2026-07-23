// Spain 2.0TD tariff logic for Europe/Madrid.
//
// Bands (Mon–Fri):
//   P1 (peak)     €0.2093/kWh  10:00–14:00 & 18:00–22:00
//   P2 (standard) €0.1309/kWh  08:00–10:00, 14:00–18:00, 22:00–24:00
//   P3 (valley)   €0.0957/kWh  00:00–08:00
// Weekends (Sat/Sun) and national holidays: all P3.
// Export credit €0.003–0.029/kWh; power (capacity) term €36.19/mo, single-phase 14 kW.

export type Band = 'P1' | 'P2' | 'P3';

export const RATES: Record<Band, number> = {
  P1: 0.2093,
  P2: 0.1309,
  P3: 0.0957,
};

export const EXPORT_RANGE = { min: 0.003, max: 0.029 } as const;
// Mid estimate used when valuing exported/self-used energy.
export const EXPORT_MID = 0.016;
export const POWER_TERM_EUR_MONTH = 36.19;
export const TZ = 'Europe/Madrid';

/** Returns {hour 0-23, weekday 0=Sun..6=Sat} for a Date in Europe/Madrid. */
function madridParts(d: Date): { hour: number; weekday: number } {
  // Hour via Intl, 24h clock.
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      hour: '2-digit',
      hour12: false,
    }).format(d),
  ) % 24;
  const wdName = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
  }).format(d);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { hour, weekday: map[wdName] ?? 1 };
}

/** Band for a given hour/weekday (weekday 0=Sun..6=Sat). */
export function bandForHour(hour: number, weekday: number): Band {
  if (weekday === 0 || weekday === 6) return 'P3'; // weekend = all valley
  // Weekday
  if ((hour >= 10 && hour < 14) || (hour >= 18 && hour < 22)) return 'P1';
  if ((hour >= 8 && hour < 10) || (hour >= 14 && hour < 18) || hour >= 22) return 'P2';
  return 'P3'; // 00:00–08:00
}

/** Current band for a Date (defaults now). */
export function bandFor(d: Date = new Date()): Band {
  const { hour, weekday } = madridParts(d);
  return bandForHour(hour, weekday);
}

/**
 * Current band + the next *different* band and minutes until it starts.
 * Computed by scanning forward minute-coarse on the hour boundaries.
 */
export function bandInfo(d: Date = new Date()): {
  band: Band;
  rateEur: number;
  nextBand: Band;
  minsToNext: number;
} {
  const { hour, weekday } = madridParts(d);
  const band = bandForHour(hour, weekday);

  // Minutes elapsed in the current Madrid hour.
  const minNow = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      minute: '2-digit',
    }).format(d),
  );

  // Walk forward hour by hour (up to 48h) to find the next band change.
  let h = hour;
  let wd = weekday;
  let minutes = 60 - minNow; // until end of current hour
  for (let i = 0; i < 48; i++) {
    h = (h + 1) % 24;
    if (h === 0) wd = (wd + 1) % 7;
    const b = bandForHour(h, wd);
    if (b !== band) {
      return { band, rateEur: RATES[band], nextBand: b, minsToNext: minutes };
    }
    minutes += 60;
  }
  // Fallback (should not happen): no change found.
  return { band, rateEur: RATES[band], nextBand: band, minsToNext: minutes };
}

/** 24 hourly band codes (0=P3, 1=P2, 2=P1) for the calendar day containing `d`. */
export function bandCodesForDay(d: Date = new Date()): number[] {
  const wdName = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
  }).format(d);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = map[wdName] ?? 1;
  const code: Record<Band, number> = { P3: 0, P2: 1, P1: 2 };
  return Array.from({ length: 24 }, (_, h) => code[bandForHour(h, weekday)]);
}

/**
 * Fraction of a typical week's hours spent in each band — used to approximate
 * cost-by-band when we only have a total consumed-energy figure for a range.
 * Weekday: P1 = 8h, P2 = 8h, P3 = 8h. Weekend: 24h P3.
 * Over a week: P1 = 40h, P2 = 40h, P3 = 40 + 48 = 88h (total 168h).
 */
export const WEEKLY_BAND_HOURS: Record<Band, number> = { P1: 40, P2: 40, P3: 88 };

export function bandHourWeights(): Record<Band, number> {
  const total = WEEKLY_BAND_HOURS.P1 + WEEKLY_BAND_HOURS.P2 + WEEKLY_BAND_HOURS.P3;
  return {
    P1: WEEKLY_BAND_HOURS.P1 / total,
    P2: WEEKLY_BAND_HOURS.P2 / total,
    P3: WEEKLY_BAND_HOURS.P3 / total,
  };
}
