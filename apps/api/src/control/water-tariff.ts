// Water tariff + cost maths (docs/52 P3). Pure functions — no I/O, no store reads (the
// caller passes the tariff from store.get().water.tariff). Every default in store.ts's
// defaultWaterTariff() is a PLACEHOLDER, not a real AMJASA rate (docs/52 D5) — the UI
// must label cost figures derived from an un-confirmed tariff as estimates.

import type { WaterTariff } from '../store';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CostLine {
  label: string;
  m3: number;
  rateEurM3: number | null; // null for the flat service charge
  eur: number;
}

export interface CostBreakdown {
  lines: CostLine[];
  subtotalEur: number;
  ivaEur: number;
  totalEur: number;
}

/**
 * Full billed-period cost for `m3` consumed, broken into: fixed service charge, the
 * three consumption blocks (progressive — each m³ billed at the rate of the block it
 * falls in), sewerage, canon de saneamiento, then IVA on the subtotal.
 */
export function costFor(m3: number, tariff: WaterTariff): CostBreakdown {
  const lines: CostLine[] = [{ label: 'Fixed service charge', m3: 0, rateEurM3: null, eur: tariff.fixedEurMonth }];
  const clamped = Math.max(0, m3);
  let remaining = clamped;

  const b1 = Math.min(remaining, Math.max(0, tariff.block1.upToM3));
  if (b1 > 0) {
    lines.push({ label: `Block 1 (0–${tariff.block1.upToM3} m³)`, m3: b1, rateEurM3: tariff.block1.eurM3, eur: b1 * tariff.block1.eurM3 });
  }
  remaining -= b1;

  const b2Span = Math.max(0, tariff.block2.upToM3 - tariff.block1.upToM3);
  const b2 = Math.min(remaining, b2Span);
  if (b2 > 0) {
    lines.push({
      label: `Block 2 (${tariff.block1.upToM3}–${tariff.block2.upToM3} m³)`,
      m3: b2,
      rateEurM3: tariff.block2.eurM3,
      eur: b2 * tariff.block2.eurM3,
    });
  }
  remaining -= b2;

  const b3 = Math.max(0, remaining);
  if (b3 > 0) {
    lines.push({ label: `Block 3 (> ${tariff.block2.upToM3} m³)`, m3: b3, rateEurM3: tariff.block3.eurM3, eur: b3 * tariff.block3.eurM3 });
  }

  if (clamped > 0) {
    lines.push({ label: 'Sewerage', m3: clamped, rateEurM3: tariff.sewerEurM3, eur: clamped * tariff.sewerEurM3 });
    lines.push({ label: 'Canon de saneamiento', m3: clamped, rateEurM3: tariff.canonEurM3, eur: clamped * tariff.canonEurM3 });
  }

  const subtotalEur = round2(lines.reduce((s, l) => s + l.eur, 0));
  const ivaEur = round2(subtotalEur * (tariff.ivaPct / 100));
  return { lines: lines.map((l) => ({ ...l, eur: round2(l.eur) })), subtotalEur, ivaEur, totalEur: round2(subtotalEur + ivaEur) };
}

/**
 * The €/m³ ONE MORE cubic metre costs at the current consumption level — priced at the
 * TOP applicable block (that is what the waste actually costs), plus sewerage + canon,
 * with IVA applied. Used to price unexplained/leak litres, not the average bill rate.
 */
export function marginalCostFor(currentM3: number, tariff: WaterTariff): number {
  const rate =
    currentM3 >= tariff.block2.upToM3
      ? tariff.block3.eurM3
      : currentM3 >= tariff.block1.upToM3
        ? tariff.block2.eurM3
        : tariff.block1.eurM3;
  const perM3 = rate + tariff.sewerEurM3 + tariff.canonEurM3;
  return round2(perM3 * (1 + tariff.ivaPct / 100));
}

/** Marginal cost per LITRE (marginalCostFor ÷ 1000) — convenience for pricing unexplained-litre totals directly. */
export function marginalCostForLitres(litres: number, currentM3: number, tariff: WaterTariff): number {
  return round2((marginalCostFor(currentM3, tariff) / 1000) * Math.max(0, litres));
}
