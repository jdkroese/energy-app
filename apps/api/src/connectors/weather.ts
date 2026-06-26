// Open-Meteo forecast (free, no API key) for the Jávea site.
// Used by /api/brain/plan to drive the solar + thermal forecast.
// Best-effort: callers must tolerate a null result (never 502 the whole request).

import { weatherCoords } from '../runtime-config';

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
      };
    };
    const h = json.hourly;
    if (!h?.shortwave_radiation || !h?.temperature_2m) return null;

    // forecast_days=2 returns 48 hourly entries; today is the first 24 (0..23).
    const shortwaveRadiation = h.shortwave_radiation.slice(0, 24).map((v) => v ?? 0);
    const temperature = h.temperature_2m.slice(0, 24).map((v) => v ?? 0);
    const cloudCover = (h.cloudcover ?? []).slice(0, 24).map((v) => Math.max(0, Math.min(100, v ?? 0)));
    const directRadiation = (h.direct_radiation ?? []).slice(0, 24).map((v) => Math.max(0, v ?? 0));
    const diffuseRadiation = (h.diffuse_radiation ?? []).slice(0, 24).map((v) => Math.max(0, v ?? 0));
    const sunshineDuration = (h.sunshine_duration ?? []).slice(0, 24).map((v) => Math.max(0, Math.min(3600, v ?? 0)));
    // Pad to 24 if short.
    while (shortwaveRadiation.length < 24) shortwaveRadiation.push(0);
    while (temperature.length < 24) temperature.push(temperature[temperature.length - 1] ?? 18);
    while (cloudCover.length < 24) cloudCover.push(0);
    while (directRadiation.length < 24) directRadiation.push(0);
    while (diffuseRadiation.length < 24) diffuseRadiation.push(0);
    while (sunshineDuration.length < 24) sunshineDuration.push(0);

    return {
      ts: new Date().toISOString(),
      shortwaveRadiation,
      temperature,
      cloudCover,
      directRadiation,
      diffuseRadiation,
      sunshineDuration,
    };
  } catch {
    return null;
  }
}
