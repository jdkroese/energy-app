// Learned household consumption forecast for the all-electric Jávea house.
//
// Pure functions over the retained 30-day 5-min history (history5m) — no new
// persistence. The learned per-hour profile (median of measured homeKw, split
// weekday vs weekend) is blended with a hardcoded generic base curve by a
// confidence that ramps with the number of retained days, then thermally nudged
// (heating <16 °C, cooling >26 °C) on top. Falls back cleanly to the base curve
// when there is no history.
//
// Shared by the Live "Today" chart (history-day.ts) and the Autopilot plan
// (brain.ts) so both surfaces forecast consumption identically.

import * as history from './history5m';

/**
 * Hardcoded generic daily load profile (kW per hour) for the all-electric house —
 * morning + evening peaks. Exported so both call sites (and the confidence blend)
 * share the SAME base. Do not mutate the returned array.
 */
export const BASE_LOAD_KW: readonly number[] = [
  0.6, 0.5, 0.5, 0.5, 0.5, 0.6, 0.9, 1.4, 1.6, 1.3, 1.1, 1.2, 1.3, 1.2, 1.1, 1.2, 1.4, 1.8, 2.4,
  2.6, 2.3, 1.8, 1.2, 0.8,
];

/** Retained days looked back over for the learned profile (~3 weeks). */
const LEARN_LOOKBACK_DAYS = 21;
/** Distinct day-type days at which the learned profile is fully trusted. */
const FULL_CONFIDENCE_DAYS = 14;

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Madrid-local weekday index (0=Sun..6=Sat) for a Date. */
function madridWeekday(d: Date): number {
  const wdName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    weekday: 'short',
  }).format(d);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wdName] ?? 1;
}

/** True when a Madrid date key (YYYY-MM-DD) falls on Sat/Sun. */
function isWeekendKey(dateKey: string): boolean {
  const wd = madridWeekday(new Date(`${dateKey}T12:00:00`));
  return wd === 0 || wd === 6;
}

/**
 * Learned per-hour load profile (24) matching the requested day-type (weekday vs
 * weekend), plus the number of distinct matching days seen. For each hour it takes
 * the median of that hour's mean measured homeKw across the matching retained days;
 * entries are null where no matching day produced a positive sample that hour.
 */
function learnedProfile(wantWeekend: boolean): { profile: (number | null)[]; daysSeen: number } {
  let keys: string[];
  try {
    keys = history.availableDayKeys();
  } catch {
    return { profile: new Array<number | null>(24).fill(null), daysSeen: 0 };
  }
  // Newest LEARN_LOOKBACK_DAYS days matching the requested day-type.
  const matching = keys
    .filter((k) => isWeekendKey(k) === wantWeekend)
    .slice(-LEARN_LOOKBACK_DAYS);

  // Per-hour samples: each matching day contributes ONE value per hour (that
  // hour's mean measured homeKw), so the median is over days, not raw buckets.
  const perHour: number[][] = Array.from({ length: 24 }, () => []);
  let daysSeen = 0;
  for (const key of matching) {
    const series = history.getDay(key);
    if (!series) continue;
    const hourlySum = new Array<number>(24).fill(0);
    const hourlyCount = new Array<number>(24).fill(0);
    series.homeKw.forEach((kw, bucket) => {
      const h = Math.floor(bucket / 12);
      if (h < 24) {
        hourlySum[h] += kw;
        hourlyCount[h] += 1;
      }
    });
    let contributed = false;
    for (let h = 0; h < 24; h++) {
      if (hourlyCount[h] > 0) {
        const mean = hourlySum[h] / hourlyCount[h];
        if (Number.isFinite(mean) && mean > 0) {
          perHour[h].push(mean);
          contributed = true;
        }
      }
    }
    if (contributed) daysSeen += 1;
  }

  const profile = perHour.map((xs) => (xs.length > 0 ? median(xs) : null));
  return { profile, daysSeen };
}

/**
 * Consumption forecast (24 hourly kW) for the all-electric house.
 *
 * Learned base = per-hour median of measured homeKw over the last ~21 retained
 * days of the day-type matching `date` (weekday vs weekend), blended with the
 * hardcoded BASE_LOAD_KW by confidence = min(1, daysSeen/14). The thermal nudge
 * (heating <16 °C, cooling >26 °C) is added on top. With no history it returns the
 * base curve (+ thermal nudge).
 */
export function forecastLoadKw(date: Date, temp: number[] | null): number[] {
  const wantWeekend = (() => {
    const wd = madridWeekday(date);
    return wd === 0 || wd === 6;
  })();
  const { profile, daysSeen } = learnedProfile(wantWeekend);
  const confidence = Math.min(1, daysSeen / FULL_CONFIDENCE_DAYS);

  return BASE_LOAD_KW.map((baseKw, h) => {
    const learned = profile[h];
    // Blend learned ⇄ base by confidence; where a specific hour has no learned
    // value, fall back to the base for that hour regardless of overall confidence.
    let v =
      learned != null && Number.isFinite(learned)
        ? baseKw * (1 - confidence) + learned * confidence
        : baseKw;
    // Thermal nudge (same coefficients as the legacy hardcoded forecast).
    if (temp && temp[h] !== undefined) {
      const t = temp[h];
      if (t < 16) v += (16 - t) * 0.08;
      if (t > 26) v += (t - 26) * 0.1;
    }
    return round(Math.max(0, v), 2);
  });
}
