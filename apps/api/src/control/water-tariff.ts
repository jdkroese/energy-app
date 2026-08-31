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

import type { WaterTariff, WaterTariffBlock } from '../store';

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

/** The band a given total lands in (the "last m³ consumed" band). */
export function bandFor(m3: number, tariff: WaterTariff): { index: number; block: WaterTariffBlock } {
  const blocks = tariff.supplyBlocks.length > 0 ? tariff.supplyBlocks : [{ upToM3: null, eurM3: 0 }];
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.upToM3 === null || m3 <= b.upToM3) return { index: k, block: b };
  }
  return { index: blocks.length - 1, block: blocks[blocks.length - 1] };
}

/** Supply consumption lines, honouring the tariff's blockMode. */
function supplyVolumeLines(m3: number, tariff: WaterTariff): CostLine[] {
  const vol = Math.max(0, m3);
  if (vol <= 0) return [];
  const blocks = tariff.supplyBlocks.length > 0 ? tariff.supplyBlocks : [{ upToM3: null, eurM3: 0 }];

  // AMJASA: "Se facturarán todos los m³ al mismo precio que el último m³ consumido."
  if (tariff.blockMode === 'all-at-last') {
    const { block } = bandFor(vol, tariff);
    const label =
      block.upToM3 === null
        ? `Water consumed — all at the top band rate`
        : `Water consumed — all at the ≤${block.upToM3} m³ band rate`;
    return [{ label, m3: vol, rateEurM3: block.eurM3, eur: vol * block.eurM3, taxable: true }];
  }

  const lines: CostLine[] = [];
  let lower = 0;
  let remaining = vol;
  for (const block of blocks) {
    if (remaining <= 0) break;
    const span = block.upToM3 === null ? Infinity : Math.max(0, block.upToM3 - lower);
    const take = Math.min(remaining, span);
    if (take > 0) {
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
  const { block } = bandFor(currentM3, tariff);
  return block.eurM3 * (1 + tariff.ivaPct / 100) + tariff.sanitationEurM3;
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

export interface BandCliff {
  /** €/m³ of the band the current total sits in. */
  currentRateEurM3: number;
  /** m³ that must be shaved to drop into the cheaper band below, or null if already lowest. */
  m3ToNextBandDown: number | null;
  /** What dropping a band would save over the WHOLE period's consumption, incl. IVA. */
  savingEur: number | null;
  /** Cost of the next m³ if it tips the total into a more expensive band, incl. IVA. */
  nextM3CostEur: number;
}

/**
 * Under 'all-at-last' banding the marginal m³ is not the interesting number — the CLIFF
 * is. Crossing a boundary re-prices every m³ consumed in the period, so one extra cubic
 * metre can cost tens of euros, and shaving a few can save far more than they contain.
 * This is the figure worth putting in front of someone deciding whether to fix a leak.
 */
export function bandCliff(m3: number, tariff: WaterTariff): BandCliff {
  const vol = Math.max(0, m3);
  const { index, block } = bandFor(vol, tariff);
  const blocks = tariff.supplyBlocks;
  const iva = 1 + tariff.ivaPct / 100;

  if (tariff.blockMode !== 'all-at-last') {
    return {
      currentRateEurM3: block.eurM3,
      m3ToNextBandDown: null,
      savingEur: null,
      nextM3CostEur: round2(block.eurM3 * iva + tariff.sanitationEurM3),
    };
  }

  // Dropping a band: get at or below the band below's upper bound.
  let m3ToNextBandDown: number | null = null;
  let savingEur: number | null = null;
  if (index > 0) {
    const below = blocks[index - 1];
    const target = below.upToM3 as number;
    m3ToNextBandDown = round2(Math.max(0, vol - target));
    // Everything re-prices at the lower rate, and the shaved m³ vanish entirely.
    savingEur = round2((vol * block.eurM3 - target * below.eurM3) * iva + (vol - target) * tariff.sanitationEurM3);
  }

  // Next m³: does it tip us into a dearer band?
  const after = bandFor(vol + 1, tariff);
  const nextM3CostEur = round2(
    ((vol + 1) * after.block.eurM3 - vol * block.eurM3) * iva + tariff.sanitationEurM3,
  );

  return { currentRateEurM3: block.eurM3, m3ToNextBandDown, savingEur, nextM3CostEur };
}
