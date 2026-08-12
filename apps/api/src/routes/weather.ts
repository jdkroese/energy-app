// GET /api/weather/current — cheap current-conditions read for UI chrome (the
// TopBar weather pill). Distinct from /api/brain/plan's use of getForecast():
// that pulls full 24h hourly arrays for the solar/thermal model, this is a
// single-value read so the pill doesn't pay for arrays it never renders.

import * as weather from '../connectors/weather';

export interface CurrentWeatherResponse {
  ts: string;
  /** null when the upstream fetch failed — callers must fail soft, never show a fake reading. */
  temperatureC: number | null;
  windSpeedKmh: number | null;
}

export async function getCurrentWeather(): Promise<CurrentWeatherResponse> {
  const c = await weather.getCurrentConditions();
  return {
    ts: c?.ts ?? new Date().toISOString(),
    temperatureC: c?.temperatureC ?? null,
    windSpeedKmh: c?.windSpeedKmh ?? null,
  };
}
