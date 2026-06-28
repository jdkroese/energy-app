// Versioned pricing config for invoice modelling/reconciliation.
//
// Spain 2.0TD on the FREE market (comercializadora ADX Renovables). The real bills
// reveal terms our live `tariff.ts` RATES approximation never modelled: a per-band
// power term (€/kW/day, NOT a flat monthly constant), per-band export compensation
// (excedentes) whose rates move month-to-month, the electricity tax (IEE), a meter
// rental, the Bono Social financing levy, and 21% IVA.
//
// Each entry is stamped with `validFrom` (the billing period start it first applies
// to) so a historical invoice is modelled with the rates that actually applied then.
// `pricingFor(periodStart)` picks the newest entry whose validFrom <= periodStart.
//
// These values are SEEDED from the 4 real ADX invoices (docs/30). `tariff.ts` RATES /
// bandHourWeights are left untouched — they drive the existing Reports approximation.

import type { Band } from '../tariff';

/** How the electricity tax (Impuesto Especial sobre la Electricidad, IEE) is computed.
 *  The bills show two regimes: a percentage of the energy+power subtotal, with a
 *  per-MWh floor (1 €/MWh) applied when the percentage would fall below it. The
 *  percentage itself has varied (a temporary 0.5% relief vs the standard 5.11269632%). */
export interface IeeConfig {
  /** Fraction of the subtotal (e.g. 0.0511269632 standard, 0.005 during the relief). */
  pct: number;
  /** Floor in €/MWh of metered energy (Spain applies a 1 €/MWh minimum). 0 disables. */
  floorEurMwh: number;
}

export interface PricingConfig {
  /** Billing-period start (YYYY-MM-DD) from which this config applies. */
  validFrom: string;
  /** Optional human label (e.g. the source invoice number). */
  label?: string;
  /** Energy term €/kWh per band (`Término Energía Px`). */
  energy: Record<Band, number>;
  /** Power (capacity) term €/kW/day per contracted band (`Término de Potencia Px`). P3 has none. */
  powerEurKwDay: { P1: number; P2: number };
  /** Export compensation €/kWh per band (`Excedente del periodo n`). Moves month-to-month. */
  exportEurKwh: Record<Band, number>;
  /** Electricity tax regime. */
  iee: IeeConfig;
  /** Meter rental €/day (`Alquiler de equipos` / days). */
  meterRentalEurDay: number;
  /** Bono Social financing €/day (`Financiación Bono Social`). */
  bonoSocialEurDay: number;
  /** IVA fraction (0.21). */
  ivaPct: number;
}

/**
 * Seeded pricing versions, newest first. Seeded from the 4 real ADX invoices:
 *  - energy rates are stable across all four (P1 0.209285 / P2 0.130948 / P3 0.095709).
 *  - power €/kW/day stable (P1 0.077205 / P2 0.006165).
 *  - meter rental ≈ 0.0267 €/day (0.80€/30d ≈ 0.83€/31d).
 *  - bono social stable at 0.019121 €/day.
 *  - EXPORT rates change every month → each invoice's own rates are stored on the
 *    parsed record; these config values are a recent-month default for FORWARD modelling.
 *  - IEE regime changes month-to-month (0.5% relief vs 5.11269632% standard, 1 €/MWh floor).
 *    We default to the standard regime; the reconciliation prices the invoice's metered kWh
 *    with the config and shows the delta vs the billed IEE so a regime mismatch is explicit.
 */
export const PRICING_VERSIONS: PricingConfig[] = [
  {
    validFrom: '2026-04-30',
    label: 'ADX 2026-05/06 (260077750)',
    energy: { P1: 0.209285, P2: 0.130948, P3: 0.095709 },
    powerEurKwDay: { P1: 0.077205, P2: 0.006165 },
    // Most recent month's per-band export rates (260077750).
    exportEurKwh: { P1: 0.003801, P2: 0.028867, P3: 0.027001 },
    iee: { pct: 0.0511269632, floorEurMwh: 1 },
    meterRentalEurDay: 0.83 / 31,
    bonoSocialEurDay: 0.019121,
    ivaPct: 0.21,
  },
  {
    validFrom: '2026-01-01',
    label: 'ADX 2026-Q1 baseline',
    energy: { P1: 0.209285, P2: 0.130948, P3: 0.095709 },
    powerEurKwDay: { P1: 0.077205, P2: 0.006165 },
    exportEurKwh: { P1: 0.006025, P2: 0.027652, P3: 0.025221 },
    iee: { pct: 0.0511269632, floorEurMwh: 1 },
    meterRentalEurDay: 0.0267,
    bonoSocialEurDay: 0.019121,
    ivaPct: 0.21,
  },
];

/** Newest pricing version whose validFrom <= periodStart (falls back to the oldest). */
export function pricingFor(periodStart?: string | null): PricingConfig {
  const sorted = [...PRICING_VERSIONS].sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  if (periodStart) {
    const hit = sorted.find((p) => p.validFrom.localeCompare(periodStart) <= 0);
    if (hit) return hit;
  }
  return sorted[sorted.length - 1];
}
