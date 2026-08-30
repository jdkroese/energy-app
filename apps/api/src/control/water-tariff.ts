// Water tariff + cost maths (docs/52 P3). Pure functions — no I/O, no store reads (the
// caller passes the tariff from store.get().water.tariff).
//
// Modelled on AMJASA's real bill (factura 3/1836657, 29/07/2026), whose structure is
// not the obvious one:
//
//   • Billing is BIMONTHLY. Both standing charges are per period, so a one-month
//     estimate carries only half of each.
//   • IVA applies to the SUPPLY (abastecimiento) portion ONLY. The EPSAR sanitation
//     portion is VAT-exempt — the bill states it as "Base exenta de IVA".
//   • Sanitation has its own standing charge on top of its volumetric rate.
//
// A model that applies one IVA rate to the whole bill and treats the standing charge as
// monthly is out by ~11% at low consumption. See water-tariff.test.ts, which reconciles
// this module against the real bill to the cent.

import type { WaterTariff } from '../store';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CostLine {
  label: string;
  m3: number;
  rateEurM3: number | null; // null for a standing charge
  eur: number;
  /** false for the EPSAR sanitation lines, which are VAT-exempt. */
  taxable: boolean;
}

export interface CostBreakdown {
  lines: CostLine[];
  /** Supply base — the only part IVA is charged on. */
  supplyBaseEur: number;
  ivaEur: number;
  /** EPSAR sanitation base — VAT-exempt. */
  sanitationBaseEur: number;
  /** supplyBaseEur + sanitationBaseEur (pre-IVA). */
  subtotalEur: number;
  totalEur: number;
}

/** Progressive supply charge for `m3` across the configured blocks. */
function supplyVolumeLines(m3: number, tariff: WaterTariff): CostLine[] {
  const lines: CostLine[] = [];
  const blocks = tariff.supplyBlocks.length > 0 ? tariff.supplyBlocks : [{ upToM3: null, eurM3: 0 }];
  let lower = 0;
  let remaining = Math.max(0, m3);

  for (const block of blocks) {
    if (remaining <= 0) break;
    const span = block.upToM3 === null ? Infinity : Math.max(0, block.upToM3 - lower);
    const take = Math.min(remaining, span);
    if (take > 0) {
      // A lone open-ended block is a flat rate — label it as such rather than "Block 1".
      const label =
        blocks.length === 1
          ? 'Water consumed'
          : block.upToM3 === null
            ? `Water consumed (above ${lower} m³)`
            : `Water consumed (${lower}–${block.upToM3} m³)`;
      lines.push({ label, m3: take, rateEurM3: block.eurM3, eur: take * block.eurM3, taxable: true });
      remaining -= take;
    }
    if (block.upToM3 === null) break;
    lower = block.upToM3;
  }
  return lines;
}

/**
 * Cost for `m3` consumed over `months` (default 1). Standing charges are pro-rated from
 * the billing period, so costFor(152, t, 2) reproduces a full AMJASA bimonthly bill and
 * costFor(x, t, 1) gives a fair one-month estimate.
 */
export function costFor(m3: number, tariff: WaterTariff, months = 1): CostBreakdown {
  const clamped = Math.max(0, m3);
  const periodMonths = tariff.periodMonths > 0 ? tariff.periodMonths : 1;
  const fixedShare = Math.max(0, months) / periodMonths;

  const lines: CostLine[] = [
    {
      label: 'Water standing charge',
      m3: 0,
      rateEurM3: null,
      eur: tariff.supplyFixedEurPeriod * fixedShare,
      taxable: true,
    },
    ...supplyVolumeLines(clamped, tariff),
    {
      label: 'Sanitation standing charge (EPSAR)',
      m3: 0,
      rateEurM3: null,
      eur: tariff.sanitationFixedEurPeriod * fixedShare,
      taxable: false,
    },
  ];

  if (clamped > 0) {
    lines.push({
      label: 'Sanitation (EPSAR)',
      m3: clamped,
      rateEurM3: tariff.sanitationEurM3,
      eur: clamped * tariff.sanitationEurM3,
      taxable: false,
    });
  }

  const supplyBaseEur = round2(lines.filter((l) => l.taxable).reduce((s, l) => s + l.eur, 0));
  const sanitationBaseEur = round2(lines.filter((l) => !l.taxable).reduce((s, l) => s + l.eur, 0));
  const ivaEur = round2(supplyBaseEur * (tariff.ivaPct / 100));

  return {
    lines: lines.map((l) => ({ ...l, eur: round2(l.eur) })),
    supplyBaseEur,
    ivaEur,
    sanitationBaseEur,
    subtotalEur: round2(supplyBaseEur + sanitationBaseEur),
    totalEur: round2(supplyBaseEur + ivaEur + sanitationBaseEur),
  };
}

/**
 * What ONE MORE cubic metre costs at the current consumption level — the top applicable
 * supply block with IVA, plus VAT-exempt sanitation. This is the rate to price a leak
 * at: wasted water is always billed at the margin, never at the average.
 */
function marginalRateExact(currentM3: number, tariff: WaterTariff): number {
  const blocks = tariff.supplyBlocks.length > 0 ? tariff.supplyBlocks : [{ upToM3: null, eurM3: 0 }];
  let rate = blocks[blocks.length - 1].eurM3;
  for (const block of blocks) {
    if (block.upToM3 === null || currentM3 < block.upToM3) {
      rate = block.eurM3;
      break;
    }
  }
  return rate * (1 + tariff.ivaPct / 100) + tariff.sanitationEurM3;
}

export function marginalCostFor(currentM3: number, tariff: WaterTariff): number {
  return round2(marginalRateExact(currentM3, tariff));
}

/**
 * Marginal cost per LITRE — convenience for pricing unexplained-litre totals directly.
 * Derived from the UNROUNDED rate: rounding to cents first and then multiplying by a
 * large litre count compounds the rounding error (it drifts a cent per ~900 L).
 */
export function marginalCostForLitres(litres: number, currentM3: number, tariff: WaterTariff): number {
  return round2((marginalRateExact(currentM3, tariff) / 1000) * Math.max(0, litres));
}
