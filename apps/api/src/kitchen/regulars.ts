// "My regulars" browser mapping (docs/43). Pure mapping helper, extracted from the
// /staples/regulars route so it's unit-testable without mounting Express (pattern:
// kitchen-coordinator's evaluateNudges).
//
// Regulars are a browse-to-add-to-the-order surface — they no longer seed staples
// (docs/43 decoupled that; the old /staples/import-regulars path is gone). Rows carry
// an `inDraft` flag computed from the current order draft so the UI can grey items
// already in this week's order.
//
// The live myregulars endpoint returns WRAPPER rows, not bare products:
//   { results: [ { product: {id, display_name, price_instructions:{unit_price}, ...},
//                  recommended_quantity: 4, selling_method: 0, source, ... }, ... ] }
// The real product is nested under row.product — normalizing the wrapper itself
// yields undefined id/name and filters every item out (the "imported 0" bug).

import * as mercadona from '../connectors/mercadona';

/** A row from getMyRegulars — wrapper shape, tolerant of a flat product too. */
export type RegularRow = Record<string, unknown>;

export interface RegularProduct {
  id: string;
  name: string;
  photo: string | null;
  unitPrice: number | null;
  packSizeDisplay: string | null;
  /** True when this product is already a line in the current order draft. */
  inDraft: boolean;
  recommendedQty: number;
}

/** Coerce an arbitrary recommended-quantity value to a positive int in 1..99 (default 1). */
export function clampQty(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 1;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > 99) return 99;
  return i;
}

/**
 * Map raw myregulars rows → the UI product list. Unwraps row.product (tolerating a
 * flat row), drops rows with no id/name, and threads recommended_quantity through.
 * `draftProductIds` = productIds already on the current order draft → `inDraft`.
 */
export function mapRegulars(rows: RegularRow[], draftProductIds: Set<string>): RegularProduct[] {
  return rows
    .map((row) => {
      const prod = ((row as { product?: unknown }).product ?? row) as unknown as mercadona.RawProduct;
      const p = mercadona.normalizeProduct(prod);
      const qty = clampQty((row as { recommended_quantity?: unknown }).recommended_quantity);
      return { p, qty };
    })
    .filter(({ p }) => p.id && p.name)
    .map(({ p, qty }) => ({
      id: p.id,
      name: p.name,
      photo: p.photo,
      unitPrice: p.unitPrice,
      packSizeDisplay: p.packSizeDisplay,
      inDraft: draftProductIds.has(p.id),
      recommendedQty: qty,
    }));
}
