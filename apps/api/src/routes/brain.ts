import { config } from '../config';
import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import * as weather from '../connectors/weather';
import { bandCodesForDay, RATES, type Band } from '../tariff';
import * as store from '../store';
import type { ScenarioDef } from '../store';
import { weatherCoords } from '../runtime-config';
import {
  effectivePR,
  haurwitzGHI,
  madridDayOfYear,
  monthLabel,
  solarElevationDeg,
} from '../solar-model';

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Clamp a fractional hour to the 0..24 plot range. */
function clampH(h: number): number {
  return Math.max(0, Math.min(24, h));
}

function madridHour(d: Date): number {
  return (
    Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Madrid',
        hour: '2-digit',
        hour12: false,
      }).format(d),
    ) % 24
  );
}

/** Solar forecast (kW per hour) from Open-Meteo shortwave radiation, or a synthetic bell. */
function solarForecast(rad: number[] | null, pr: number): number[] {
  const kwp = config.site.solarKwp;
  if (rad && rad.length === 24) {
    // PV model: kW ≈ radiation(W/m²) / 1000 × kWp × learned performance ratio.
    return rad.map((w) => round(Math.max(0, (w / 1000) * kwp * pr), 2));
  }
  // Synthetic clear-day bell centred ~13:30 Madrid.
  return Array.from({ length: 24 }, (_, h) => {
    const x = (h - 13.5) / 3.6;
    const v = Math.exp(-0.5 * x * x) * kwp * (pr * 0.88);
    return round(Math.max(0, v), 2);
  });
}

/** Load forecast (kW per hour) for the all-electric house, thermally nudged by temp. */
function loadForecast(temp: number[] | null): number[] {
  // Base daily profile (kW) — morning + evening peaks, all-electric.
  const base = [
    0.6, 0.5, 0.5, 0.5, 0.5, 0.6, 0.9, 1.4, 1.6, 1.3, 1.1, 1.2, 1.3, 1.2, 1.1, 1.2, 1.4, 1.8,
    2.4, 2.6, 2.3, 1.8, 1.2, 0.8,
  ];
  return base.map((kw, h) => {
    let v = kw;
    if (temp && temp[h] !== undefined) {
      const t = temp[h];
      // Heating below 16°C, cooling above 26°C add HVAC load.
      if (t < 16) v += (16 - t) * 0.08;
      if (t > 26) v += (t - 26) * 0.1;
    }
    return round(v, 2);
  });
}

/**
 * Heuristic SoC trajectory + actions for the day.
 * Strategy (per docs/10 blueprint): charge from surplus solar midday, hold reserve,
 * discharge in P1 evening, pre-cool ahead of P1 if hot.
 */
