// Run with:
//   node --import tsx --test src/control/water-tariff.test.ts
// (Node built-in runner via tsx, NOT vitest.)
//
// The anchor for this suite is a REAL AMJASA bill — factura 3/1836657, period
// JULIO–AGOSTO 2026, meter P23EA822644C (15 mm), 152 m³. If costFor() ever stops
// reproducing that bill to the cent, the tariff model has drifted from reality.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { costFor, marginalCostFor, marginalCostForLitres, bandCliff, bandFor } from './water-tariff';
import { defaultWaterTariff, hydrateWaterForTest as hydrateForTest } from '../store';
import type { WaterTariff } from '../store';

const AMJASA = defaultWaterTariff();

/* ---- the real bill ------------------------------------------------------- */

test('reproduces AMJASA factura 3/1836657 (152 m³, bimonthly) to the cent', () => {
  const b = costFor(152, AMJASA, 2);
  // Abastecimiento: 27,34 standing + 152 × 1,86 = 282,72  ->  310,06
  assert.equal(b.supplyBaseEur, 310.06);
  // IVA 10% on the supply portion only
  assert.equal(b.ivaEur, 31.01);
  // EPSAR: 7,30 standing + 152 × 0,412 = 62,62  ->  69,92, VAT-exempt
  assert.equal(b.sanitationBaseEur, 69.92);
  // TOTAL FACTURA on the bill
  assert.equal(b.totalEur, 410.99);
});

test('IVA is charged on the supply portion ONLY — EPSAR sanitation is exempt', () => {
  const b = costFor(152, AMJASA, 2);
  // If IVA were (wrongly) applied to everything it would be 38,00, not 31,01.
  assert.equal(b.ivaEur, 31.01);
  assert.notEqual(b.ivaEur, Math.round((b.subtotalEur * 0.1 + Number.EPSILON) * 100) / 100);
  const exempt = b.lines.filter((l) => !l.taxable).map((l) => l.label);
  assert.deepEqual(exempt, ['Sanitation standing charge (EPSAR)', 'Sanitation (EPSAR)']);
});

test('standing charges are per BILLING PERIOD, so one month carries half of each', () => {
  const oneMonth = costFor(0, AMJASA, 1);
  const twoMonths = costFor(0, AMJASA, 2);
  // 27,34 + 7,30 across a 2-month period -> half each in a 1-month estimate.
  assert.equal(oneMonth.supplyBaseEur, 13.67);
  assert.equal(oneMonth.sanitationBaseEur, 3.65);
  assert.equal(twoMonths.supplyBaseEur, 27.34);
  assert.equal(twoMonths.sanitationBaseEur, 7.3);
});

test('zero consumption still bills the pro-rated standing charges, never negative', () => {
  const b = costFor(0, AMJASA, 1);
  assert.ok(b.totalEur > 0);
  assert.equal(b.totalEur, round2(13.67 * 1.1 + 3.65));
  const neg = costFor(-50, AMJASA, 1);
  assert.equal(neg.totalEur, b.totalEur, 'negative m³ is clamped to zero, not refunded');
});

/* ---- supply is a flat rate today, but blocks must still work -------------- */

test('AMJASA bills EVERY m³ at the band the total reaches, not progressively', () => {
  // "Se facturarán todos los m³ al mismo precio que el último m³ consumido."
  // Progressive would give 10×0,15 + 30×0,63 + 30×1,37 + 82×1,86 = 214,02.
  const vol = costFor(152, AMJASA, 2).lines.filter((l) => l.rateEurM3 !== null && l.taxable);
  assert.equal(vol.length, 1, 'all-at-last produces ONE consumption line, as the bill shows');
  assert.equal(vol[0].rateEurM3, 1.86);
  assert.equal(vol[0].eur, 282.72);
});

