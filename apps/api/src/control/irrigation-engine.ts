// Irrigation ET / water-need engine — PURE functions (no I/O, no store, no clock side
// effects) so the trim math is fully unit-testable with no real controller or network.
//
// Model (FAO-56, simplified for a home garden):
//   • ETc (crop evapotranspiration, mm) = ET₀ × Kc × sunExposure   — the water a zone LOSES.
//   • effective rainfall = a fraction of forecast precip actually retained in the root zone.
//   • soil-water-balance deficit (mm) = Σ(ETc − effective_rain − applied_irrigation), ≥ 0.
//   • a watering time's SCHEDULED minutes are the CEILING; weather only TRIMS them down:
//       – rain-skip  : forecast precip ≥ threshold OR precip-probability ≥ threshold ⇒ 0 min.
//       – ET deficit : the run is sized to the current deficit (mm) ÷ the zone's precip-rate
//         (mm/min). If the deficit is small (cool/wet stretch) the run is trimmed; it never
//         exceeds the scheduled ceiling.
//       – heat top-up: ONLY if the zone opted in AND it's a hot/high-ET day — adds minutes
//         back toward (but never above) the ceiling.
//   • "saved vs plan %" = trimmed minutes ÷ scheduled minutes across the day.

import type {
  IrrigationZoneConfig,
  IrrigationPlantType,
  IrrigationEmitterType,
} from "../store";

/** Default crop coefficient (Kc) by plant type — mid-season, temperate-garden values. */
export const DEFAULT_KC: Record<IrrigationPlantType, number> = {
  lawn: 0.8,
  shrubs: 0.7,
  flowers: 0.9,
  vegetables: 1.0,
  trees: 0.65,
  groundcover: 0.6,
  succulents: 0.3,
  hedge: 0.7,
};

/** Default emitter flow (L/min per emitter/zone) when the owner hasn't measured one. These
 *  are deliberately rough — the owner can override flowLpm per zone once measured. */
export const DEFAULT_FLOW_LPM: Record<IrrigationEmitterType, number> = {
  spray: 8,
  rotor: 12,
  drip: 2,
  bubbler: 4,
  soaker: 3,
};

/** Fraction of forecast precipitation that actually reaches the root zone (runoff/interception
 *  losses). A standard 0.8 effective-rainfall factor for light/moderate rain. */
export const EFFECTIVE_RAIN_FACTOR = 0.8;

/** ET₀ (mm/day) above which a heat top-up may kick in for opted-in zones. */
export const HEAT_TOPUP_ET0_MM = 6;

/** Resolve a zone's effective Kc (explicit override, else the plant-type default). */
export function kcFor(
  z: Pick<IrrigationZoneConfig, "kc" | "plantType">,
): number {
  return z.kc != null && z.kc > 0 ? z.kc : DEFAULT_KC[z.plantType];
}

/** Resolve a zone's effective flow (explicit override, else the emitter-type default). */
export function flowLpmFor(
  z: Pick<IrrigationZoneConfig, "flowLpm" | "emitterType">,
): number {
  return z.flowLpm != null && z.flowLpm > 0
    ? z.flowLpm
    : DEFAULT_FLOW_LPM[z.emitterType];
}

/** Water volume (L) for a run of `minutes` at the zone's flow. */
export function volumeLiters(
  z: Pick<IrrigationZoneConfig, "flowLpm" | "emitterType">,
  minutes: number,
): number {
  return Math.max(0, minutes) * flowLpmFor(z);
}

/**
 * Precipitation rate the zone APPLIES in mm/min: flow (L/min) over area (m²), since
 * 1 L over 1 m² = 1 mm of depth. Falls back to a sane default when area is unknown so
 * the deficit→minutes conversion is still bounded (we don't want a divide-by-zero, and a
 * missing area shouldn't make a run infinitely long).
 */
export function precipRateMmPerMin(
  z: Pick<IrrigationZoneConfig, "flowLpm" | "emitterType" | "areaM2">,
): number {
  const flow = flowLpmFor(z);
  const area = z.areaM2 != null && z.areaM2 > 0 ? z.areaM2 : 20; // assume 20 m² when unknown
  // L/min ÷ m² = mm/min. Clamp to a plausible band (0.05..2 mm/min) to keep run-sizing sane.
  return Math.max(0.05, Math.min(2, flow / area));
}