function plan(
  solarKw: number[],
  loadKw: number[],
  bandCodes: number[],
  startSoc: number,
  reservePct: number,
  temp: number[] | null,
  scenario: ScenarioDef,
) {
  const capKwh = config.assets.sonnenUsableKwh + config.assets.teslaUsableKwh; // combined tank
  const maxKw = config.assets.sonnenMaxKw + config.assets.teslaMaxKw;
  const socPct: number[] = [];
  const actions: Array<{ h: number; startH: number; endH: number; icon: string; tone: string; title: string; why: string }> = [];

  // Scenario bias: a self/independence-leaning scenario discharges the battery
  // more eagerly in cheaper bands (P2/P3) to lean less on the grid; a savings-
  // leaning one keeps more in reserve for the P1 jackpot. Range ~0.7..1.3.
  const selfBias = 1 + (scenario.weights.self + scenario.weights.indep - 0.5) * 0.6;
  const p2Frac = Math.max(0.3, Math.min(1, 0.7 * selfBias));
  const p3Frac = Math.max(0.05, Math.min(0.6, 0.2 * selfBias));

  let soc = startSoc; // %
  let p1AvoidedKwh = 0;
  let savedEur = 0;
  let importedKwh = 0;
  let consumedKwh = 0;
  let freeClimatizationKwh = 0;

  for (let h = 0; h < 24; h++) {
    const surplus = solarKw[h] - loadKw[h]; // kW net for the hour (≈ kWh over 1h)
    const band = bandCodes[h]; // 0=P3 1=P2 2=P1
    consumedKwh += loadKw[h];

    // Free climatization: the HVAC slice of the load that solar surplus can cover
    // during a pre-cool/heat window. HVAC demand mirrors loadForecast's thermal
    // nudge (heating <16 °C, cooling >26 °C). Counted only when there's surplus
    // PV available to run it for free.
    if (temp && temp[h] !== undefined) {
      const t = temp[h];
      let hvacKw = 0;
      if (t < 16) hvacKw = (16 - t) * 0.08;
      if (t > 26) hvacKw = (t - 26) * 0.1;
      if (hvacKw > 0 && surplus > 0) {
        freeClimatizationKwh += Math.min(hvacKw, surplus);
      }
    }

    let deltaKwh = 0; // + charge / - discharge battery
    if (surplus > 0) {
      // Solar surplus → charge battery (up to power + headroom).
      const headroomKwh = ((100 - soc) / 100) * capKwh;
      deltaKwh = Math.min(surplus, maxKw, headroomKwh);
      const gridImport = Math.max(0, loadKw[h] - solarKw[h]); // ~0 here
      importedKwh += gridImport;
    } else {
      const deficit = -surplus; // kW we still need
      const availKwh = Math.max(0, ((soc - reservePct) / 100) * capKwh);
      // Discharge harder in P1/P2, hold in P3 (cheap grid). Scenario biases P2/P3.
      let discharge = 0;
      if (band === 2) discharge = Math.min(deficit, maxKw, availKwh); // P1 evening
      else if (band === 1) discharge = Math.min(deficit * p2Frac, maxKw, availKwh);
      else discharge = Math.min(deficit * p3Frac, maxKw, availKwh);
      deltaKwh = -discharge;
      const gridImport = deficit - discharge;
      importedKwh += gridImport;
      if (band === 2) p1AvoidedKwh += discharge;
      // Saved = displaced grid energy × that band's rate.
      const rate = band === 2 ? RATES.P1 : band === 1 ? RATES.P2 : RATES.P3;
      savedEur += discharge * rate;
    }

    soc = Math.max(0, Math.min(100, soc + (deltaKwh / capKwh) * 100));
    socPct.push(Math.round(soc));
  }

  // Timed action markers — each is a duration window (startH..endH) the timeline
  // draws as a bar; `h` keeps the legacy point marker (window start).
  const firstP1 = bandCodes.findIndex((b) => b === 2);
  // Last hour where surplus solar exceeds load → end of the charge window.
  const lastP1 = bandCodes.length - 1 - [...bandCodes].reverse().findIndex((b) => b === 2);
  const peakSolarH = solarKw.indexOf(Math.max(...solarKw));
  const surplusHours = solarKw.map((kw, h) => (kw - loadKw[h] > 0.2 ? h : -1)).filter((h) => h >= 0);
  const chargeStart = surplusHours.length ? surplusHours[0] : Math.max(0, peakSolarH - 3);
  const chargeEnd = surplusHours.length ? surplusHours[surplusHours.length - 1] + 1 : Math.min(24, peakSolarH + 3);
  actions.push({
    h: peakSolarH,
    startH: chargeStart,
    endH: clampH(chargeEnd),
    icon: 'sun',
    tone: 'solar',
    title: 'Charge from surplus solar',
    why: 'Store midday PV instead of exporting near-worthless energy.',
  });
  if (temp && Math.max(...temp) > 26 && firstP1 > 1) {
    actions.push({
      h: firstP1 - 1,
      startH: clampH(firstP1 - 2),
      endH: firstP1,
      icon: 'snowflake',
      tone: 'home',
      title: 'Pre-cool the house',
      why: 'Cool on cheap power before the P1 peak so the A/C coasts through it.',
    });
  }
  if (firstP1 >= 0) {
    actions.push({
      h: firstP1,
      startH: firstP1,
      endH: clampH(lastP1 + 1),
      icon: 'battery-charging',
      tone: 'battery',
      title: 'Discharge through P1',
      why: `Cover the evening peak from battery — avoids €${RATES.P1.toFixed(4)}/kWh imports.`,
    });
  }
  actions.push({
    h: 0,
    startH: 0,
    endH: 24,
    icon: 'shield',
    tone: 'grid',
    title: `Hold ${reservePct}% reserve`,
    why: 'Keep a backup floor on the Tesla for outage resilience.',
  });
  actions.sort((a, b) => a.startH - b.startH || a.h - b.h);

  const selfSufficiencyPct =
    consumedKwh > 0
      ? Math.max(0, Math.min(100, Math.round((1 - importedKwh / consumedKwh) * 100)))
      : 0;

  return {
    socPct,
    actions,
    projected: {
      savedEur: round(savedEur, 2),
      selfSufficiencyPct,
      reservePct,
      p1AvoidedKwh: round(p1AvoidedKwh, 1),
      freeClimatizationKwh: round(freeClimatizationKwh, 1),
    },
  };
}

