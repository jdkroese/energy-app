// Tariff-arbitrage planner — PURE functions, no I/O, never throw. Shared by the
// brain plan (which surfaces the arbitrage as move-bars + a bent SoC trajectory on the
// Autopilot chart) and the battery coordinator (which decides the live valley-charge /
// peak-discharge stance each tick).
//
// Strategy (owner-approved, task #15): shift grid purchases from the P1 peak (expensive)
// to the P3 valley (cheap). When the day's forecast solar won't carry the house through
// the P1 peak, PRE-CHARGE the batteries from cheap valley grid up to a pre-peak target,
// then DISCHARGE through the peak down to a floor. SOLAR-FIRST: only buy the shortfall the
// forecast solar won't provide. The live execution self-corrects (if solar surges and we're
// exporting, the planned buy stands down and the existing #34 soak-export takes over).
//
// All energy is in kWh, power in kW, SoC in %. The combined battery "tank" is the Sonnen +
// Tesla usable capacity; the SoC here is the energy-weighted combined SoC the brain already
// reasons about. The per-tick guardrails (sonnenMaxW, SoC floor, import cap, Tesla reserve)
// are the FINAL authority on any real write — this module only plans/decides.

import { RATES, type Band } from '../tariff';
import type { TariffArbitrageParams } from '../store';

/** A planned arbitrage move surfaced on the daily plan (charge or discharge). */
export interface ArbitrageMove {
  kind: 'valley-charge' | 'peak-discharge';
  /** Fractional start/end hour (0..24) of the window. */
  startH: number;
  endH: number;
  /** Energy moved across the window (kWh): grid bought (charge) / battery drawn (discharge). */
  kwh: number;
}

