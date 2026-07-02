// Daylight / expected-production gating for the solar-inverter outage alerts.
//
// The WiNet-S dongle is powered BY the inverter, so a string inverter + its dongle
// de-energize every night and reappear after sunrise (docs/36). A naïve
// "unreachable → alarm" would page nightly. These helpers gate the offline/stall
// rules on EXPECTED production so a night miss is suppressed and only a daylight
// outage fires.
//
// Primary signal = Autopilot's shared clear-sky × learned-roof forecast
// (solar-model.forecastSolarKw), which already blends live weather. We read the
// current Madrid hour's forecast kW; if the model is unavailable we fall back to a
// pure solar-elevation daytime check. Read-only; no control coupling.

import { forecastSolarKw, solarElevationDeg, madridDayOfYear } from './solar-model';
import { weatherCoords } from './runtime-config';
import * as weather from './connectors/weather';

const TZ = 'Europe/Madrid';

/** Fractional Madrid hour right now (0–24). */
function madridHourFloat(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hh + mm / 60;
}

/**
 * Simple sun-up check: solar elevation > a few degrees. Timezone-simple; used as the
 * fallback gate for the offline rule when the forecast model isn't consulted.
 */
export function isDaylightNow(now: Date = new Date()): boolean {
  const { lat } = weatherCoords();
  const elev = solarElevationDeg(madridHourFloat(now), madridDayOfYear(now), lat);
  return elev > 3;
}

/**
 * Expected clear-sky-weighted production (kW) for the current hour, from the shared
 * Autopilot forecast (clear-sky × learned roof × live weather). Returns 0 when the
 * model can't be built. Best-effort + fail-soft — never throws.
 */
export async function expectedProductionKwNow(now: Date = new Date()): Promise<number> {
  try {
    const wx = await weather.getForecast().catch(() => null);
    const perHour = forecastSolarKw(wx, now);
    const h = Math.floor(madridHourFloat(now));
    return perHour[Math.max(0, Math.min(23, h))] ?? 0;
  } catch {
    return 0;
  }
}

/** kW threshold above which "the roof should be producing meaningfully right now". */
export const MEANINGFUL_PRODUCTION_KW = 0.5;

/**
 * True when the model expects meaningful production right now (daylight with a
 * non-trivial forecast). Falls back to the plain daylight check if the forecast is 0
 * but the sun is well up (so a missing model never fully suppresses a real outage).
 */
export async function expectMeaningfulProductionNow(now: Date = new Date()): Promise<boolean> {
  const expected = await expectedProductionKwNow(now);
  if (expected >= MEANINGFUL_PRODUCTION_KW) return true;
  // Model unavailable / zero but the sun is clearly up → still treat as daylight.
  const { lat } = weatherCoords();
  const elev = solarElevationDeg(madridHourFloat(now), madridDayOfYear(now), lat);
  return expected === 0 && elev > 15;
}
