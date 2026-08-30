// Open-Meteo forecast (free, no API key) for the Jávea site.
// Used by /api/brain/plan to drive the solar + thermal forecast.
// Best-effort: callers must tolerate a null result (never 502 the whole request).

import { weatherCoords } from "../runtime-config";

export interface WeatherForecast {
  /** ISO timestamp this forecast was fetched. */
  ts: string;
  /** 24 hourly values for *today* (Europe/Madrid), index = hour 0..23. */
  shortwaveRadiation: number[]; // W/m² (already cloud-attenuated by the model)
  temperature: number[]; // °C
  cloudCover: number[]; // % total cloud cover, hourly
  /** W/m² direct beam radiation (hourly, 0..23). */
  directRadiation: number[];
  /** W/m² diffuse radiation (hourly, 0..23). */
  diffuseRadiation: number[];
  /** Seconds of sunshine within the hour (0..3600), hourly 0..23. */
  sunshineDuration: number[];
  /** FAO-56 reference evapotranspiration ET₀ (mm), hourly 0..23. Drives the irrigation
   *  water-need model (ETc = ET₀ × Kc). May be all-zero if the model omits it. */
  et0: number[];
  /** Precipitation (mm) within the hour, hourly 0..23. */
  precipitation: number[];
  /** Precipitation probability (%), hourly 0..23. */
  precipitationProbability: number[];
  /** Relative humidity at 2 m (%), hourly 0..23. */
  relativeHumidity: number[];
  /** Wind speed at 10 m (km/h), hourly 0..23. */
  windSpeed: number[];
}

/** One day of the multi-day outlook (Open-Meteo `daily=`). Drives the irrigation forecast
 *  strip + the 2h rain-bypass decision (docs/39 §6). */
export interface DailyOutlook {
  /** Local date "YYYY-MM-DD" (Europe/Madrid). */
  date: string;
  /** Total precipitation for the day (mm). */
  precipMm: number;
  /** Max precipitation probability across the day (%). */
  precipProbabilityPct: number;
  /** FAO-56 reference ET₀ total for the day (mm). */
  et0Mm: number;
  /** Daily max temperature (°C). */
  tMaxC: number;
  /** Bright-sunshine hours for the day. */
  sunshineHours: number;
  /** Daily-mean relative humidity (%). */
  humidityPct: number;
  /** Daily-mean total cloud cover (%). */
  cloudCoverPct: number;
}

/** Mean of the 24 hourly values covering local day `i` (index i*24 … i*24+23), or 0. */
function dayMean(arr: number[] | undefined, i: number): number {
  if (!arr) return 0;
  const slice = arr
    .slice(i * 24, i * 24 + 24)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  if (slice.length === 0) return 0;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

/**
 * Fetch the daily outlook for the next `days` days at the site: precip sum + max probability,
 * ET₀, tMax, sunshine hours (daily), plus daily-mean humidity and cloud cover (derived from the
 * hourly series). Returns null on any failure so callers can degrade. Used by the irrigation
 * forecast strip and the 2h-ahead rain-bypass decision.
 */
export async function getDailyOutlook(
  days = 6,
): Promise<DailyOutlook[] | null> {
  try {
    const { lat, lon } = weatherCoords();
    const clamped = Math.max(1, Math.min(14, Math.round(days)));
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=precipitation_sum,precipitation_probability_max,et0_fao_evapotranspiration,temperature_2m_max,sunshine_duration` +
      `&hourly=relative_humidity_2m,cloudcover` +
      `&timezone=Europe%2FMadrid&forecast_days=${clamped}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      daily?: {
        time?: string[];
        precipitation_sum?: number[];
        precipitation_probability_max?: number[];
        et0_fao_evapotranspiration?: number[];
        temperature_2m_max?: number[];
        sunshine_duration?: number[];
      };
      hourly?: {
        relative_humidity_2m?: number[];
        cloudcover?: number[];
      };
    };
    const d = json.daily;
    if (!d?.time || !Array.isArray(d.time)) return null;
    const hum = json.hourly?.relative_humidity_2m;
    const cld = json.hourly?.cloudcover;
    return d.time.map((date, i) => ({
      date,
      precipMm: Math.max(0, d.precipitation_sum?.[i] ?? 0),
      precipProbabilityPct: Math.max(
        0,
        Math.min(100, d.precipitation_probability_max?.[i] ?? 0),
      ),
      et0Mm: Math.max(0, d.et0_fao_evapotranspiration?.[i] ?? 0),
      tMaxC: d.temperature_2m_max?.[i] ?? 0,
      // sunshine_duration is seconds/day → hours.
      sunshineHours: Math.max(0, (d.sunshine_duration?.[i] ?? 0) / 3600),
      humidityPct: Math.max(0, Math.min(100, dayMean(hum, i))),
      cloudCoverPct: Math.max(0, Math.min(100, dayMean(cld, i))),
    }));
  } catch {
    return null;
  }
}

/**
 * Fetch today's hourly shortwave_radiation + temperature_2m (plus direct/diffuse
 * radiation + sunshine_duration) for the site. We request forecast_days=2 so the
 * planner has a full 24 h ahead regardless of the current hour, then slice the
 * first 24 (today). Returns null on any failure so the planner can fall back to a
 * synthetic curve.
 */
