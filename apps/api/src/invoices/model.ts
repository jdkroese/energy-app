// Invoice cost model + reconciliation.
//
// `modelInvoice()` reproduces the FULL ADX bill structure from metered per-band kWh +
// contracted power + days, priced with a versioned pricing config (so a historical month
// uses the rates that applied then). It models every line the bills reveal that our live
// `tariff.ts` approximation never did: per-band energy, per-band power term (€/kW/day),
// per-band excedentes, IEE (electricity tax), meter rental, Bono Social, IVA.
//
// `reconcile()` compares the BILLED figures (parsed off the PDF) against the MODELLED
// figures line-by-line, surfacing € and % deltas + a headline total delta — so the gaps
// (power-term split, per-band export, IEE/rental/IVA) are explicit, not silently absorbed.
//
// Phase 1 prices the invoice's OWN metered per-band kWh (validates the model). Phase 2+
// will reconcile the invoice's kWh against Datadis hourly-bucketed kWh.

import type { Band } from '../tariff';
import type { Invoice, } from './store';
import type { ParsedInvoice } from './parse';
import { pricingFor, type PricingConfig } from './pricing';

const BANDS: Band[] = ['P1', 'P2', 'P3'];

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Inputs to the cost model: metered per-band kWh + the contracted terms for a period. */
export interface ModelInput {
  /** Metered (billed-energy) per-band kWh. */
  kwh: Record<Band, number>;
  /** Per-band exported kWh (positive numbers; the model applies the export rate as a credit). */
  exportKwh?: Partial<Record<Band, number>>;
  /** Contracted power per band (kW). Defaults to 14/14. */
  contractedKw?: { P1: number; P2: number };
  /** Billing days. */
  days: number;
  /** Period start (YYYY-MM-DD or DD-MM-YYYY) — selects the pricing version. */
  periodStart?: string;
  /** Optional explicit pricing override (else resolved from periodStart). */
  pricing?: PricingConfig;
  /** Sum of any month-specific SSAA/Costes-del-Sistema settlement lines (€). These are
   *  pass-through true-ups our standing model can't predict; included so the modelled
   *  subtotal lines up with the bill when the owner has the figures from the PDF. */
  adjustmentsEur?: number;
}

export interface ModelledInvoice {
  pricing: PricingConfig;
  energy: { P1: number; P2: number; P3: number; total: number };
  power: { P1: number; P2: number; total: number };
  excedentes: { P1: number; P2: number; P3: number; total: number };
  /** Pass-through SSAA/Costes-del-Sistema settlement included in the subtotal (€). */
  adjustments: number;
  subtotal: number;
  iee: number;
  meterRental: number;
  bonoSocial: number;
  baseImponible: number;
  iva: number;
  total: number;
}

/** Normalise DD-MM-YYYY → YYYY-MM-DD for pricing lookup (passes through ISO unchanged). */
export function toIsoDate(d?: string | null): string | undefined {
  if (!d) return undefined;
  const dm = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d);
  if (dm) return `${dm[3]}-${dm[2]}-${dm[1]}`;
  return d;
}