/** ETc (mm) a zone loses over the period for a given ET₀ (mm), scaled by Kc and sun exposure. */
export function etcMm(
  z: Pick<IrrigationZoneConfig, "kc" | "plantType" | "sunExposure">,
  et0Mm: number,
): number {
  const sun =
    z.sunExposure != null ? Math.max(0, Math.min(1, z.sunExposure)) : 1;
  return Math.max(0, et0Mm) * kcFor(z) * sun;
}

/** Effective rainfall (mm) retained from forecast precipitation. */
export function effectiveRainMm(precipMm: number): number {
  return Math.max(0, precipMm) * EFFECTIVE_RAIN_FACTOR;
}

/** A day's weather rollup the trim math reasons about (sum/peak across the watering window). */
export interface DayWeather {
  /** Sum of ET₀ (mm) over the day. */
  et0Mm: number;
  /** Sum of forecast precipitation (mm) over the day. */
  precipMm: number;
  /** Peak forecast precip-probability (%) over the day. */
  precipProbabilityPct: number;
  /** Peak ET₀ in any single hour (mm) — a proxy for "hot day" for the heat top-up. */
  peakHourEt0Mm: number;
}

/** Roll up an hourly WeatherForecast into the per-day figures the engine needs. */
export function rollupDayWeather(h: {
  et0: number[];
  precipitation: number[];
  precipitationProbability: number[];
}): DayWeather {
  const sum = (a: number[]) =>
    a.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
  const peak = (a: number[]) =>
    a.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), 0);
  return {
    et0Mm: sum(h.et0),
    precipMm: sum(h.precipitation),
    precipProbabilityPct: peak(h.precipitationProbability),
    peakHourEt0Mm: peak(h.et0),
  };
}

/** The result of trimming one zone's scheduled minutes for the day. */
export interface ZoneTrim {
  zoneId: string;
  /** The scheduled (ceiling) minutes summed across the zone's watering times for the day. */
  scheduledMin: number;
  /** The weather-trimmed minutes the coordinator would actually run. */
  trimmedMin: number;
  /** Minutes saved (scheduled − trimmed). */
  savedMin: number;
  /** Saved as a fraction of scheduled (0..1). 0 when nothing was scheduled. */
  savedPct: number;
  /** True when the whole day was rain-skipped. */
  rainSkipped: boolean;
  /** True when a heat top-up added minutes back. */
  heatTopup: boolean;
  /** Human-readable reason chips (e.g. "rain-skip", "−40% (cool)", "+heat"). */
  reasons: string[];
  /** Estimated water volume (L) for the trimmed run. */
  volumeL: number;
}

export interface TrimInputs {
  globalRainSkipMm: number;
  rainSkipProbabilityPct: number;
  /** Current modelled soil-water deficit (mm) for the zone. */
  deficitMm: number;
  /** Optional soil-moisture sensor override (%). When provided AND high, suppress the run. */
  soilMoisturePct?: number;
}

/**
 * Trim ONE zone's scheduled minutes for the day given the day's weather + the zone's deficit.
 * Pure: no store, no clock. The scheduled minutes are the CEILING — the result is always
 * ≤ scheduledMin (except a heat top-up, which still never exceeds the ceiling).
 */
