import * as notify from '../notify';
import * as store from '../store';
import type { StoredPushSubscription } from '../store';

/** GET /api/push/vapid-public → the VAPID public key for client subscription. */
export function getVapidPublic(): unknown {
  return { ts: new Date().toISOString(), publicKey: notify.vapidPublicKey() };
}

interface SubscribeBody {
  subscription?: {
    endpoint?: string;
    expirationTime?: number | null;
    keys?: { p256dh?: string; auth?: string };
  };
}

/** POST /api/push/subscribe {subscription} → dedupe-store the PushSubscription. */
export function subscribe(body: SubscribeBody): unknown {
  const sub = body?.subscription;
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('invalid subscription (need endpoint + keys.p256dh + keys.auth)');
  }
  const normalized: StoredPushSubscription = {
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime ?? null,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  };

  const count = store.update((s) => {
    const exists = s.pushSubscriptions.some((x) => x.endpoint === normalized.endpoint);
    if (!exists) s.pushSubscriptions.push(normalized);
    return s.pushSubscriptions.length;
  });

  return { ts: new Date().toISOString(), ok: true, subscriptions: count };
}
