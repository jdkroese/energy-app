// Pure order-line helpers for the Groceries screen (obsolete-item resolver, docs/43).
// Kept UI-free so they unit-test under the Node test runner (node --import tsx --test).

import type { OrderLine } from '../../lib/types';

// A checked, product-mapped line with NO price at all (and not a preserved estimate) is a
// genuinely unavailable/obsolete item (e.g. "Producto no disponible"). The server SKIPS
// these from a cart fill; the UI flags them and offers Swap to pick an available product.
export function isUnavailable(line: OrderLine): boolean {
  return line.checked && Boolean(line.productId) && line.priceEur == null && !line.priceEst;
}

// How many units of the swapped-in product this line needs — mirrors the server's
// cart.lineQuantity so a swapped line prices the same way it would after a fresh enrich:
// packsNeeded wins, then a count qty, else a single unit.
export function swapLineUnits(line: Pick<OrderLine, 'packsNeeded' | 'unit' | 'qty'>): number {
  if (line.packsNeeded != null && line.packsNeeded > 0) return line.packsNeeded;
  if (line.unit === 'count' && Number.isFinite(line.qty) && line.qty > 0) return Math.round(line.qty);
  return 1;
}
