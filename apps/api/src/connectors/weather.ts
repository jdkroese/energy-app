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
}

/**
 * Fetch today's hourly shortwave_radiation + temperature_2m for the site.
 * Returns null on any failure so the planner can fall back to a synthetic curve.
 */
export async function getForecast(): Promise<WeatherForecast | null> {
  try {
    const { lat, lon } = weatherCoords();
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=shortwave_radiation,temperature_2m,cloudcover&timezone=Europe%2FMadrid&forecast_days=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      hourly?: {
        time?: string[];
        shortwave_radiation?: number[];
        temperature_2m?: number[];
        cloudcover?: number[];
      };
    };
    const h = json.hourly;
    if (!h?.shortwave_radiation || !h?.temperature_2m) return null;

    // Open-Meteo returns 24 hourly entries for forecast_days=1, indexed 0..23.
    const shortwaveRadiation = h.shortwave_radiation.slice(0, 24).map((v) => v ?? 0);
    const temperature = h.temperature_2m.slice(0, 24).map((v) => v ?? 0);
    const cloudCover = (h.cloudcover ?? []).slice(0, 24).map((v) => Math.max(0, Math.min(100, v ?? 0)));
    // Pad to 24 if short.
    while (shortwaveRadiation.length < 24) shortwaveRadiation.push(0);
    while (temperature.length < 24) temperature.push(temperature[temperature.length - 1] ?? 18);
    while (cloudCover.length < 24) cloudCover.push(0);

    return {
      ts: new Date().toISOString(),
      shortwaveRadiation,
      temperature,
      cloudCover,
    };
  } catch {
    return null;
  }
}