test('the band is chosen by the total, and re-prices everything below it', () => {
  assert.equal(bandFor(8, AMJASA).block.eurM3, 0.15);
  assert.equal(bandFor(25, AMJASA).block.eurM3, 0.63);
  assert.equal(bandFor(70, AMJASA).block.eurM3, 1.37);
  assert.equal(bandFor(71, AMJASA).block.eurM3, 1.86);
  // 25 m³ costs 25×0,63 — NOT 25×1,86, which a flat top-band config would charge.
  const vol25 = costFor(25, AMJASA, 2).lines.find((l) => l.rateEurM3 !== null && l.taxable);
  assert.equal(vol25?.eur, 15.75);
});

test('progressive mode still works when a tariff genuinely uses it', () => {
  const prog = { ...AMJASA, blockMode: 'progressive' as const };
  // 10×0,15 + 30×0,63 + 30×1,37 + 82×1,86 = 214,02
  const vol = costFor(152, prog, 2).lines.filter((l) => l.rateEurM3 !== null && l.taxable);
  assert.equal(vol.length, 4);
  assert.equal(round2(vol.reduce((a, l) => a + l.eur, 0)), 214.02);
});

test('crossing a band boundary costs far more than one m³ of water', () => {
  // 70 m³ = 95,90 ; 71 m³ = 132,06  -> one m³ costs 36,16 + IVA, plus sanitation
  const cliff = bandCliff(70, AMJASA);
  assert.equal(cliff.currentRateEurM3, 1.37);
  assert.equal(cliff.nextM3CostEur, round2((71 * 1.86 - 70 * 1.37) * 1.1 + 0.412));
  assert.ok(cliff.nextM3CostEur > 39, `expected a cliff, got ${cliff.nextM3CostEur}`);
});

test('cliff reports how much to shave to drop a band, and what it saves', () => {
  const cliff = bandCliff(152, AMJASA);
  assert.equal(cliff.currentRateEurM3, 1.86);
  // Down to 70 m³ to reach the 1,37 band
  assert.equal(cliff.m3ToNextBandDown, 82);
  // 152×1,86 - 70×1,37 = 282,72 - 95,90 = 186,82, +IVA, + the sanitation on 82 m³ saved
  assert.equal(cliff.savingEur, round2(186.82 * 1.1 + 82 * 0.412));
  assert.ok((cliff.savingEur as number) > 200);
});

test('the lowest band has no band below it to drop into', () => {
  const cliff = bandCliff(5, AMJASA);
  assert.equal(cliff.m3ToNextBandDown, null);
  assert.equal(cliff.savingEur, null);
});


test('progressive blocks bill each m³ at the rate of the block it falls in', () => {
  const blocked: WaterTariff = {
    ...AMJASA,
    blockMode: 'progressive',
    supplyBlocks: [
      { upToM3: 15, eurM3: 1 },
      { upToM3: 30, eurM3: 2 },
      { upToM3: null, eurM3: 3 },
    ],
  };
  // 40 m³ = 15×1 + 15×2 + 10×3 = 75
  const b = costFor(40, blocked, 2);
  const vol = b.lines.filter((l) => l.rateEurM3 !== null && l.taxable);
  assert.equal(vol.length, 3);
  assert.deepEqual(
    vol.map((l) => [l.m3, l.eur]),
    [
      [15, 15],
      [15, 30],
      [10, 30],
    ],
  );
});

test('consumption inside the first block does not touch later blocks', () => {
  const blocked: WaterTariff = {
    ...AMJASA,
    blockMode: 'progressive',
    supplyBlocks: [
      { upToM3: 15, eurM3: 1 },
      { upToM3: null, eurM3: 3 },
    ],
  };
  const vol = costFor(10, blocked, 2).lines.filter((l) => l.rateEurM3 !== null && l.taxable);
  assert.equal(vol.length, 1);
  assert.equal(vol[0].eur, 10);
});

/* ---- marginal cost: what a leak actually costs ---------------------------- */

test('marginal cost prices the next m³ at the top block + IVA, plus exempt sanitation', () => {
  // 1,86 × 1,10 = 2,046  +  0,412 exempt  =  2,458 €/m³
  assert.equal(marginalCostFor(152, AMJASA), 2.46);
});

