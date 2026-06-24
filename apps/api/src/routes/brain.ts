import { config } from '../config';
import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import * as weather from '../connectors/weather';
import { bandCodesForDay, RATES, type Band } from '../tariff';

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
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
function solarForecast(rad: number[] | null): number[] {
  const kwp = config.site.solarKwp;
  if (rad && rad.length === 24) {
    // Rough PV model: kW ≈ radiation(W/m²) / 1000 × kWp × performance ratio.
    const pr = 0.82;
    return rad.map((w) => round(Math.max(0, (w / 1000) * kwp * pr), 2));
  }
  // Synthetic clear-day bell centred ~13:30 Madrid.
  return Array.from({ length: 24 }, (_, h) => {
    const x = (h - 13.5) / 3.6;
    const v = Math.exp(-0.5 * x * x) * kwp * 0.72;
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
) {
  const capKwh = config.assets.sonnenUsableKwh + config.assets.teslaUsableKwh; // combined tank
  const maxKw = config.assets.sonnenMaxKw + config.assets.teslaMaxKw;
  const socPct: number[] = [];
  const actions: Array<{ h: number; icon: string; tone: string; title: string; why: string }> = [];

  let soc = startSoc; // %
  let p1AvoidedKwh = 0;
  let savedEur = 0;
  let importedKwh = 0;
  let consumedKwh = 0;

  for (let h = 0; h < 24; h++) {
    const surplus = solarKw[h] - loadKw[h]; // kW net for the hour (≈ kWh over 1h)
    const band = bandCodes[h]; // 0=P3 1=P2 2=P1
    consumedKwh += loadKw[h];

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
      // Discharge harder in P1/P2, hold in P3 (cheap grid).
      let discharge = 0;
      if (band === 2) discharge = Math.min(deficit, maxKw, availKwh); // P1 evening
      else if (band === 1) discharge = Math.min(deficit * 0.7, maxKw, availKwh);
      else discharge = Math.min(deficit * 0.2, maxKw, availKwh);
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

  // Timed action markers.
  const firstP1 = bandCodes.findIndex((b) => b === 2);
  const peakSolarH = solarKw.indexOf(Math.max(...solarKw));
  actions.push({
    h: peakSolarH,
    icon: 'sun',
    tone: 'solar',
    title: 'Charge from surplus solar',
    why: 'Store midday PV instead of exporting near-worthless energy.',
  });
  if (temp && Math.max(...temp) > 26 && firstP1 > 1) {
    actions.push({
      h: firstP1 - 1,
      icon: 'snowflake',
      tone: 'home',
      title: 'Pre-cool the house',
      why: 'Cool on cheap power before the P1 peak so the A/C coasts through it.',
    });
  }
  if (firstP1 >= 0) {
    actions.push({
      h: firstP1,
      icon: 'battery-charging',
      tone: 'battery',
      title: 'Discharge through P1',
      why: `Cover the evening peak from battery — avoids €${RATES.P1.toFixed(4)}/kWh imports.`,
    });
  }
  actions.push({
    h: 0,
    icon: 'shield',
    tone: 'grid',
    title: `Hold ${reservePct}% reserve`,
    why: 'Keep a backup floor on the Tesla for outage resilience.',
  });
  actions.sort((a, b) => a.h - b.h);

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
  const solarKw = solarForecast(rad);
  const loadKw = loadForecast(temp);
  const bandCodes = bandCodesForDay(now);

  // Combined starting SoC across both batteries (energy-weighted).
  const sonnenKwh = config.assets.sonnenUsableKwh;
  const teslaKwh = config.assets.teslaUsableKwh;
  const startSoc =
    s && t
      ? Math.round((s.soc * sonnenKwh + t.soc * teslaKwh) / (sonnenKwh + teslaKwh))
      : t?.soc ?? s?.soc ?? 50;
  const reservePct = t?.reservePct ?? 20;

  const result = plan(solarKw, loadKw, bandCodes, startSoc, reservePct, temp);

  // Tariff rate array for the chart (0=P3,1=P2,2=P1 already from bandCodes).
  const tariff = bandCodes;

  // Why-now narrative based on the current band + current action.
  const bandName: Record<number, Band> = { 0: 'P3', 1: 'P2', 2: 'P1' };
  const curBand = bandName[bandCodes[nowH]];
  const whyNow = whyNowText(curBand, nowH, solarKw[nowH], result.projected.reservePct);

  return {
    ts: now.toISOString(),
    projected: result.projected,
    forecast: { solarKw, loadKw },
    socPct: result.socPct,
    tariff,
    actions: result.actions,
    now: nowH,
    whyNow,
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