/** Reproduce the full bill from metered kWh + contracted terms. */
export function modelInvoice(input: ModelInput): ModelledInvoice {
  const pricing = input.pricing ?? pricingFor(toIsoDate(input.periodStart));
  const kw = input.contractedKw ?? { P1: 14, P2: 14 };
  const days = input.days;

  const eP1 = (input.kwh.P1 ?? 0) * pricing.energy.P1;
  const eP2 = (input.kwh.P2 ?? 0) * pricing.energy.P2;
  const eP3 = (input.kwh.P3 ?? 0) * pricing.energy.P3;
  const energyTotal = eP1 + eP2 + eP3;

  const pP1 = kw.P1 * days * pricing.powerEurKwDay.P1;
  const pP2 = kw.P2 * days * pricing.powerEurKwDay.P2;
  const powerTotal = pP1 + pP2;

  // Excedentes are a CREDIT (negative). Applied per-band on exported kWh × export rate.
  const exc = input.exportKwh ?? {};
  const xP1 = -(exc.P1 ?? 0) * pricing.exportEurKwh.P1;
  const xP2 = -(exc.P2 ?? 0) * pricing.exportEurKwh.P2;
  const xP3 = -(exc.P3 ?? 0) * pricing.exportEurKwh.P3;
  const excTotal = xP1 + xP2 + xP3;

  const adjustments = input.adjustmentsEur ?? 0;
  const subtotal = energyTotal + powerTotal + excTotal + adjustments;

  // IEE: pct of subtotal, but never below the per-MWh floor on metered energy.
  const meteredKwh = (input.kwh.P1 ?? 0) + (input.kwh.P2 ?? 0) + (input.kwh.P3 ?? 0);
  const ieePctAmount = subtotal * pricing.iee.pct;
  const ieeFloor = (meteredKwh / 1000) * pricing.iee.floorEurMwh;
  const iee = Math.max(ieePctAmount, ieeFloor);

  const meterRental = pricing.meterRentalEurDay * days;
  const bonoSocial = pricing.bonoSocialEurDay * days;

  const baseImponible = subtotal + iee + meterRental + bonoSocial;
  const iva = baseImponible * pricing.ivaPct;
  const total = baseImponible + iva;

  return {
    pricing,
    energy: { P1: r2(eP1), P2: r2(eP2), P3: r2(eP3), total: r2(energyTotal) },
    power: { P1: r2(pP1), P2: r2(pP2), total: r2(powerTotal) },
    excedentes: { P1: r2(xP1), P2: r2(xP2), P3: r2(xP3), total: r2(excTotal) },
    adjustments: r2(adjustments),
    subtotal: r2(subtotal),
    iee: r2(iee),
    meterRental: r2(meterRental),
    bonoSocial: r2(bonoSocial),
    baseImponible: r2(baseImponible),
    iva: r2(iva),
    total: r2(total),
  };
}

/** One reconciliation row: a labelled line with billed €, modelled €, and deltas. */
export interface ReconcileRow {
  key: string;
  label: string;
  billed: number | null;
  modelled: number | null;
  /** modelled − billed (€); null when either side is missing. */
  deltaEur: number | null;
  /** deltaEur / |billed| × 100; null when billed is 0/missing. */
  deltaPct: number | null;
}

export interface Reconciliation {
  rows: ReconcileRow[];
  billedTotal: number | null;
  modelledTotal: number | null;
  totalDeltaEur: number | null;
  totalDeltaPct: number | null;
  pricingLabel?: string;
  notes: string[];
}

/** Merge `parsed` with any owner `edits` (edits win field-by-field). */
export function effectiveParsed(inv: Invoice): ParsedInvoice {
  return { ...inv.parsed, ...(inv.edits ?? {}) };
}

function row(key: string, label: string, billed: number | null, modelled: number | null): ReconcileRow {
  const deltaEur = billed != null && modelled != null ? r2(modelled - billed) : null;
  const deltaPct = deltaEur != null && billed != null && Math.abs(billed) > 1e-9 ? r2((deltaEur / Math.abs(billed)) * 100) : null;
  return { key, label, billed, modelled, deltaEur, deltaPct };
}

/**
 * Line-by-line billed-vs-modelled reconciliation. The modelled side prices the invoice's
 * OWN metered per-band kWh (the billed-energy term, which already nets self-consumption)
 * and its own exported kWh + days + contracted power with the period's pricing config.
 */