export interface ArbitragePlan {
  /** True when the spread is met AND there's a worthwhile shortfall to pre-buy. */
  active: boolean;
  /** Pre-peak SoC target (%) the valley charge fills toward (capped at peakTargetSocPct). */
  targetSocPct: number;
  /** Valley grid energy to buy (kWh) — the shortfall solar won't cover. 0 when none needed. */
  valleyBuyKwh: number;
  /** The P1 peak deficit (kWh) the battery must carry (load − solar over the peak hours). */
  peakDeficitKwh: number;
  /** The CONFIDENT peak deficit (kWh): load − OPTIMISTIC solar over the peak (item 2). Drives
   *  the active/stand-down trigger — we only pre-buy when even an optimistic solar forecast
   *  still leaves a deficit. Sizing of the buy stays on the mean (peakDeficitKwh). */
  peakDeficitConfidentKwh: number;
  /** Horizon index (hour) of the NEXT peak's first hour at/after `fromHour`, or null when no
   *  upcoming peak in the horizon. For a 48h live horizon this can be >=24 (tomorrow). */
  nextPeakHour: number | null;
  /** Planned moves (may be empty when inactive). */
  moves: ArbitrageMove[];
  /** A SoC trajectory (%) per hour 0..23 with the arbitrage applied (for the chart). */
  socPct: number[];
  /** Human-readable reason (why active / why not). */
  reason: string;
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

// ---- >=70%-certainty solar gate (item 2) -----------------------------------
// We only pre-buy when we're CONFIDENT the next peak's forecast solar will fall short.
// Mechanism: inflate the forecast solar over the peak window to its optimistic percentile
// (z·sigma above the mean) and require a deficit to remain even then. A flat relative sigma
// models forecast spread as a fraction of the forecast value — documented constant below.

/** Relative 1σ spread of the solar forecast (fraction of the mean). A clear-sky-scaled PV
 *  forecast at this site is materially uncertain hour-to-hour (cloud timing, soiling, the
 *  learned-PR confidence); 0.30 (= ±30% at 1σ) is a deliberately conservative default that
 *  keeps the certainty gate from pre-buying on a forecast that could easily come good. */
export const SOLAR_REL_SIGMA = 0.3;

/**
 * Standard-normal quantile z(p) for a one-sided probability p (the inverse CDF / probit).
 * Moro/Acklam rational approximation — accurate to ~1e-9 over the central region, which is
 * far more than we need for a 50–95% confidence dial. Clamped to [0, 2.5]: p<=0.5 gives 0
 * (no inflation), and we never inflate beyond ~2.5σ even at p=0.95 (z(0.95)≈1.645 anyway).
 * Examples: z(0.70)≈0.524, z(0.80)≈0.842, z(0.90)≈1.282, z(0.95)≈1.645.
 */
export function normInv(p: number): number {
  if (!Number.isFinite(p) || p <= 0.5) return 0;
  if (p >= 1) return 2.5;
  // Acklam's coefficients.
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let z: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    z = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    z = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    z = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return Math.max(0, Math.min(2.5, z));
}

/** P1−P3 spread (€/kWh) for the configured peak/valley bands. */
export function arbitrageSpreadEur(params: TariffArbitrageParams): number {
  return RATES[params.peakBand] - RATES[params.valleyBand];
}

/**
 * Compute the arbitrage plan from the hourly forecasts + tariff bands. Works over a horizon
 * of arbitrary length H (24 for the calendar-day chart overlay; 48 for the live decision, so
 * an overnight valley can target TOMORROW's morning peak). It targets the NEXT peak at/after
 * `fromHour` — not the first peak of the calendar day.
 *
 * @param solarKw   H hourly forecast PV (kW ≈ kWh over the hour); index 0 = hour 0 of the horizon
 * @param loadKw    H hourly forecast house load (kW ≈ kWh)
 * @param bandCodes H hourly band codes (0=P3 valley, 1=P2, 2=P1 peak)
 * @param startSoc  combined battery SoC now (%) — seeds the sim at index 0
 * @param capKwh    combined usable battery capacity (kWh)
 * @param maxKw     combined battery max power (kW) for the solar charge/discharge sim
 * @param params    rule params (target ceiling, floor, spread, valley/peak bands, …)
 * @param fromHour  earliest horizon index to consider for the next peak (default 0). The live
 *                  coordinator passes the current local hour so "next peak" is the upcoming one;
 *                  the brain chart overlay passes 0 to keep whole-day behaviour.
 */
export function planArbitrage(
  solarKw: number[],
  loadKw: number[],
  bandCodes: number[],
  startSoc: number,
  capKwh: number,
  maxKw: number,
  params: TariffArbitrageParams,
  fromHour = 0,
): ArbitragePlan {
  const H = bandCodes.length; // horizon length (24 chart / 48 live)
  const peakCode = params.peakBand === 'P1' ? 2 : params.peakBand === 'P2' ? 1 : 0;
  const valleyCode = params.valleyBand === 'P3' ? 0 : params.valleyBand === 'P2' ? 1 : 2;
  const floor = clampPct(params.dischargeFloorPct);
  const ceiling = clampPct(params.peakTargetSocPct);
  const fromH = Math.max(0, Math.min(H, Math.floor(fromHour)));

  // Baseline SoC trajectory: solar charges, house discharges (no grid-charge), so we can
  // see where SoC would naturally be at the start of the peak and through it.
  const baseSoc: number[] = [];
  {
    let soc = startSoc;
    for (let h = 0; h < H; h++) {
      const net = solarKw[h] - loadKw[h]; // + charge / − discharge (kWh over the hour)
      const deltaKwh =
        net >= 0
          ? Math.min(net, maxKw, ((100 - soc) / 100) * capKwh)
          : -Math.min(-net, maxKw, Math.max(0, ((soc - floor) / 100) * capKwh));
      soc = clampPct(soc + (deltaKwh / capKwh) * 100);
      baseSoc.push(soc);
    }
  }

  // The NEXT peak window (first run of peak-band hours AT/AFTER fromH). We plan that peak only.
  let firstPeakH = -1;
  for (let h = fromH; h < H; h++) {
    if (bandCodes[h] === peakCode) { firstPeakH = h; break; }
  }
  const spread = arbitrageSpreadEur(params);
  const inactive = (reason: string, nextPeakHour: number | null = null): ArbitragePlan => ({
    active: false,
    targetSocPct: ceiling,
    valleyBuyKwh: 0,
    peakDeficitKwh: 0,
    peakDeficitConfidentKwh: 0,
    nextPeakHour,
    moves: [],
    socPct: baseSoc.slice(0, 24).map((v) => Math.round(v)),
    reason,
  });

  if (spread < params.minSpreadEur) {
    return inactive(
      `spread €${spread.toFixed(4)} < min €${params.minSpreadEur.toFixed(2)} — arbitrage not worthwhile`,
    );
  }
  if (firstPeakH < 0) return inactive(`no upcoming ${params.peakBand} peak — nothing to arbitrage`);

  // End of that contiguous peak run.
  let lastPeakH = firstPeakH;
  while (lastPeakH + 1 < H && bandCodes[lastPeakH + 1] === peakCode) lastPeakH++;

  // Peak deficit (kWh) the battery must carry = Σ over the peak hours of (load − solar)+ on
  // the MEAN forecast (drives buy SIZING). The CONFIDENT deficit (item 2) inflates solar to
  // its optimistic percentile (z·sigma above the mean) and drives the active/stand-down TRIGGER:
  // we only pre-buy when even optimistic solar still leaves a peak shortfall.
  // Default a missing/invalid confidence to 70 so an un-migrated persisted rule (no
  // solarConfidencePct yet) still gates sensibly and never renders "NaN%" on the chart.
  const confPct = Number.isFinite(params.solarConfidencePct) ? clampPct(params.solarConfidencePct) : 70;
  const z = normInv(confPct / 100);
  let peakDeficitKwh = 0;
  let peakDeficitConfidentKwh = 0;
  for (let h = firstPeakH; h <= lastPeakH; h++) {
    peakDeficitKwh += Math.max(0, loadKw[h] - solarKw[h]);
    const optimisticSolar = solarKw[h] * (1 + z * SOLAR_REL_SIGMA);
    peakDeficitConfidentKwh += Math.max(0, loadKw[h] - optimisticSolar);
  }

  // Pre-peak SoC target = floor + the SoC the deficit represents, capped at the ceiling.
  const deficitSocPct = (peakDeficitKwh / capKwh) * 100;
  const targetSocPct = clampPct(Math.min(ceiling, floor + deficitSocPct));

  // Projected SoC at the START of the peak (from the baseline sim) = what solar+load leave us.
  const socAtPeakStart = firstPeakH === 0 ? startSoc : baseSoc[firstPeakH - 1];

  // Shortfall (SoC) solar won't provide → energy to pre-buy in the valley. solarShortfallOnly
  // is implicit: socAtPeakStart already banks all forecast solar, so we only fill the gap.
  const shortfallSocPct = Math.max(0, targetSocPct - socAtPeakStart);
  let valleyBuyKwh = (shortfallSocPct / 100) * capKwh;
  if (!params.solarShortfallOnly) {
    // Buy the full gap to target ignoring solar (rarely used; conservative default keeps true).
    valleyBuyKwh = (Math.max(0, targetSocPct - startSoc) / 100) * capKwh;
  }

  // Valley hours between `fromH` and the peak, cheapest-first (all valley-band hours share a
  // price, so order by closeness to the peak is irrelevant for cost — charge in the latest
  // valley hours before the peak so the energy is freshest, minimising standing losses).
  // Starting at fromH (not 0) means overnight P3 hours before TOMORROW's 10:00 peak are the
  // selected window when the coordinator runs at night with a 48h horizon.
  const valleyHours: number[] = [];
  for (let h = fromH; h < firstPeakH; h++) if (bandCodes[h] === valleyCode) valleyHours.push(h);
  valleyHours.sort((a, b) => b - a); // latest valley hours first

  const moves: ArbitrageMove[] = [];
  if (valleyBuyKwh > 0.05 && valleyHours.length > 0) {
    // Lay the buy into valley hours, each capped at maxGridChargeKw (≈ kWh/h).
    let remaining = valleyBuyKwh;
    const perHourCap = Math.max(0, params.maxGridChargeKw);
    const used: number[] = [];
    for (const h of valleyHours) {
      if (remaining <= 0.0001) break;
      const take = Math.min(remaining, perHourCap);
      if (take > 0) {
        used.push(h);
        remaining -= take;
      }
    }
    if (used.length > 0) {
      used.sort((a, b) => a - b);
      const actuallyBought = valleyBuyKwh - Math.max(0, remaining);
      moves.push({
        kind: 'valley-charge',
        startH: used[0],
        endH: used[used.length - 1] + 1,
        kwh: Math.round(actuallyBought * 10) / 10,
      });
      valleyBuyKwh = actuallyBought; // reflect the capped reality
    } else {
      valleyBuyKwh = 0;
    }
  } else {
    valleyBuyKwh = 0;
  }

  if (peakDeficitKwh > 0.05) {
    moves.push({
      kind: 'peak-discharge',
      startH: firstPeakH,
      endH: lastPeakH + 1,
      kwh: Math.round(peakDeficitKwh * 10) / 10,
    });
  }

  // Build the arbitrage-applied SoC trajectory: same baseline sim, but inject the valley
  // grid-charge into the chosen hours (lifting SoC toward target) and ensure the peak draws
  // the battery down to cover the deficit (not below floor).
  const valleyChargeByHour = new Map<number, number>();
  const vCharge = moves.find((m) => m.kind === 'valley-charge');
  if (vCharge) {
    let remaining = valleyBuyKwh;
    for (let h = Math.floor(vCharge.startH); h < vCharge.endH && remaining > 0; h++) {
      if (bandCodes[h] !== valleyCode) continue;
      const take = Math.min(remaining, Math.max(0, params.maxGridChargeKw));
      valleyChargeByHour.set(h, take);
      remaining -= take;
    }
  }

  // SoC trajectory (chart): always 24 long. Sim over the first 24h of the horizon only — the
  // chart overlay is a calendar-day view; the live decision reads targets/deficits, not socPct.
  const socPct: number[] = [];
  {
    let soc = startSoc;
    for (let h = 0; h < 24; h++) {
      const net = solarKw[h] - loadKw[h];
      let deltaKwh =
        net >= 0
          ? Math.min(net, maxKw, ((100 - soc) / 100) * capKwh)
          : -Math.min(-net, maxKw, Math.max(0, ((soc - floor) / 100) * capKwh));
      // Inject valley grid-charge (adds to charge, respecting the 100% headroom).
      const gridCharge = valleyChargeByHour.get(h);
      if (gridCharge && gridCharge > 0) {
        const headroomKwh = ((100 - soc) / 100) * capKwh;
        deltaKwh = Math.min(headroomKwh, Math.max(deltaKwh, 0) + gridCharge);
      }
      soc = clampPct(soc + (deltaKwh / capKwh) * 100);
      socPct.push(soc);
    }
  }

  // ACTIVE GATE (item 2): only pre-buy when even the OPTIMISTIC solar forecast still leaves a
  // worthwhile peak deficit AND there's a worthwhile valley buy. When the confident deficit is
  // ~0, optimistic solar carries the peak — stand down (active=false) at the configured certainty.
  const confidentDeficit = peakDeficitConfidentKwh > 0.05;
  const active = confidentDeficit && (valleyBuyKwh > 0.05 || peakDeficitKwh > 0.05);
  const conf = Math.round(confPct);
  const reason = active
    ? `target ${Math.round(targetSocPct)}% before ${params.peakBand}; buy ${valleyBuyKwh.toFixed(1)} kWh in ${params.valleyBand} (solar leaves SoC ~${Math.round(socAtPeakStart)}%), discharge ${peakDeficitKwh.toFixed(1)} kWh through peak to ${Math.round(floor)}% — ≥${conf}% sure solar falls short`
    : !confidentDeficit
      ? `≥${conf}% chance solar carries the next ${params.peakBand} (optimistic-forecast deficit ~0) — standing down`
      : `solar covers the peak (SoC ~${Math.round(socAtPeakStart)}% ≥ target ${Math.round(targetSocPct)}%) — no pre-buy needed`;

  return {
    active,
    targetSocPct,
    valleyBuyKwh: Math.round(valleyBuyKwh * 10) / 10,
    peakDeficitKwh: Math.round(peakDeficitKwh * 10) / 10,
    peakDeficitConfidentKwh: Math.round(peakDeficitConfidentKwh * 10) / 10,
    nextPeakHour: firstPeakH,
    moves,
    socPct: socPct.map((v) => Math.round(v)),
    reason,
  };
}
