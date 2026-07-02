// Background alert loop. Every ~60s it evaluates the live system against the
// enabled rules; for genuinely NEW alerts (not seen before) it persists the
// first-seen timestamp and fans out notifications over the enabled channels.
//
// SHADOW / READ-ONLY: this loop only reads device state and sends notifications.
// It never issues a control/write command to Sonnen or Tesla.

import { evaluateLiveAlerts, type Severity } from './routes/alerts';
import * as notify from './notify';
import * as store from './store';
import { emitAlertActive, emitAlertCleared, emitClearedForMissing } from './alert-events';
import { runEventMonitors } from './monitors';
import { pruneEventRing } from './events';

const INTERVAL_MS = 60_000;
// Re-notify only if an alert recurs after it has been gone for this long.
const RENOTIFY_AFTER_MS = 6 * 3600_000;

// Connectivity/probe-based alerts can briefly false-trip on a single failed poll
// — e.g. the Sonnen's weak embedded HTTP server choking on the cold burst of
// concurrent requests right after the daemon starts. Require this many consecutive
// observations before notifying those, so a real outage still fires (~2 ticks ≈
// 75s) while a one-off blip is ignored.
// rule-voltage is debounced too: grid voltage fluctuates a lot, so require 2 consecutive
// observations before notifying so a single spike past the band doesn't fire an alert.
// rule-charge-stall is debounced as well: the coordinator commands every 90s and the Sonnen
// ramps up, so require 2 consecutive ticks to avoid firing during a normal ramp/cloud transient.
// rule-inverter-offline / rule-inverter-stall are debounced too: a WiNet-S dongle can
// miss a single poll transiently (WiFi), so require several consecutive daylight misses
// (~5 min) before paging that an inverter is down.
const DEBOUNCE_RULES = new Set([
  'rule-offline',
  'rule-outage',
  'rule-voltage',
  'rule-charge-stall',
  'rule-inverter-offline',
  'rule-inverter-stall',
]);
const DEBOUNCE_MIN_STREAK = 2;
// Per-rule streak overrides (ticks) where the default 2 (~75s) is too jumpy. The inverter
// offline/stall rules want ~5 min of consecutive daylight misses before paging.
const DEBOUNCE_STREAK_OVERRIDE: Record<string, number> = {
  'rule-inverter-offline': 5,
  'rule-inverter-stall': 5,
};

let timer: ReturnType<typeof setInterval> | null = null;
// Consecutive ticks each debounced alert id has been observed firing.
const offlineStreak = new Map<string, number>();
// Alerts we've notified that should send a one-time "back to normal" message once
// they stop firing. Opted into per-rule (currently rule-voltage only). Keyed by id.
const recoveryWatch = new Map<string, { device: string; title: string; body: string }>();

// Fan a single alert (breach or recovery) out over the enabled channels.
async function fanOut(
  channels: store.Channels,
  a: { id: string; title: string; body: string; device: string; severity: Severity },
): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (channels.push.enabled) {
    tasks.push(notify.sendPush(a.title, a.body, { id: a.id, severity: a.severity, device: a.device }));
  }
  if (channels.whatsapp.enabled && channels.whatsapp.number) {
    const emoji = a.severity === 'ok' ? '✅' : '⚡';
    tasks.push(notify.sendWhatsApp(channels.whatsapp.number, `${emoji} ${a.title}\n${a.body}\n(${a.device})`));
  }
  if (channels.email.enabled && channels.email.address) {
    tasks.push(
      notify.sendEmail(channels.email.address, `Power alert: ${a.title}`, `${a.title}\n${a.body}\n(${a.device})`),
    );
  }
  // Best-effort; failures inside notify are already swallowed there.
  await Promise.allSettled(tasks);
}

