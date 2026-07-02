// Cart-fill plan builder (P2, docs/41 §2). PURE — no I/O — so the exact batched
// payload and the spend-cap refusal are unit-testable (cart.test.ts) and the dry-run
// response is byte-for-byte what a real fill would send.

import type { OrderLine } from './types';

export interface CartPlanItem {
  product_id: string;
  quantity: number;
  /** UI/audit context — NOT part of the wire payload. */
  label: string;
  priceEur: number | null;
}

export interface CartPlan {
  /** What goes to Mercadona (flattened, batched — docs/38 §3). */
  items: CartPlanItem[];
  /** Checked lines that can't ship (no product mapped yet). */
  skipped: Array<{ label: string; reason: 'unmapped' }>;
  /** Sum of the KNOWN line prices (the spend cap judges this). */
  totalEur: number;
  /** Items whose price is unknown right now (Mercadona unreachable) — the cap can't see them. */
  unpricedCount: number;
}

/** How many units of the mapped product one line needs. */
export function lineQuantity(line: OrderLine): number {
  if (line.packsNeeded != null && line.packsNeeded > 0) return line.packsNeeded;
  // Count-like quantities order that many units; weights/volumes without pack math
  // (and "to taste") fall back to a single unit of the mapped product.
  if (line.unit === 'count' && Number.isFinite(line.qty) && line.qty > 0) return Math.round(line.qty);
  return 1;
}

/**
 * The checked+mapped lines of a draft → one batched cart payload. Duplicate product
 * ids merge (quantities add) so the batch stays one-line-per-product.
 */
export function buildCartPlan(lines: OrderLine[]): CartPlan {
  const byProduct = new Map<string, CartPlanItem>();
  const skipped: CartPlan['skipped'] = [];
  let unpricedCount = 0;
  for (const line of lines) {
    if (!line.checked) continue;
    if (!line.productId) {
      skipped.push({ label: line.label, reason: 'unmapped' });
      continue;
    }
    const qty = lineQuantity(line);
    const prev = byProduct.get(line.productId);
    if (prev) {
      prev.quantity += qty;
      if (line.priceEur != null) prev.priceEur = (prev.priceEur ?? 0) + line.priceEur;
      else unpricedCount++;
      if (!prev.label.includes(line.label)) prev.label = `${prev.label} + ${line.label}`;
    } else {
      byProduct.set(line.productId, {
        product_id: line.productId,
        quantity: qty,
        label: line.label,
        priceEur: line.priceEur ?? null,
      });
      if (line.priceEur == null) unpricedCount++;
    }
  }
  const items = [...byProduct.values()];
  const totalEur = Math.round(items.reduce((s, it) => s + (it.priceEur ?? 0), 0) * 100) / 100;
  return { items, skipped, totalEur, unpricedCount };
}

/** The exact wire payload lines (strips UI context off the plan items). */
export function wireLines(plan: CartPlan): Array<{ product_id: string; quantity: number }> {
  return plan.items.map(({ product_id, quantity }) => ({ product_id, quantity }));
}

export class SpendCapError extends Error {
  constructor(totalEur: number, capEur: number) {
    super(
      `refused: the cart total ${totalEur.toFixed(2)} € is over the ${capEur.toFixed(0)} € spend cap — ` +
        'raise the cap in Settings ▸ Connections ▸ Mercadona or uncheck some lines',
    );
    this.name = 'SpendCapError';
  }
}

/** Server-side spend cap (docs/41 §2): refuse any fill whose known total exceeds the cap. */
export function assertUnderSpendCap(plan: CartPlan, capEur: number): void {
  if (plan.totalEur > capEur) throw new SpendCapError(plan.totalEur, capEur);
}
