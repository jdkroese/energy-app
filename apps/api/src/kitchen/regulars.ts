// "My regulars" staples seeding (docs/41 §4). Pure mapping helpers, extracted from
// the /staples/regulars + /staples/import-regulars routes so they're unit-testable
// without mounting Express (pattern: kitchen-coordinator's evaluateNudges).
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
  alreadyStaple: boolean;
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
 */
export function mapRegulars(rows: RegularRow[], existingIds: Set<string>): RegularProduct[] {
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
      alreadyStaple: existingIds.has(p.id),
      recommendedQty: qty,
    }));
}

/** An incoming product on the import-regulars body. */
export interface IncomingRegular {
  productId?: string;
  name?: string;
  priceEur?: number | null;
  qty?: unknown;
  recommendedQty?: unknown;
}

export interface NormalizedImport {
  productId: string;
  name: string;
  priceEur: number | null;
  defaultQty: number;
}

/** Keep only rows with a productId + name; normalize the qty (qty | recommendedQty → 1..99). */
export function normalizeImports(products: IncomingRegular[]): NormalizedImport[] {
  const out: NormalizedImport[] = [];
  for (const p of products) {
    if (!p || typeof p.productId !== 'string' || !p.productId) continue;
    if (typeof p.name !== 'string' || !p.name.trim()) continue;
    out.push({
      productId: p.productId,
      name: String(p.name).trim().slice(0, 80),
      priceEur: typeof p.priceEur === 'number' ? p.priceEur : null,
      defaultQty: clampQty(p.qty ?? p.recommendedQty),
    });
  }
  return out;
}