async function tick(): Promise<void> {
  try {
    // Run the new log-only observation monitors (high load / high current) + prune the
    // event ring EVERY tick, before any early return (docs/37 §5, §7). Best-effort.
    await runEventMonitors();
    pruneEventRing();

    const firing = await evaluateLiveAlerts();

    // Maintain debounce streaks BEFORE any early return, so a recovered alert
    // (no longer firing) resets even on an otherwise-quiet tick.
    const firingDebounced = new Set(
      firing.filter((a) => a.rule && DEBOUNCE_RULES.has(a.rule)).map((a) => a.id),
    );
    for (const id of [...offlineStreak.keys()]) {
      if (!firingDebounced.has(id)) offlineStreak.delete(id);
    }
    for (const id of firingDebounced) {
      offlineStreak.set(id, (offlineStreak.get(id) ?? 0) + 1);
    }

    const state = store.get();
    const now = Date.now();
    const channels = state.channels;

    // Recovery: any alert we previously notified that has stopped firing → send a
    // one-time "back to normal" message. Run BEFORE the early return so a lone
    // recovery on an otherwise-quiet tick still goes out.
    const firingIds = new Set(firing.map((a) => a.id));
    for (const [id, info] of [...recoveryWatch]) {
      if (firingIds.has(id)) continue;
      recoveryWatch.delete(id);
      // Clear the dedupe stamp so a fresh excursion notifies immediately, even
      // within the 6h renotify window.
      store.update((s) => {
        delete s.seenAlerts[id];
      });
      await fanOut(channels, { id, severity: 'ok', device: info.device, title: info.title, body: info.body });
      // Emit a paired 'cleared' observation event (docs/37 §3 Phase 2).
      await emitAlertCleared(id, info.device, info.title);
      console.log(`[alert-loop] recovery "${id}"`);
    }
    // Emit a 'cleared' event for every previously-ACTIVE alert (tracked in alert-events)
    // that is no longer firing, even without a recoveryWatch entry (no-op if never active).
    await emitClearedForMissing(firing);

    if (firing.length === 0) return;

    const seen = store.get().seenAlerts;

    for (const a of firing) {
      // Skip alerts the user already acknowledged/resolved.
      const override = state.alertOverrides[a.id];
      if (override && override.status !== 'new') continue;

      // Debounce transient-prone connectivity alerts until seen N ticks running.
      if (
        a.rule &&
        DEBOUNCE_RULES.has(a.rule) &&
        (offlineStreak.get(a.id) ?? 0) < (DEBOUNCE_STREAK_OVERRIDE[a.rule] ?? DEBOUNCE_MIN_STREAK)
      ) {
        continue;
      }

      const lastSeen = seen[a.id];
      const isNew = lastSeen === undefined || now - lastSeen > RENOTIFY_AFTER_MS;

      // Record/refresh first-seen timestamp for dedupe.
      store.update((s) => {
        s.seenAlerts[a.id] = now;
      });

      if (!isNew) continue;

      const body = a.sub || a.title;
      await fanOut(channels, { id: a.id, title: a.title, body, device: a.device, severity: a.severity });
      // Emit the firing alert as an ACTIVE observation event (docs/37 §3 Phase 2). It fans out
      // via fanOut above, so the bus is told noNotify (no double-send) inside emitAlertActive.
      await emitAlertActive(a);
      console.log(`[alert-loop] notified "${a.id}" (${a.severity})`);

      // Arm a recovery ("back to normal") message for rules that opt in. Grid
      // voltage does: the owner wants to know when it settles back inside the band.
      if (a.rule === 'rule-voltage') {
        const vm = store.get().voltageMonitor;
        recoveryWatch.set(a.id, {
          device: a.device,
          title: 'Grid voltage back to normal',
          body: `Voltage returned to the ${vm.minV}–${vm.maxV} V band`,
        });
      }
      // Charge-stall opts into a recovery message too: the owner wants to know when the
      // battery starts soaking the surplus again (e.g. the over-voltage trip cleared).
      if (a.rule === 'rule-charge-stall') {
        recoveryWatch.set(a.id, {
          device: a.device,
          title: 'Sonnen absorbing surplus again',
          body: 'Battery is charging from the solar surplus again',
        });
      }
      // Solar-inverter fault/offline/stall recover: the owner (headline requirement:
      // never miss an outage) wants the "back online / cleared" message too.
      if (a.rule === 'rule-inverter-fault') {
        recoveryWatch.set(a.id, { device: a.device, title: `${a.device} fault cleared`, body: 'The inverter fault/alarm is no longer active' });
      }
      if (a.rule === 'rule-inverter-offline') {
        recoveryWatch.set(a.id, { device: a.device, title: `${a.device} back online`, body: 'The inverter/dongle is reachable again' });
      }
      if (a.rule === 'rule-inverter-stall') {
        recoveryWatch.set(a.id, { device: a.device, title: `${a.device} producing again`, body: 'The inverter is generating again' });
      }
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
