// GET /api/weather/current — conditions + a short daily outlook for UI chrome (the
// TopBar weather pill and its expanded panel). Distinct from /api/brain/plan's use of
// getForecast(): that pulls full 24h hourly arrays for the solar/thermal model.
//
// The daily outlook reuses the irrigation coordinator's CACHED outlook, so hovering the
// pill costs no extra Open-Meteo calls — the same forecast already drives the irrigation
// rain-bypass decision.

import * as weather from '../connectors/weather';
import { getDailyOutlookCached } from '../control/irrigation-coordinator';

export interface WeatherDay {
  /** Local date "YYYY-MM-DD" (Europe/Madrid). */
  date: string;
  tMaxC: number;
  precipMm: number;
  precipProbabilityPct: number;
  sunshineHours: number;
  humidityPct: number;
  cloudPct: number;
}

export interface CurrentWeatherResponse {
  ts: string;
  /** null when the upstream fetch failed — callers must fail soft, never show a fake reading. */
  temperatureC: number | null;
  windSpeedKmh: number | null;
  apparentC: number | null;
  humidityPct: number | null;
  cloudPct: number | null;
  precipMm: number | null;
  isDay: boolean | null;
  /** WMO weather code, for choosing a glyph. null when unavailable. */
  weatherCode: number | null;
  /** Next few days, oldest first. Empty when the outlook fetch failed. */
  daily: WeatherDay[];
}

export async function getCurrentWeather(): Promise<CurrentWeatherResponse> {
  // Both are fail-soft and independent: a forecast outage must not blank the pill,
  // and a current-conditions outage must not hide the forecast.
  const [c, outlook] = await Promise.all([
    weather.getCurrentConditions().catch(() => null),
    getDailyOutlookCached().catch(() => null),
  ]);

  const daily: WeatherDay[] = (outlook ?? []).slice(0, 5).map((d) => ({
    date: d.date,
    tMaxC: d.tMaxC,
    precipMm: d.precipMm,
    precipProbabilityPct: d.precipProbabilityPct,
    sunshineHours: d.sunshineHours,
    humidityPct: d.humidityPct,
    cloudPct: d.cloudCoverPct,
  }));

  return {
    ts: c?.ts ?? new Date().toISOString(),
    temperatureC: c?.temperatureC ?? null,
    windSpeedKmh: c?.windSpeedKmh ?? null,
    apparentC: c?.apparentC ?? null,
    humidityPct: c?.humidityPct ?? null,
    cloudPct: c?.cloudPct ?? null,
    precipMm: c?.precipMm ?? null,
    isDay: c?.isDay ?? null,
    weatherCode: c?.weatherCode ?? null,
    daily,
  };
}
