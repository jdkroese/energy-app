// Background alert loop. Every ~60s it evaluates the live system against the
// enabled rules; for genuinely NEW alerts (not seen before) it persists the
// first-seen timestamp and fans out notifications over the enabled channels.
//
// SHADOW / READ-ONLY: this loop only reads device state and sends notifications.
// It never issues a control/write command to Sonnen or Tesla.

import { evaluateLiveAlerts } from './routes/alerts';
import * as notify from './notify';
import * as store from './store';

const INTERVAL_MS = 60_000;
// Re-notify only if an alert recurs after it has been gone for this long.
const RENOTIFY_AFTER_MS = 6 * 3600_000;

let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  try {
    const firing = await evaluateLiveAlerts();
    if (firing.length === 0) return;

    const state = store.get();
    const now = Date.now();
    const channels = state.channels;
    const seen = state.seenAlerts;

    for (const a of firing) {
      // Skip alerts the user already acknowledged/resolved.
      const override = state.alertOverrides[a.id];
      if (override && override.status !== 'new') continue;

      const lastSeen = seen[a.id];
      const isNew = lastSeen === undefined || now - lastSeen > RENOTIFY_AFTER_MS;

      // Record/refresh first-seen timestamp for dedupe.
      store.update((s) => {
        s.seenAlerts[a.id] = now;
      });

      if (!isNew) continue;

      const body = a.sub || a.title;
      const tasks: Promise<unknown>[] = [];

      if (channels.push.enabled) {
        tasks.push(
          notify.sendPush(a.title, body, { id: a.id, severity: a.severity, device: a.device }),
        );
      }
      if (channels.whatsapp.enabled && channels.whatsapp.number) {
        const text = `⚡ ${a.title}\n${body}\n(${a.device})`;
        tasks.push(notify.sendWhatsApp(channels.whatsapp.number, text));
      }
      if (channels.email.enabled && channels.email.address) {
        tasks.push(
          notify.sendEmail(channels.email.address, `Power alert: ${a.title}`, `${a.title}\n${body}\n(${a.device})`),
        );
      }

      // Best-effort; failures inside notify are already swallowed there.
      await Promise.allSettled(tasks);
      console.log(`[alert-loop] notified "${a.id}" (${a.severity})`);
    }

    // Prune very old seen entries so the map doesn't grow unbounded.
    store.update((s) => {
      for (const [id, ts] of Object.entries(s.seenAlerts)) {
        if (now - ts > 7 * 24 * 3600_000) delete s.seenAlerts[id];
      }
    });
  } catch (e) {
    // Never crash the process.
    console.error('[alert-loop] tick failed:', (e as Error).message);
  }
}

export function startAlertLoop(): void {
  if (timer) return;
  // Kick a first run shortly after boot, then on the interval.
  setTimeout(() => void tick(), 8_000);
  timer = setInterval(() => void tick(), INTERVAL_MS);
  console.log(`[alert-loop] started (every ${INTERVAL_MS / 1000}s, shadow/read-only)`);
}

export function stopAlertLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