export function reconcile(inv: Invoice): Reconciliation {
  const p = effectiveParsed(inv);
  const notes: string[] = [];

  const kwh = {
    P1: p.energy?.P1?.kwh ?? 0,
    P2: p.energy?.P2?.kwh ?? 0,
    P3: p.energy?.P3?.kwh ?? 0,
  };
  const exportKwh = {
    // Excedentes kWh are stored negative on the parsed line; the model wants positive.
    P1: Math.abs(p.excedentes?.P1?.kwh ?? 0),
    P2: Math.abs(p.excedentes?.P2?.kwh ?? 0),
    P3: Math.abs(p.excedentes?.P3?.kwh ?? 0),
  };
  const days = p.days ?? p.power?.P1?.days ?? p.bonoSocial?.days ?? 30;
  const contractedKw = {
    P1: p.contractedKw?.P1 ?? 14,
    P2: p.contractedKw?.P2 ?? 14,
  };

  const adjustmentsEur = (p.adjustments ?? []).reduce((s, a) => s + (a.amount ?? 0), 0);
  const m = modelInvoice({ kwh, exportKwh, days, contractedKw, periodStart: p.periodStart, adjustmentsEur });

  // Billed line figures from the parsed PDF.
  const billedEnergy = sum(p.energy?.P1?.amount, p.energy?.P2?.amount, p.energy?.P3?.amount);
  const billedPower = sum(p.power?.P1?.amount, p.power?.P2?.amount);
  const billedExc = sum(p.excedentes?.P1?.amount, p.excedentes?.P2?.amount, p.excedentes?.P3?.amount);

  const rows: ReconcileRow[] = [
    row('energy.P1', 'Energy P1', p.energy?.P1?.amount ?? null, m.energy.P1),
    row('energy.P2', 'Energy P2', p.energy?.P2?.amount ?? null, m.energy.P2),
    row('energy.P3', 'Energy P3', p.energy?.P3?.amount ?? null, m.energy.P3),
    row('energy.total', 'Energy total', billedEnergy, m.energy.total),
    row('power.P1', 'Power term P1', p.power?.P1?.amount ?? null, m.power.P1),
    row('power.P2', 'Power term P2', p.power?.P2?.amount ?? null, m.power.P2),
    row('excedentes', 'Excedentes (export)', billedExc, m.excedentes.total),
    ...(adjustmentsEur !== 0 || (p.adjustments && p.adjustments.length)
      ? [row('adjustments', 'SSAA / system-cost settlement', r2(adjustmentsEur), m.adjustments)]
      : []),
    row('subtotal', 'Subtotal', p.subtotal ?? null, m.subtotal),
    row('iee', 'Electricity tax (IEE)', p.iee?.amount ?? null, m.iee),
    row('meterRental', 'Meter rental', p.meterRental ?? null, m.meterRental),
    row('bonoSocial', 'Bono Social', p.bonoSocial?.amount ?? null, m.bonoSocial),
    row('base', 'Base imponible', p.baseImponible ?? null, m.baseImponible),
    row('iva', 'IVA (21%)', p.iva ?? null, m.iva),
    row('total', 'TOTAL', p.total ?? null, m.total),
  ];

  // Surface known structural notes the reconciliation depends on.
  if (adjustmentsEur !== 0) {
    notes.push(
      `Includes ${r2(adjustmentsEur)}€ of retroactive SSAA/system-cost settlement — a month-specific true-up the standing model can't predict.`,
    );
  }
  if (p.iee && p.iee.mwh != null) notes.push('IEE billed at the per-MWh floor this month (1 €/MWh).');
  if (p.iee && p.iee.pct != null && Math.abs((p.iee.pct ?? 0) - m.pricing.iee.pct) > 1e-6) {
    notes.push(`IEE billed at ${(p.iee.pct * 100).toFixed(4)}% vs configured ${(m.pricing.iee.pct * 100).toFixed(4)}%.`);
  }
  const regTotal = sum(p.meterRegister?.P1, p.meterRegister?.P2, p.meterRegister?.P3);
  const billedKwh = kwh.P1 + kwh.P2 + kwh.P3;
  if (regTotal != null && billedKwh > 0) {
    const diff = regTotal - billedKwh;
    if (Math.abs(diff) > 0.5) {
      notes.push(
        `Register ${r2(regTotal)} kWh vs billed ${r2(billedKwh)} kWh (Δ ${r2(diff)} kWh from hourly self-consumption netting).`,
      );
    }
  }

  const billedTotal = p.total ?? null;
  const modelledTotal = m.total;
  const totalDeltaEur = billedTotal != null ? r2(modelledTotal - billedTotal) : null;
  const totalDeltaPct =
    totalDeltaEur != null && billedTotal != null && Math.abs(billedTotal) > 1e-9
      ? r2((totalDeltaEur / Math.abs(billedTotal)) * 100)
      : null;

  return {
    rows,
    billedTotal,
    modelledTotal,
    totalDeltaEur,
    totalDeltaPct,
    pricingLabel: m.pricing.label,
    notes,
  };
}

