// Order-line enrichment (moved out of routes/kitchen.ts in P2 — docs/41 hardening #2).
// Server-side price + pack-math recompute for every line; the server owns the math
// (docs/39). PARALLEL: all product lookups fire through Promise.all — the connector's
// own 2-slot gate bounds concurrency, and its 5-min unreachability negative cache
// means the FIRST hard failure short-circuits every queued lookup to null instantly,
// so a 30-line draft cannot stall for minutes when Mercadona is down.
// getProduct is injectable for the degraded-latency unit test (enrich.test.ts).

import * as mercadona from '../connectors/mercadona';
import { packMath } from './engine';
import type { OrderLine, OrderSuggestion, ProductMapEntry } from './types';

export type GetProduct = (productId: string) => Promise<mercadona.MercadonaProduct | null>;

export async function enrichLines(
  lines: OrderLine[],
  productMap: Record<string, ProductMapEntry>,
  getProduct: GetProduct = mercadona.getProduct,
): Promise<OrderSuggestion[]> {
  // Enrich every line concurrently, then collect auto-suggestions IN LINE ORDER so
  // the result is deterministic regardless of which fetch resolves first.
  const results = await Promise.all(lines.map((line) => enrichOne(line, productMap, getProduct)));
  return results.filter((s): s is OrderSuggestion => s !== null);
}

async function enrichOne(
  line: OrderLine,
  productMap: Record<string, ProductMapEntry>,
  getProduct: GetProduct,
): Promise<OrderSuggestion | null> {
  const map = line.ingredientKey ? productMap[line.ingredientKey] : undefined;
  if (map && !line.productId) line.productId = map.productId;
  if (line.productId) {
    line.needsMapping = false;
    // Price via the connector (30-min cached). Degrades to null → "price unavailable".
    const product = await getProduct(line.productId);
    const unitPrice = product?.unitPrice ?? map?.unitPrice ?? null;
    const pack = product?.packSize
      ? { qty: product.packSize.qty, unit: product.packSize.unit, display: product.packSizeDisplay ?? `${product.packSize.qty} ${product.packSize.unit}` }
      : map?.packSize ?? null;
    if (line.source === 'recipe') {
      const math = packMath(line.qty, line.unit, line.recipeIds?.length ?? 1, pack);
      if (math) {
        line.packsNeeded = math.packsNeeded;
        line.coverageNote = math.coverageNote;
        line.priceEur = unitPrice != null ? Math.round(unitPrice * math.packsNeeded * 100) / 100 : null;
        if ((line.recipeIds?.length ?? 0) > 1) {
          return {
            id: `auto-${line.id}`,
            kind: 'pack',
            text: `${line.label} merged: ${math.coverageNote}`,
            state: 'confirmed',
            auto: true,
          };
        }
      } else {
        // Units incomparable (or pack size unknown) → assume one unit of the product.
        delete line.packsNeeded;
        delete line.coverageNote;
        line.priceEur = unitPrice;
      }
    } else {
      line.priceEur = unitPrice != null ? Math.round(unitPrice * Math.max(1, line.qty) * 100) / 100 : null;
    }
  } else if (line.source === 'recipe' || line.source === 'manual' || line.source === 'tablet') {
    line.needsMapping = true;
    line.priceEur = null;
  }
  return null;
}