export function trimZone(
  zone: IrrigationZoneConfig,
  scheduledMin: number,
  weather: DayWeather,
  inputs: TrimInputs,
): ZoneTrim {
  const reasons: string[] = [];
  const base: ZoneTrim = {
    zoneId: zone.zoneId,
    scheduledMin,
    trimmedMin: scheduledMin,
    savedMin: 0,
    savedPct: 0,
    rainSkipped: false,
    heatTopup: false,
    reasons,
    volumeL: 0,
  };
  if (scheduledMin <= 0) {
    base.reasons.push("no schedule");
    return finalize(base, zone);
  }

  // 1. Rain-skip — forecast precip or probability over the (per-zone or global) threshold.
  const rainMmThreshold =
    zone.rainSkipMm != null ? zone.rainSkipMm : inputs.globalRainSkipMm;
  if (weather.precipMm >= rainMmThreshold) {
    base.trimmedMin = 0;
    base.rainSkipped = true;
    base.reasons.push(
      `rain-skip (${weather.precipMm.toFixed(1)}mm ≥ ${rainMmThreshold}mm)`,
    );
    return finalize(base, zone);
  }
  if (weather.precipProbabilityPct >= inputs.rainSkipProbabilityPct) {
    base.trimmedMin = 0;
    base.rainSkipped = true;
    base.reasons.push(
      `rain-skip (${Math.round(weather.precipProbabilityPct)}% rain prob)`,
    );
    return finalize(base, zone);
  }

  // 2. Soil-moisture sensor override — if a real sensor reports the zone is already wet,
  //    skip the run regardless of the modelled deficit (sensor wins over the model).
  if (inputs.soilMoisturePct != null && inputs.soilMoisturePct >= 60) {
    base.trimmedMin = 0;
    base.reasons.push(`soil ${Math.round(inputs.soilMoisturePct)}% — wet`);
    return finalize(base, zone);
  }

  // 3. ET / deficit sizing. The current deficit (mm) is the water debt; convert it to minutes
  //    via the zone's precip rate. effective rain already paid down some of that debt (it's
  //    folded into the running deficit by the coordinator; here we also net same-day rain).
  const rateMmPerMin = precipRateMmPerMin(zone);
  const netDeficitMm = Math.max(
    0,
    inputs.deficitMm - effectiveRainMm(weather.precipMm),
  );
  const neededMin = netDeficitMm / rateMmPerMin;

  // The run is the SMALLER of the schedule ceiling and what the deficit needs.
  let minutes = Math.min(scheduledMin, Math.round(neededMin));

  if (minutes < scheduledMin) {
    const pct = Math.round((1 - minutes / scheduledMin) * 100);
    if (pct > 0) reasons.push(`−${pct}% (low ET deficit)`);
  }

  // 4. Optional heat top-up — opted-in zones on a hot/high-ET day get minutes back toward
  //    the ceiling (never above it). Helps thirsty plants in a heatwave.
  if (
    zone.heatTopupEnabled &&
    weather.peakHourEt0Mm >= HEAT_TOPUP_ET0_MM &&
    minutes < scheduledMin
  ) {
    const topped = Math.min(scheduledMin, Math.round(minutes * 1.25) + 1);
    if (topped > minutes) {
      minutes = topped;
      base.heatTopup = true;
      reasons.push("+heat top-up");
    }
  }

  base.trimmedMin = Math.max(0, Math.min(scheduledMin, minutes));
  return finalize(base, zone);
}

/** Fill in derived fields (savedMin/savedPct/volume) from trimmedMin. */
function finalize(t: ZoneTrim, zone: IrrigationZoneConfig): ZoneTrim {
  t.savedMin = Math.max(0, t.scheduledMin - t.trimmedMin);
  t.savedPct = t.scheduledMin > 0 ? t.savedMin / t.scheduledMin : 0;
  t.volumeL = volumeLiters(zone, t.trimmedMin);
  return t;
}

/** Aggregate a day's "saved vs plan %" across many zone trims (minutes-weighted). */
export function daySavedPct(trims: ZoneTrim[]): number {
  const scheduled = trims.reduce((s, t) => s + t.scheduledMin, 0);
  const saved = trims.reduce((s, t) => s + t.savedMin, 0);
  return scheduled > 0 ? saved / scheduled : 0;
}

/** Advance a zone's running soil-water deficit by one day (mm): add ETc, subtract effective
 *  rain + applied irrigation depth, clamp ≥ 0. Pure — the coordinator persists the result. */
export function advanceDeficit(
  zone: IrrigationZoneConfig,
  currentMm: number,
  weather: { et0Mm: number; precipMm: number },
  appliedMinutes: number,
): number {
  const etc = etcMm(zone, weather.et0Mm);
  const rain = effectiveRainMm(weather.precipMm);
  const appliedMm = appliedMinutes * precipRateMmPerMin(zone);
  return Math.max(0, currentMm + etc - rain - appliedMm);
}