export async function getForecast(): Promise<WeatherForecast | null> {
  try {
    const { lat, lon } = weatherCoords();
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=shortwave_radiation,temperature_2m,cloudcover,direct_radiation,diffuse_radiation,sunshine_duration` +
      `,et0_fao_evapotranspiration,precipitation,precipitation_probability,relative_humidity_2m,wind_speed_10m` +
      `&timezone=Europe%2FMadrid&forecast_days=2`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      hourly?: {
        time?: string[];
        shortwave_radiation?: number[];
        temperature_2m?: number[];
        cloudcover?: number[];
        direct_radiation?: number[];
        diffuse_radiation?: number[];
        sunshine_duration?: number[];
        et0_fao_evapotranspiration?: number[];
        precipitation?: number[];
        precipitation_probability?: number[];
        relative_humidity_2m?: number[];
        wind_speed_10m?: number[];
      };
    };
    const h = json.hourly;
    if (!h?.shortwave_radiation || !h?.temperature_2m) return null;

    // forecast_days=2 returns 48 hourly entries; today is the first 24 (0..23).
    const shortwaveRadiation = h.shortwave_radiation
      .slice(0, 24)
      .map((v) => v ?? 0);
    const temperature = h.temperature_2m.slice(0, 24).map((v) => v ?? 0);
    const cloudCover = (h.cloudcover ?? [])
      .slice(0, 24)
      .map((v) => Math.max(0, Math.min(100, v ?? 0)));
    const directRadiation = (h.direct_radiation ?? [])
      .slice(0, 24)
      .map((v) => Math.max(0, v ?? 0));
    const diffuseRadiation = (h.diffuse_radiation ?? [])
      .slice(0, 24)
      .map((v) => Math.max(0, v ?? 0));
    const sunshineDuration = (h.sunshine_duration ?? [])
      .slice(0, 24)
      .map((v) => Math.max(0, Math.min(3600, v ?? 0)));
    const et0 = (h.et0_fao_evapotranspiration ?? [])
      .slice(0, 24)
      .map((v) => Math.max(0, v ?? 0));
    const precipitation = (h.precipitation ?? [])
      .slice(0, 24)
      .map((v) => Math.max(0, v ?? 0));
    const precipitationProbability = (h.precipitation_probability ?? [])
      .slice(0, 24)
      .map((v) => Math.max(0, Math.min(100, v ?? 0)));
    const relativeHumidity = (h.relative_humidity_2m ?? [])
      .slice(0, 24)
      .map((v) => Math.max(0, Math.min(100, v ?? 0)));
    const windSpeed = (h.wind_speed_10m ?? [])
      .slice(0, 24)
      .map((v) => Math.max(0, v ?? 0));
    // Pad to 24 if short.
    while (shortwaveRadiation.length < 24) shortwaveRadiation.push(0);
    while (temperature.length < 24)
      temperature.push(temperature[temperature.length - 1] ?? 18);
    while (cloudCover.length < 24) cloudCover.push(0);
    while (directRadiation.length < 24) directRadiation.push(0);
    while (diffuseRadiation.length < 24) diffuseRadiation.push(0);
    while (sunshineDuration.length < 24) sunshineDuration.push(0);
    while (et0.length < 24) et0.push(0);
    while (precipitation.length < 24) precipitation.push(0);
    while (precipitationProbability.length < 24)
      precipitationProbability.push(0);
    while (relativeHumidity.length < 24)
      relativeHumidity.push(
        relativeHumidity[relativeHumidity.length - 1] ?? 50,
      );
    while (windSpeed.length < 24) windSpeed.push(0);

    return {
      ts: new Date().toISOString(),
      shortwaveRadiation,
      temperature,
      cloudCover,
      directRadiation,
      diffuseRadiation,
      sunshineDuration,
      et0,
      precipitation,
      precipitationProbability,
      relativeHumidity,
      windSpeed,
    };
  } catch {
    return null;
  }
}

export interface CurrentConditions {
  /** ISO timestamp this reading was fetched. */
  ts: string;
  /** °C */
  temperatureC: number;
  /** km/h at 10 m */
  windSpeedKmh: number;
  /** Extras for the expanded weather panel; each independently nullable. */
  apparentC?: number | null;
  humidityPct?: number | null;
  cloudPct?: number | null;
  precipMm?: number | null;
  isDay?: boolean | null;
  weatherCode?: number | null;
}


/**
 * Fetch just the current-hour temperature + wind speed for the site — a cheap
 * single-value read for UI chrome (e.g. the TopBar weather pill), as opposed to
 * getForecast()'s full 24h hourly arrays. Returns null on any failure so callers
 * can fail soft (never show a fake reading).
 */
export async function getCurrentConditions(): Promise<CurrentConditions | null> {
  try {
    const { lat, lon } = weatherCoords();
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,wind_speed_10m,relative_humidity_2m,cloud_cover,precipitation,apparent_temperature,is_day,weather_code` +
      `&timezone=Europe%2FMadrid`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      current?: {
        temperature_2m?: number;
        wind_speed_10m?: number;
        relative_humidity_2m?: number;
        cloud_cover?: number;
        precipitation?: number;
        apparent_temperature?: number;
        is_day?: number;
        weather_code?: number;
      };
    };
    const c = json.current;
    if (typeof c?.temperature_2m !== "number" || typeof c?.wind_speed_10m !== "number") {
      return null;
    }
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      ts: new Date().toISOString(),
      temperatureC: c.temperature_2m,
      windSpeedKmh: Math.max(0, c.wind_speed_10m),
      // Extras for the expanded weather panel. Each is independently nullable —
      // Open-Meteo can drop a field, and a missing humidity must not blank the pill.
      apparentC: num(c.apparent_temperature),
      humidityPct: num(c.relative_humidity_2m),
      cloudPct: num(c.cloud_cover),
      precipMm: num(c.precipitation),
      isDay: c.is_day === undefined ? null : c.is_day === 1,
      weatherCode: num(c.weather_code),
    };
  } catch {
    return null;
  }
}
