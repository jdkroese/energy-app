// Order-status tracking (P2, docs/41 §4): after a cart fill the human still checks
// out in Mercadona. We POLL the account's orders (on Groceries open + the hourly
// kitchen coordinator tick) and, when a placed order shows up after the fill, move
// the draft filled → submitted and record the delivery window in the order history.
// Read-only against Mercadona — this never creates or modifies an order.

import * as auth from '../connectors/mercadona-auth';
import * as store from '../store';
import { logEvent } from '../events';
import * as kitchen from './store';

export interface OrderStatusResult {
  checked: boolean;
  matched: boolean;
  order?: { id: string; slotStart: string | null; slotEnd: string | null; totalEur: number | null };
}

/**
 * One reconcile pass. Cheap no-op unless the draft sits in 'filled' with a linked
 * account. Best-effort: any connector failure returns {checked:false} silently —
 * the next tick tries again.
 */
export async function syncOrderStatus(now: Date = new Date()): Promise<OrderStatusResult> {
  const account = store.get().kitchen.mercadona.account;
  const d = kitchen.get();
  if (!account || d.orderDraft.status !== 'filled' || !d.orderDraft.pushedAt) {
    return { checked: false, matched: false };
  }
  const orders = await auth.getOrders().catch(() => null);
  if (!orders) return { checked: false, matched: false };
  const pushedAt = new Date(d.orderDraft.pushedAt).getTime();
  // A placed order created after the fill (small clock slack) = our order.
  const match = orders.find((o) => {
    const created = o.createdAt ? new Date(o.createdAt).getTime() : 0;
    return created >= pushedAt - 10 * 60_000;
  });
  if (!match) return { checked: true, matched: false };

  const entryDate = now.toISOString();
  kitchen.update((k) => {
    const checked = k.orderDraft.lines.filter((l) => l.checked);
    k.orderHistory.unshift({
      id: kitchen.newId('order'),
      date: entryDate,
      lines: checked,
      totalEur: match.totalEur ?? k.orderDraft.totalEur,
      source: 'mercadona',
      orderId: match.id || null,
      slot: match.slotStart ? { start: match.slotStart, end: match.slotEnd ?? match.slotStart } : null,
    });
    k.orderHistory = k.orderHistory.slice(0, 60);
    // The order is placed — staples in it count as ordered (drives the cadence hints).
    for (const l of checked) {
      if (l.source !== 'staple') continue;
      const staple = k.staples.find((s) => `staple:${s.id}` === l.ingredientKey);
      if (staple) staple.lastOrderedAt = entryDate;
    }
    k.orderDraft.status = 'submitted';
    k.orderDraft.updatedAt = entryDate;
  });
  logEvent({
    class: 'system',
    category: 'kitchen',
    severity: 'low',
    summary: `Mercadona order placed — ${match.slotStart ? `delivery ${match.slotStart}` : 'delivery window pending'}`,
    trigger: { source: 'coordinator', detail: 'kitchen-order-status' },
    data: { orderId: match.id, totalEur: match.totalEur, slotStart: match.slotStart, slotEnd: match.slotEnd },
  });
  return {
    checked: true,
    matched: true,
    order: { id: match.id, slotStart: match.slotStart, slotEnd: match.slotEnd, totalEur: match.totalEur },
  };
}