export async function getPlan(): Promise<unknown> {
  const now = new Date();
  const nowH = madridHour(now);

  const [wRes, tRes, sRes] = await Promise.allSettled([
    weather.getForecast(),
    tesla.getNormalized(),
    sonnen.getNormalized(),
  ]);

  const wf = wRes.status === 'fulfilled' ? wRes.value : null;
  const t = tRes.status === 'fulfilled' ? tRes.value : null;
  const s = sRes.status === 'fulfilled' ? sRes.value : null;

  const rad = wf?.shortwaveRadiation ?? null;
  const temp = wf?.temperature ?? null;

  // Learned roof performance ratio for this month (seeded at 0.82, sharpens with
  // measured days). Drives both the solar-kW forecast and the genKwh prediction.
  const { prEff, confidence, days, month } = effectivePR();

  const solarKw = solarForecast(rad, prEff);
  const loadKw = loadForecast(temp);
  const bandCodes = bandCodesForDay(now);

  // Active scenario drives the reserve floor + discharge bias.
  const state = store.get();
  const scenario = state.scenarios[state.activeScenario] ?? store.DEFAULT_SCENARIOS.balanced;

  // Combined starting SoC across both batteries (energy-weighted).
  const sonnenKwh = config.assets.sonnenUsableKwh;
  const teslaKwh = config.assets.teslaUsableKwh;
  const startSoc =
    s && t
      ? Math.round((s.soc * sonnenKwh + t.soc * teslaKwh) / (sonnenKwh + teslaKwh))
      : t?.soc ?? s?.soc ?? 50;
  // Honour the scenario's reserve. With dynReserve, never go below the device's
  // own configured reserve (so we keep at least the hardware floor).
  const deviceReserve = t?.reservePct ?? 20;
  const reservePct = scenario.dynReserve
    ? Math.max(scenario.reserve, deviceReserve)
    : scenario.reserve;

  const result = plan(solarKw, loadKw, bandCodes, startSoc, reservePct, temp, scenario);

  // Tariff rate array for the chart (0=P3,1=P2,2=P1 already from bandCodes).
  const tariff = bandCodes;

  // Hourly cloud cover (Open-Meteo, this site). The solar forecast above is
  // already cloud-attenuated (it derives from shortwave radiation); this just
  // surfaces the cloud signal explicitly so the UI can show it's accounted for.
  const cloudPct = (wf?.cloudCover ?? solarKw.map(() => 0)).map((v) => Math.round(v));
  const dayHours = solarKw.map((v, h) => (v > 0.05 ? h : -1)).filter((h) => h >= 0);
  const cloudAvgPct =
    wf && dayHours.length
      ? Math.round(dayHours.reduce((a, h) => a + (cloudPct[h] ?? 0), 0) / dayHours.length)
      : 0;

  // Sun intensity (% of clear-sky) per hour, from MEASURED shortwave radiation vs
  // the Haurwitz clear-sky GHI; 0 below the horizon. Falls back to a solar-shaped
  // proxy from solarKw when no live radiation is available.
  const doy = madridDayOfYear(now);
  const { lat } = weatherCoords();
  const kwp = config.site.solarKwp;
  const sunIntensity24 = Array.from({ length: 24 }, (_, h) => {
    const elev = solarElevationDeg(h, doy, lat);
    const ghiC = haurwitzGHI(elev);
    if (elev <= 0 || ghiC <= 0) return 0;
    const actual = rad ? rad[h] ?? 0 : (solarKw[h] / Math.max(0.01, kwp * prEff)) * 1000;
    return clamp(Math.round((actual / ghiC) * 100), 0, 100);
  });

  // Predicted generation per hour (kWh) = actualGHI/1000·kWp·PR_eff (≈ solarKw·1h).
  const genKwh24 = solarKw.map((kw) => round(kw, 1));
  // Predicted usage per hour (kWh) from the load forecast (loadKw integrated 1h).
  const usageKwh24 = loadKw.map((kw) => round(kw, 1));

  // Extend the per-hour series to 25 points (0..24) so the timeline curves close
  // cleanly at the right edge. The 25th point mirrors hour-0 wrap (≈ overnight).
  const ext = (a: number[]): number[] => [...a, a[0] ?? 0];
  const sunIntensityPct = ext(sunIntensity24);
  const genKwh = ext(genKwh24);
  const usageKwh = ext(usageKwh24);
  const solarKw25 = ext(solarKw);
  const loadKw25 = ext(loadKw);
  const socPct25 = [...result.socPct, result.socPct[0] ?? result.socPct[result.socPct.length - 1] ?? 0];

  // Why-now narrative based on the current band + current action.
  const bandName: Record<number, Band> = { 0: 'P3', 1: 'P2', 2: 'P1' };
  const curBand = bandName[bandCodes[nowH]];
  const whyNow = whyNowText(curBand, nowH, solarKw[nowH], result.projected.reservePct);

  return {
    ts: now.toISOString(),
    scenario: { id: state.activeScenario, name: scenario.name, reservePct },
    projected: result.projected,
    forecast: { solarKw: solarKw25, loadKw: loadKw25, cloudPct, sunIntensityPct, genKwh, usageKwh },
    model: { month: monthLabel(month), confidencePct: Math.round(confidence * 100), days },
    socPct: socPct25,
    tariff,
    actions: result.actions,
    now: nowH,
    whyNow,
    weather: { source: wf ? 'live' : 'synthetic', cloudAvgPct },
  };
}

function whyNowText(
  band: Band,
  hour: number,
  solarNow: number,
  reservePct: number,
): { title: string; body: string } {
  if (band === 'P1') {
    return {
      title: 'Peak hours — lean on the battery',
      body: `It is P1 (€${RATES.P1.toFixed(4)}/kWh). The plan covers the load from stored energy and avoids grid imports, holding the ${reservePct}% reserve.`,
    };
  }
  if (solarNow > 1) {
    return {
      title: 'Banking solar surplus',
      body: 'Strong solar right now. Excess PV charges the batteries instead of being exported for near-zero credit — saving it for the evening peak.',
    };
  }
  if (band === 'P3') {
    return {
      title: 'Cheap valley window',
      body: `It is P3 (€${RATES.P3.toFixed(4)}/kWh). Grid is cheap, so the plan preserves battery charge for the upcoming peak rather than discharging now.`,
    };
  }
  return {
    title: 'Standard band — balancing',
    body: 'P2 pricing. The plan trims load from battery moderately while keeping headroom for the P1 evening peak.',
  };
}