function sum(...vals: Array<number | undefined>): number | null {
  const present = vals.filter((v): v is number => typeof v === 'number');
  if (!present.length) return null;
  return r2(present.reduce((s, v) => s + v, 0));
}

/* ============================================================================
 * Phase 1.5 — "Other costs" decomposition (docs/30 §Phase 1.5).
 *
 * A pure, DERIVED split of an invoice total into four predictive groups, so the
 * non-metered part of the bill can be tracked + trended on its own and feed a
 * future total-invoice predictor. This is NOT a re-model: it reuses the billed
 * figures parsed off the PDF (the bill is the truth) and falls back to the
 * modelled line only when that billed line is absent. Group totals sum back to
 * the bill total (±rounding).
 *
 *   • metered energy (usage)   — energy term P1/P2/P3. The kWh-scaling, forecastable part.
 *   • fixed / capacity         — power term + meter rental + Bono Social. ~constant per day.
 *   • regulatory & tax         — IEE (electricity tax) + IVA (21% of base).
 *   • credits & settlements    — excedentes (export credit, negative) + SSAA/system-cost
 *                                adjustments (retroactive true-ups; flagged unpredictable).
 *
 * "Other costs" = the latter three groups (everything that is not metered energy).
 * ==========================================================================*/

/** One labelled sub-line inside a cost group (€, with provenance). */
export interface CostLine {
  key: string;
  label: string;
  eur: number;
  /** Where the figure came from: the parsed bill, or the model fallback. */
  source: 'billed' | 'modelled';
  /** Set on lines our standing model can't forecast (SSAA/system-cost true-ups). */
  unpredictable?: boolean;
}

/** A named group of cost lines + its € subtotal. */
export interface CostGroup {
  key: 'energy' | 'fixed' | 'regTax' | 'credits';
  label: string;
  eur: number;
  lines: CostLine[];
}

/** Full per-invoice cost decomposition (4 groups) + the energy/other split. */
export interface CostBreakdown {
  groups: CostGroup[];
  /** Metered-energy total (the forecastable part). */
  energyEur: number;
  /** Fixed/capacity total. */
  fixedEur: number;
  /** Regulatory & tax total. */
  regTaxEur: number;
  /** Credits & settlements total (typically ≤ 0; export credit is negative). */
  creditsEur: number;
  /** Everything that is NOT metered energy (= fixed + regTax + credits). */
  otherEur: number;
  /** The decomposition total (energy + other). Should match the bill total ±rounding. */
  total: number;
  /** Bill's own printed total, when present (for a sum-back sanity check). */
  billedTotal: number | null;
  /** energy / total × 100 (null when total ≈ 0). */
  energyPct: number | null;
  /** other / total × 100 (null when total ≈ 0). */
  otherPct: number | null;
  /** True when any line fell back to a modelled figure (no billed value parsed). */
  usedModelFallback: boolean;
  /** True when an unpredictable SSAA/system-cost settlement is present. */
  hasUnpredictable: boolean;
  notes: string[];
}

/**
 * Decompose an invoice into the 4 predictive cost groups. Prefers the BILLED
 * figure parsed off the PDF; uses the modelled line only as a fallback when the
 * billed line is missing. Pure + derived — no store fields, no side effects.
 */
