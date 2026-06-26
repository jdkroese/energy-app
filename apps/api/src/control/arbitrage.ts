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

/** P1−P3 spread (€/kWh) for the configured peak/valley bands. */
export function arbitrageSpreadEur(params: TariffArbitrageParams): number {
  return RATES[params.peakBand] - RATES[params.valleyBand];
}

/**
 * Compute the arbitrage plan for a calendar day from the hourly forecasts + tariff bands.
 *
 * @param solarKw   24 hourly forecast PV (kW ≈ kWh over the hour)
 * @param loadKw    24 hourly forecast house load (kW ≈ kWh)
 * @param bandCodes 24 hourly band codes (0=P3 valley, 1=P2, 2=P1 peak)
 * @param startSoc  combined battery SoC now (%)
 * @param capKwh    combined usable battery capacity (kWh)
 * @param maxKw     combined battery max power (kW) for the solar charge/discharge sim
 * @param params    rule params (target ceiling, floor, spread, valley/peak bands, …)
 */
export function planArbitrage(
  solarKw: number[],
  loadKw: number[],
  bandCodes: number[],
  startSoc: number,
  capKwh: number,
  maxKw: number,
  params: TariffArbitrageParams,
): ArbitragePlan {
  const peakCode = params.peakBand === 'P1' ? 2 : params.peakBand === 'P2' ? 1 : 0;
  const valleyCode = params.valleyBand === 'P3' ? 0 : params.valleyBand === 'P2' ? 1 : 2;
  const floor = clampPct(params.dischargeFloorPct);
  const ceiling = clampPct(params.peakTargetSocPct);

  // Baseline SoC trajectory: solar charges, house discharges (no grid-charge), so we can
  // see where SoC would naturally be at the start of the peak and through it.
  const baseSoc: number[] = [];
  {
    let soc = startSoc;
    for (let h = 0; h < 24; h++) {
      const net = solarKw[h] - loadKw[h]; // + charge / − discharge (kWh over the hour)
      const deltaKwh =
        net >= 0
          ? Math.min(net, maxKw, ((100 - soc) / 100) * capKwh)
          : -Math.min(-net, maxKw, Math.max(0, ((soc - floor) / 100) * capKwh));
      soc = clampPct(soc + (deltaKwh / capKwh) * 100);
      baseSoc.push(soc);
    }
  }

  // The NEXT peak window (first run of peak-band hours). We plan the upcoming peak only.
  const firstPeakH = bandCodes.findIndex((b) => b === peakCode);
  const spread = arbitrageSpreadEur(params);
  const inactive = (reason: string): ArbitragePlan => ({
    active: false,
    targetSocPct: ceiling,
    valleyBuyKwh: 0,
    peakDeficitKwh: 0,
    moves: [],
    socPct: baseSoc.map((v) => Math.round(v)),
    reason,
  });

  if (spread < params.minSpreadEur) {
    return inactive(
      `spread €${spread.toFixed(4)} < min €${params.minSpreadEur.toFixed(2)} — arbitrage not worthwhile`,
    );
  }
  if (firstPeakH < 0) return inactive(`no ${params.peakBand} peak today — nothing to arbitrage`);

  // End of that contiguous peak run.
  let lastPeakH = firstPeakH;
  while (lastPeakH + 1 < 24 && bandCodes[lastPeakH + 1] === peakCode) lastPeakH++;

  // Peak deficit (kWh) the battery must carry = Σ over the peak hours of (load − solar)+.
  let peakDeficitKwh = 0;
  for (let h = firstPeakH; h <= lastPeakH; h++) {
    peakDeficitKwh += Math.max(0, loadKw[h] - solarKw[h]);
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

  // Valley hours BEFORE the peak, cheapest-first (all valley-band hours share a price, so
  // order by closeness to the peak is irrelevant for cost — charge in the latest valley hours
  // before the peak so the energy is freshest, minimising standing losses).
  const valleyHours: number[] = [];
  for (let h = 0; h < firstPeakH; h++) if (bandCodes[h] === valleyCode) valleyHours.push(h);
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

  const active = valleyBuyKwh > 0.05 || peakDeficitKwh > 0.05;
  const reason = active
    ? `target ${Math.round(targetSocPct)}% before ${params.peakBand}; buy ${valleyBuyKwh.toFixed(1)} kWh in ${params.valleyBand} (solar leaves SoC ~${Math.round(socAtPeakStart)}%), discharge ${peakDeficitKwh.toFixed(1)} kWh through peak to ${Math.round(floor)}%`
    : `solar covers the peak (SoC ~${Math.round(socAtPeakStart)}% ≥ target ${Math.round(targetSocPct)}%) — no pre-buy needed`;

  return {
    active,
    targetSocPct,
    valleyBuyKwh: Math.round(valleyBuyKwh * 10) / 10,
    peakDeficitKwh: Math.round(peakDeficitKwh * 10) / 10,
    moves,
    socPct: socPct.map((v) => Math.round(v)),
    reason,
  };
}
