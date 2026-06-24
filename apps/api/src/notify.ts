// Notification delivery: Web Push (real, via web-push + VAPID) and WhatsApp
// (Meta Cloud API or CallMeBot, if configured). All functions are best-effort
// and NEVER throw — the alert loop must keep running even if a provider fails.

import webpush from 'web-push';
import * as store from './store';

let vapidReady = false;

/**
 * Ensure VAPID keys exist (generate + persist on first run) and wire web-push.
 * Safe to call repeatedly; only configures once.
 */
export function ensureVapid(): store.VapidKeys {
  let keys = store.get().vapid;
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    store.update((s) => {
      s.vapid = keys as store.VapidKeys;
    });
    console.log('[notify] generated new VAPID keypair');
  }
  if (!vapidReady) {
    // Subject must be a mailto: or https: URL.
    webpush.setVapidDetails('mailto:j.kroese@levante.nl', keys.publicKey, keys.privateKey);
    vapidReady = true;
  }
  return keys;
}

export function vapidPublicKey(): string {
  return ensureVapid().publicKey;
}

export interface SendResult {
  sent: boolean;
  reason?: string;
  delivered?: number;
  pruned?: number;
}

/**
 * Push a notification to every stored subscription. Prunes subscriptions the
 * push service reports as gone (HTTP 404/410).
 */
export async function sendPush(
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<SendResult> {
  try {
    ensureVapid();
  } catch (e) {
    console.error('[notify] vapid setup failed:', (e as Error).message);
    return { sent: false, reason: 'vapid not configured' };
  }

  const subs = store.get().pushSubscriptions;
  if (subs.length === 0) return { sent: false, reason: 'no subscriptions' };

  const payload = JSON.stringify({ title, body, data: data ?? {} });
  const dead: string[] = [];
  let delivered = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload,
        );
        delivered++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(sub.endpoint);
        else console.error('[notify] push error:', code, (e as Error).message);
      }
    }),
  );

  let pruned = 0;
  if (dead.length) {
    store.update((s) => {
      const before = s.pushSubscriptions.length;
      s.pushSubscriptions = s.pushSubscriptions.filter((x) => !dead.includes(x.endpoint));
      pruned = before - s.pushSubscriptions.length;
    });
  }

  return { sent: delivered > 0, delivered, pruned };
}

/**
 * Send a WhatsApp message via whichever provider is configured by env:
 *   - Meta Cloud API: WHATSAPP_TOKEN + WHATSAPP_PHONE_ID (template/text message)
 *   - CallMeBot:      CALLMEBOT_KEY (simple personal alerts)
 * If neither is configured, returns {sent:false} and logs — never throws.
 */
export async function sendWhatsApp(number: string, text: string): Promise<SendResult> {
  const metaToken = process.env.WHATSAPP_TOKEN;
  const metaPhoneId = process.env.WHATSAPP_PHONE_ID;
  const callMeBotKey = process.env.CALLMEBOT_KEY;

  const to = number.replace(/[^\d+]/g, ''); // strip spaces/dashes

  try {
    if (metaToken && metaPhoneId) {
      const res = await fetch(`https://graph.facebook.com/v20.0/${metaPhoneId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${metaToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/^\+/, ''),
          type: 'text',
          text: { body: text },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error('[notify] whatsapp(meta) HTTP', res.status, detail.slice(0, 200));
        return { sent: false, reason: `meta HTTP ${res.status}` };
      }
      return { sent: true };
    }

    if (callMeBotKey) {
      const url =
        `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(to)}` +
        `&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(callMeBotKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        console.error('[notify] whatsapp(callmebot) HTTP', res.status);
        return { sent: false, reason: `callmebot HTTP ${res.status}` };
      }
      return { sent: true };
    }
  } catch (e) {
    console.error('[notify] whatsapp send failed:', (e as Error).message);
    return { sent: false, reason: (e as Error).message };
  }

  console.log('[notify] whatsapp skipped — provider not configured');
  return { sent: false, reason: 'provider not configured' };
}

/**
 * Send an email via Resend if RESEND_API_KEY is set; otherwise log and return
 * {sent:false}. Best-effort — NEVER throws.
 */
export async function sendEmail(to: string, subject: string, text: string): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[email] (no provider) to ${to}: ${text}`);
    return { sent: false, reason: 'provider not configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? 'Power <noreply@hirobo.nl>',
        to: [to],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[notify] email(resend) HTTP', res.status, detail.slice(0, 200));
      return { sent: false, reason: `resend HTTP ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error('[notify] email send failed:', (e as Error).message);
    return { sent: false, reason: (e as Error).message };
  }
}
