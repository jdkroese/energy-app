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
  /** priceEur is a preserved last-known ESTIMATE (live re-check unavailable), not live-confirmed. */
  estimated?: boolean;
}

export interface CartPlan {
  /** What goes to Mercadona (flattened, batched — docs/38 §3). */
  items: CartPlanItem[];
  /** Checked lines that can't ship (no product mapped yet). */
  skipped: Array<{ label: string; reason: 'unmapped' }>;
  /** Sum of the KNOWN + ESTIMATED line prices (the spend cap judges this REAL total). */
  totalEur: number;
  /** Items with NO price at all (never priced) — the cap truly can't see them. */
  unpricedCount: number;
  /** Items priced from a last-known estimate (Mercadona flaky) — counted in totalEur. */
  estimatedCount: number;
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
  let estimatedCount = 0;
  for (const line of lines) {
    if (!line.checked) continue;
    if (!line.productId) {
      skipped.push({ label: line.label, reason: 'unmapped' });
      continue;
    }
    if (line.priceEur == null) unpricedCount++;
    else if (line.priceEst) estimatedCount++;
    const qty = lineQuantity(line);
    const prev = byProduct.get(line.productId);
    if (prev) {
      prev.quantity += qty;
      if (line.priceEur != null) prev.priceEur = (prev.priceEur ?? 0) + line.priceEur;
      if (line.priceEst) prev.estimated = true; // any estimated contributor flags the item
      if (!prev.label.includes(line.label)) prev.label = `${prev.label} + ${line.label}`;
    } else {
      byProduct.set(line.productId, {
        product_id: line.productId,
        quantity: qty,
        label: line.label,
        priceEur: line.priceEur ?? null,
        ...(line.priceEst ? { estimated: true } : {}),
      });
    }
  }
  const items = [...byProduct.values()];
  const totalEur = Math.round(items.reduce((s, it) => s + (it.priceEur ?? 0), 0) * 100) / 100;
  return { items, skipped, totalEur, unpricedCount, estimatedCount };
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

export class UnpricedLinesError extends Error {
  constructor(count: number) {
    super(
      `refused: ${count} item${count === 1 ? ' has' : 's have'} no live price, so the spend cap can't judge this fill — ` +
        'try again when Mercadona is reachable, or send as checklist instead',
    );
    this.name = 'UnpricedLinesError';
  }
}

/** Server-side spend cap (docs/41 §2): refuse any fill whose known total exceeds the cap. */
export function assertUnderSpendCap(plan: CartPlan, capEur: number): void {
  if (plan.totalEur > capEur) throw new SpendCapError(plan.totalEur, capEur);
}

/**
 * Pre-flight for a REAL (non-dry-run) cart fill. Two guards:
 *   1. the spend cap (assertUnderSpendCap) — now MEANINGFUL: enrich preserves each
 *      line's last-known price as an ESTIMATE when the live re-check is unavailable,
 *      so totalEur is a REAL total, not the 0-sum no-op the old degrade-to-null path
 *      produced (PR #191 review finding #2 — resolved). An estimated-but-under-cap
 *      fill therefore PASSES; over-cap → SpendCapError as always.
 *   2. never-priced items (unpricedCount) — a line that has NEVER had a price still
 *      truly refuses, because the cap genuinely can't see it. Dry-run stays allowed
 *      with unpriced items — it sends nothing, and the preview is how you debug this.
 */
export function assertRealFillAllowed(plan: CartPlan, capEur: number): void {
  assertUnderSpendCap(plan, capEur);
  if (plan.unpricedCount > 0) throw new UnpricedLinesError(plan.unpricedCount);
}
