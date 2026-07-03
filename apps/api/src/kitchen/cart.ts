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
  /**
   * Checked lines that can't ship: 'unmapped' (no product mapped yet) or 'unpriced'
   * (mapped but the product carries NO price — a genuinely unavailable/obsolete item,
   * e.g. "Producto no disponible"). Unpriced lines are skipped, NOT sent — the fill is
   * still allowed; the user resolves them (swap/remove) in Groceries.
   */
  skipped: Array<{ label: string; reason: 'unmapped' | 'unpriced' }>;
  /** Sum of the KNOWN + ESTIMATED line prices (the spend cap judges this REAL total). */
  totalEur: number;
  /** Informational count of checked+mapped lines skipped for having no price (= 'unpriced' skips). */
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
    // Mapped but no price at all = genuinely unavailable/obsolete (no catalog price).
    // Skip it (never goes to the wire payload), report it, and let the user resolve it.
    if (line.priceEur == null) {
      unpricedCount++;
      skipped.push({ label: line.label, reason: 'unpriced' });
      continue;
    }
    if (line.priceEst) estimatedCount++;
    const qty = lineQuantity(line);
    const prev = byProduct.get(line.productId);
    if (prev) {
      prev.quantity += qty;
      prev.priceEur = (prev.priceEur ?? 0) + line.priceEur; // line.priceEur is non-null here (unpriced skipped above)
      if (line.priceEst) prev.estimated = true; // any estimated contributor flags the item
      if (!prev.label.includes(line.label)) prev.label = `${prev.label} + ${line.label}`;
    } else {
      byProduct.set(line.productId, {
        product_id: line.productId,
        quantity: qty,
        label: line.label,
        priceEur: line.priceEur,
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

/** Server-side spend cap (docs/41 §2): refuse any fill whose known total exceeds the cap. */
export function assertUnderSpendCap(plan: CartPlan, capEur: number): void {
  if (plan.totalEur > capEur) throw new SpendCapError(plan.totalEur, capEur);
}

/**
 * Pre-flight for a REAL (non-dry-run) cart fill. The single guard is the spend cap:
 *   - enrich preserves each line's last-known price as an ESTIMATE when the live re-check
 *     is unavailable, so totalEur is a REAL total, not the 0-sum no-op the old
 *     degrade-to-null path produced (PR #191 review finding #2 — resolved). An
 *     estimated-but-under-cap fill PASSES; over-cap → SpendCapError as always.
 *
 * Unpriced (mapped-but-no-price) lines no longer block: buildCartPlan SKIPS them out of
 * the wire payload (skipped, reason 'unpriced') and never sums them into totalEur, so a
 * handful of genuinely obsolete items can't hold up the whole fill. They come back in the
 * response for the UI to list; the user resolves them (swap/remove) in Groceries. The cap
 * still judges the REAL, priced total that actually ships.
 */
export function assertRealFillAllowed(plan: CartPlan, capEur: number): void {
  assertUnderSpendCap(plan, capEur);
}