test('marginal cost climbs with consumption when blocks are configured', () => {
  const blocked: WaterTariff = {
    ...AMJASA,
    sanitationEurM3: 0,
    ivaPct: 0,
    supplyBlocks: [
      { upToM3: 15, eurM3: 1 },
      { upToM3: 30, eurM3: 2 },
      { upToM3: null, eurM3: 3 },
    ],
  };
  assert.equal(marginalCostFor(5, blocked), 1);
  assert.equal(marginalCostFor(20, blocked), 2);
  assert.equal(marginalCostFor(50, blocked), 3);
});

test('a continuous 0.6 L/min leak is priced at the margin, not the average rate', () => {
  // 36 L/h × 24 h = 864 L/day at 2,458 €/m³ exact
  assert.equal(marginalCostForLitres(864, 152, AMJASA), 2.12);
  // ~30 days unattended = 25,920 L
  assert.equal(marginalCostForLitres(864 * 30, 152, AMJASA), 63.71);
});

test('per-litre pricing does not compound the cent-rounding of the per-m³ rate', () => {
  // The exact rate is 2,458 €/m³; rounding to 2,46 first and then scaling would
  // overstate a 25,920 L leak by ~5 cents.
  const exact = marginalCostForLitres(25_920, 152, AMJASA);
  const naive = round2((marginalCostFor(152, AMJASA) / 1000) * 25_920);
  assert.equal(exact, 63.71);
  assert.notEqual(exact, naive);
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ---- migration off the flat placeholder ---------------------------------- */

test('an install that stored the flat 1,86 band is migrated to the real band table', () => {
  // What PR #248 persisted before the banding rule was discovered.
  const stored = {
    // Deliberately the PRE-blockMode shape, as found on disk.
    periodMonths: 2,
    supplyFixedEurPeriod: 27.34,
    supplyBlocks: [{ upToM3: null, eurM3: 1.86 }],
    sanitationFixedEurPeriod: 7.3,
    sanitationEurM3: 0.412,
    ivaPct: 10,
  };
  const hydrated = hydrateForTest({ tariff: stored as unknown as WaterTariff });
  assert.equal(hydrated.tariff.blockMode, 'all-at-last');
  assert.equal(hydrated.tariff.supplyBlocks.length, 4);
  // 25 m3 must now cost 25 x 0,63 — not 25 x 1,86 as the stored flat band would charge.
  const vol = costFor(25, hydrated.tariff, 2).lines.find((l) => l.rateEurM3 !== null && l.taxable);
  assert.equal(vol?.eur, 15.75);
});

test('migration keeps the standing charges and IVA the owner may have tuned', () => {
  const hydrated = hydrateForTest({
    tariff: {
      periodMonths: 2,
      supplyFixedEurPeriod: 48.6, // a bigger meter calibre
      supplyBlocks: [{ upToM3: null, eurM3: 1.86 }],
      sanitationFixedEurPeriod: 7.3,
      sanitationEurM3: 0.5,
      ivaPct: 21,
    } as unknown as WaterTariff,
  });
  assert.equal(hydrated.tariff.supplyFixedEurPeriod, 48.6);
  assert.equal(hydrated.tariff.sanitationEurM3, 0.5);
  assert.equal(hydrated.tariff.ivaPct, 21);
  assert.equal(hydrated.tariff.supplyBlocks.length, 4, 'but the band table is still corrected');
});

test('an already-migrated tariff is left exactly alone', () => {
  const current = defaultWaterTariff();
  const custom = {
    ...current,
    supplyBlocks: [
      { upToM3: 20, eurM3: 0.5 },
      { upToM3: null, eurM3: 2.5 },
    ],
  };
  const hydrated = hydrateForTest({ tariff: custom });
  assert.equal(hydrated.tariff.supplyBlocks.length, 2, 'hand-edited bands survive');
  assert.equal(hydrated.tariff.supplyBlocks[1].eurM3, 2.5);
});