export function costBreakdown(inv: Invoice): CostBreakdown {
  const p = effectiveParsed(inv);
  const m = modelInvoice({
    kwh: {
      P1: p.energy?.P1?.kwh ?? 0,
      P2: p.energy?.P2?.kwh ?? 0,
      P3: p.energy?.P3?.kwh ?? 0,
    },
    exportKwh: {
      P1: Math.abs(p.excedentes?.P1?.kwh ?? 0),
      P2: Math.abs(p.excedentes?.P2?.kwh ?? 0),
      P3: Math.abs(p.excedentes?.P3?.kwh ?? 0),
    },
    days: p.days ?? p.power?.P1?.days ?? p.bonoSocial?.days ?? 30,
    contractedKw: { P1: p.contractedKw?.P1 ?? 14, P2: p.contractedKw?.P2 ?? 14 },
    periodStart: p.periodStart,
    adjustmentsEur: (p.adjustments ?? []).reduce((s, a) => s + (a.amount ?? 0), 0),
  });

  let usedModelFallback = false;
  const notes: string[] = [];

  /** Pick the billed figure when present, else the modelled fallback. */
  const pick = (key: string, label: string, billed: number | null | undefined, modelled: number, opts?: { unpredictable?: boolean }): CostLine => {
    const hasBilled = typeof billed === 'number' && Number.isFinite(billed);
    if (!hasBilled) usedModelFallback = true;
    return {
      key,
      label,
      eur: r2(hasBilled ? (billed as number) : modelled),
      source: hasBilled ? 'billed' : 'modelled',
      ...(opts?.unpredictable ? { unpredictable: true } : {}),
    };
  };

  // ---- Group 1: metered energy (usage) — energy term per band. ----
  const energyLines: CostLine[] = [
    pick('energy.P1', 'Energy P1', p.energy?.P1?.amount, m.energy.P1),
    pick('energy.P2', 'Energy P2', p.energy?.P2?.amount, m.energy.P2),
    pick('energy.P3', 'Energy P3', p.energy?.P3?.amount, m.energy.P3),
  ];
  const energyEur = r2(energyLines.reduce((s, l) => s + l.eur, 0));

  // ---- Group 2: fixed / capacity — power term + meter rental + Bono Social. ----
  const fixedLines: CostLine[] = [
    pick('power.P1', 'Power term P1', p.power?.P1?.amount, m.power.P1),
    pick('power.P2', 'Power term P2', p.power?.P2?.amount, m.power.P2),
    pick('meterRental', 'Meter rental', p.meterRental, m.meterRental),
    pick('bonoSocial', 'Bono Social', p.bonoSocial?.amount, m.bonoSocial),
  ];
  const fixedEur = r2(fixedLines.reduce((s, l) => s + l.eur, 0));

  // ---- Group 3: regulatory & tax — IEE + IVA. ----
  const regTaxLines: CostLine[] = [
    pick('iee', 'Electricity tax (IEE)', p.iee?.amount, m.iee),
    pick('iva', 'IVA (21%)', p.iva, m.iva),
  ];
  const regTaxEur = r2(regTaxLines.reduce((s, l) => s + l.eur, 0));

  // ---- Group 4: credits & settlements — excedentes + SSAA adjustments. ----
  const billedExc = sum(p.excedentes?.P1?.amount, p.excedentes?.P2?.amount, p.excedentes?.P3?.amount);
  const adjBilled = (p.adjustments ?? []).reduce((s, a) => s + (a.amount ?? 0), 0);
  const hasAdjustments = (p.adjustments?.length ?? 0) > 0 || Math.abs(adjBilled) > 1e-9;
  const creditLines: CostLine[] = [
    pick('excedentes', 'Excedentes (export credit)', billedExc, m.excedentes.total),
  ];
  if (hasAdjustments) {
    creditLines.push(
      pick('adjustments', 'SSAA / system-cost settlement', adjBilled, m.adjustments, { unpredictable: true }),
    );
  }
  const creditsEur = r2(creditLines.reduce((s, l) => s + l.eur, 0));

  const otherEur = r2(fixedEur + regTaxEur + creditsEur);
  const total = r2(energyEur + otherEur);
  const billedTotal = typeof p.total === 'number' ? p.total : null;

  const hasUnpredictable = creditLines.some((l) => l.unpredictable);
  if (hasUnpredictable) {
    notes.push('Includes a retroactive SSAA/system-cost settlement — a month-specific true-up the standing model cannot predict.');
  }
  if (usedModelFallback) {
    notes.push('Some lines fell back to modelled figures (no billed value parsed) — values are estimates.');
  }
  if (billedTotal != null && Math.abs(total - billedTotal) > 0.05) {
    notes.push(`Decomposed total ${r2(total)}€ differs from the bill total ${r2(billedTotal)}€ by ${r2(total - billedTotal)}€.`);
  }

  const energyPct = Math.abs(total) > 1e-9 ? r2((energyEur / total) * 100) : null;
  const otherPct = Math.abs(total) > 1e-9 ? r2((otherEur / total) * 100) : null;

  return {
    groups: [
      { key: 'energy', label: 'Metered energy', eur: energyEur, lines: energyLines },
      { key: 'fixed', label: 'Fixed / capacity', eur: fixedEur, lines: fixedLines },
      { key: 'regTax', label: 'Regulatory & tax', eur: regTaxEur, lines: regTaxLines },
      { key: 'credits', label: 'Credits & settlements', eur: creditsEur, lines: creditLines },
    ],
    energyEur,
    fixedEur,
    regTaxEur,
    creditsEur,
    otherEur,
    total,
    billedTotal,
    energyPct,
    otherPct,
    usedModelFallback,
    hasUnpredictable,
    notes,
  };
}

/** The compact split carried on each list-summary row (docs/30 §Phase 1.5). */
export interface CostSplit {
  energyEur: number;
  fixedEur: number;
  regTaxEur: number;
  creditsEur: number;
  otherEur: number;
  total: number;
}

/** Derive the compact list split from the full breakdown (same source of truth). */
export function costSplit(inv: Invoice): CostSplit {
  const b = costBreakdown(inv);
  return {
    energyEur: b.energyEur,
    fixedEur: b.fixedEur,
    regTaxEur: b.regTaxEur,
    creditsEur: b.creditsEur,
    otherEur: b.otherEur,
    total: b.total,
  };
}

/* ============================================================================
 * Phase 3 prediction seam (DO NOT wire live forecasts here — docs/30 §Phase 3).
 *
 * The tracked other-costs are the predictor for a full next-invoice total:
 *
 *   predictedTotal = predictedEnergy(consumption forecast × energy rates)
 *                  + carried-forward fixed (last-known €/day × days)
 *                  + regulatory % applied on the resulting base (IEE + IVA)
 *                  + export credit(excedentes forecast, recent per-band avg)
 *                  + SSAA(±, flagged — unpredictable, treated as 0 ± a band)
 *
 * `predictInvoiceTotal()` below is a TYPED STUB only: it carries the last
 * invoice's fixed/regTax/credits straight through (€/day-scaled where days
 * change) so the contract + call-sites exist, but it does NOT consume any live
 * solar/load forecast yet. Phase 3 replaces the energy term with the arbitrage
 * planner's solarForecast/loadForecast and adds a confidence band.
 * ==========================================================================*/

export interface PredictInput {
  /** Forecast metered energy term for the cycle (€). Phase 3 supplies this from the forecast. */
  predictedEnergyEur: number;
  /** Days in the target cycle (fixed terms scale by €/day). */
  days: number;
  /** The most recent invoice to carry fixed/regulatory/credit structure forward from. */
  basis: Invoice;
}

export interface PredictedTotal {
  predictedEnergyEur: number;
  carriedFixedEur: number;
  regTaxEur: number;
  creditEur: number;
  /** SSAA/system-cost true-ups — unpredictable; carried as 0 with a flag. */
  ssaaEur: number;
  total: number;
  /** Always true for the stub — no live forecast wired yet (Phase 3). */
  isStub: boolean;
  notes: string[];
}

/**
 * STUB (Phase 3 seam): assemble a predicted total from a supplied energy figure +
 * the basis invoice's carried-forward other-costs. Fixed terms scale by €/day to the
 * target cycle length; regulatory/credit terms carry through; SSAA is dropped to 0
 * (unpredictable). NOT wired to live forecasts — see the comment above.
 */
export function predictInvoiceTotal(input: PredictInput): PredictedTotal {
  const b = costBreakdown(input.basis);
  const basisDays = effectiveParsed(input.basis).days ?? 30;
  const dayScale = basisDays > 0 ? input.days / basisDays : 1;
  const carriedFixedEur = r2(b.fixedEur * dayScale);
  // Drop the unpredictable SSAA piece out of the carried credits; carry only excedentes.
  const ssaaEur = 0;
  const creditEur = r2(b.creditsEur); // export credit carries; SSAA excluded above
  const total = r2(input.predictedEnergyEur + carriedFixedEur + b.regTaxEur + creditEur + ssaaEur);
  return {
    predictedEnergyEur: r2(input.predictedEnergyEur),
    carriedFixedEur,
    regTaxEur: b.regTaxEur,
    creditEur,
    ssaaEur,
    total,
    isStub: true,
    notes: ['Phase 3 stub: fixed/regulatory/credit carried from the last invoice; energy term is the supplied input. No live forecast wired.'],
  };
}
