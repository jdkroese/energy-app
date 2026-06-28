// House-alarm engine (Phase 1). ONE button → (a) all (or selected) Sonos speakers play a
// siren that CONTINUOUSLY LOOPS AND (b) all (or selected) lights blink on/off, both until
// stopped. The two legs run INDEPENDENTLY: if the lights (Tuya cloud, laggy/rate-limited)
// fail, the siren must still fire, and vice-versa. Neither connector's error is ever
// allowed to abort the other.
//
// This engine touches ONLY speakers + lights. It does not read or write the battery /
// climate / arm / control-loop state. There is no arm gate — the alarm is an explicit,
// confirm-gated owner action (admin-only at the route), with a master enable in AlarmConfig.
//
// State: `store.alarmActive` is the single source of truth for "is the alarm on" and is
// persisted so the UI banner survives a restart. Defaults come from `store.alarmConfig`
// (Settings → Alarm / Panic); the trigger endpoint may override per-call. On boot,
// resumeAlarm() restarts both legs for any still-active session (honouring an elapsed cap).

import type { Request } from 'express';
import * as store from '../store';
import * as sonos from '../connectors/sonos';
import { getLights, bulkCommandLights } from '../routes/lights';
import { alarmMediaUrl } from '../routes/media';

// Per-notification clip length. The whole-house siren LOOPS PlayNotification (each call ≈ one
// clip); this is the per-call timeout fallback. The bundled clip is ~6s and loops cleanly.
// DO NOT shorten this below ~4s and DO NOT bundle a sub-second clip: live-tested on real
// Sonos, a 0.4s clip resolved "ok" but produced NO audible sound — the speaker needs setup
// time and the clip ended before audio rendered. A 4s clip was reliably audible. Keep it ≥4s.
const CLIP_SEC = 6;
const MAX_DURATION_SEC = 30 * 60; // hard ceiling so a runaway alarm can't sound forever

// ---- Notification seam (future: WhatsApp) -----------------------------------
// TODO(notifications): the owner will later add WhatsApp notifications for alarm
// triggered/stopped. Plug that in HERE — this is the single seam the engine calls on every
// alarm edge. Keep it a no-op-but-log stub for now; do NOT add WhatsApp code or deps yet.
export type AlarmEvent = 'triggered' | 'stopped';
function notifyAlarmEvent(event: AlarmEvent, detail: Record<string, unknown> = {}): void {
  // Intentionally a stub. Wire WhatsApp/push here later (one call site to extend).
  console.log(`[alarm] event=${event}`, JSON.stringify(detail));
}

// ---- Runtime handles (NOT persisted; rebuilt on boot from store.alarmActive) ----

let blinkTimer: ReturnType<typeof setInterval> | null = null;
let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
/** Snapshot of each blinking light's power state at trigger time, for restore on stop. */
let lightSnapshot: Record<string, boolean> = {};
let blinkOn = false; // current blink phase
/** True while a blink toggle batch is in flight — used to SKIP a beat rather than queue up
 *  (Tuya cloud is slow; we must never let the lights backpressure stall the loop). */
let blinkInFlight = false;

// ---- Light helpers (best-effort; Tuya cloud) --------------------------------

interface LightRow {
  id: string;
  power: boolean;
  online: boolean;
}

/** Read the current light fleet (id + power), tolerant of the route's `unknown` shape. */
async function readLightFleet(): Promise<LightRow[]> {
  try {
    const res = (await getLights()) as { connected?: boolean; devices?: Array<{ id: string; power: boolean; online: boolean }> };
    if (!res?.connected || !Array.isArray(res.devices)) return [];
    return res.devices.map((d) => ({ id: d.id, power: Boolean(d.power), online: d.online !== false }));
  } catch {
    return [];
  }
}

/** Set a batch of lights on/off, swallowing all errors (best-effort). */
async function setLights(ids: string[], on: boolean): Promise<void> {
  if (ids.length === 0) return;
  try {
    await bulkCommandLights(ids, 'power', on);
  } catch {
    /* the siren leg is independent — never let a light failure surface here */
  }
}

/** Start the blink loop over `ids` at `blinkMs` half-period, snapshotting prior power first.
 *  Clears any existing timer. Non-blocking: if the previous toggle batch hasn't returned,
 *  the beat is SKIPPED so a slow Tuya cloud never stacks commands. */
async function startBlink(ids: string[], blinkMs: number): Promise<void> {
  stopBlinkTimer();
  if (ids.length === 0) return;
  const period = Math.max(store.ALARM_BLINK_FLOOR_MS, Math.round(blinkMs));
  // Snapshot prior power so stop() can restore exactly what was on/off.
  const fleet = await readLightFleet();
  lightSnapshot = {};
  for (const id of ids) {
    const row = fleet.find((f) => f.id === id);
    lightSnapshot[id] = row ? row.power : false;
  }
  blinkOn = false;
  blinkInFlight = false;
  blinkTimer = setInterval(() => {
    if (blinkInFlight) return; // previous batch still going — skip this beat
    blinkOn = !blinkOn;
    blinkInFlight = true;
    void setLights(ids, blinkOn).finally(() => { blinkInFlight = false; });
  }, period);
  // Kick the first toggle immediately (don't wait one interval).
  blinkOn = true;
  blinkInFlight = true;
  void setLights(ids, true).finally(() => { blinkInFlight = false; });
}

function stopBlinkTimer(): void {
  if (blinkTimer) {
    clearInterval(blinkTimer);
    blinkTimer = null;
  }
  blinkInFlight = false;
}

/** Restore lights to their pre-alarm snapshot (best-effort). */
async function restoreLights(): Promise<void> {
  const onIds = Object.entries(lightSnapshot).filter(([, v]) => v).map(([k]) => k);
  const offIds = Object.entries(lightSnapshot).filter(([, v]) => !v).map(([k]) => k);
  await setLights(onIds, true);
  await setLights(offIds, false);
  lightSnapshot = {};
}

// ---- Siren leg (Sonos; best-effort) -----------------------------------------

function startSiren(volumePct: number, speakerIds: string[], budgetSec: number | null, mediaUrl: string): void {
  // Fire-and-forget: the loop runs until stopSiren() or the budget elapses. Errors are
  // logged, never thrown into the alarm flow.
  void sonos
    .playSiren({ trackUri: mediaUrl, volumePct, durationSec: CLIP_SEC, speakerIds }, budgetSec)
    .catch((e) => console.error('[alarm] siren failed:', (e as Error).message));
}

// ---- Public API -------------------------------------------------------------

export interface TriggerInput {
  /** Light ids to blink; omitted/empty = config default (which is all when empty). */
  lightIds?: string[];
  /** Speaker UUIDs to sound; omitted/empty = config default (all when empty). */
  speakerIds?: string[];
  /** Auto-stop after this many seconds; omitted = config default; <=0 = run until stopped. */
  durationSec?: number;
  /** Siren volume 0–100; omitted = config default. */
  volumePct?: number;
  /** Blink half-period (ms); omitted = config default. Floored server-side. */
  blinkMs?: number;
}

export interface AlarmStatus {
  active: boolean;
  startedAt: string | null;
  durationMs: number | null;
  /** Seconds remaining until auto-stop, or null when run-until-stopped / idle. */
  remainingSec: number | null;
  lightIds: string[];
  siren: boolean;
}

function statusFrom(a: store.AlarmActive | null): AlarmStatus {
  if (!a) return { active: false, startedAt: null, durationMs: null, remainingSec: null, lightIds: [], siren: false };
  let remainingSec: number | null = null;
  if (a.durationMs != null) {
    const elapsed = Date.now() - new Date(a.startedAt).getTime();
    remainingSec = Math.max(0, Math.round((a.durationMs - elapsed) / 1000));
  }
  return { active: true, startedAt: a.startedAt, durationMs: a.durationMs, remainingSec, lightIds: a.lightIds, siren: a.siren };
}

/** Current alarm status (folded into /api/alarm/status). */
export function getAlarmStatus(): AlarmStatus {
  return statusFrom(store.get().alarmActive);
}

function badInput(msg: string): never {
  const e = new Error(msg) as Error & { code?: string };
  e.code = 'BAD_INPUT';
  throw e;
}

/**
 * Trigger the house alarm. Resolves config defaults, sets `alarmActive`, then INDEPENDENTLY
 * starts the looping siren and the light-blink. `req` carries the request host so the media
 * URL can fall back to it when LAN_BASE_URL isn't set. Refuses when the alarm is disabled in
 * config.
 */
export async function triggerAlarm(input: TriggerInput, req?: Request): Promise<AlarmStatus> {
  const cfg = store.get().alarmConfig;
  if (!cfg.enabled) badInput('The house alarm is disabled in Settings → Alarm / Panic.');

  const durRaw = input.durationSec ?? cfg.autoStopSec;
  const durationSec = durRaw <= 0 ? 0 : Math.min(MAX_DURATION_SEC, Math.round(durRaw));
  const durationMs = durationSec > 0 ? durationSec * 1000 : null;
  const volumePct = Math.max(0, Math.min(100, Math.round(input.volumePct ?? cfg.volumePct)));
  const blinkMs = Math.max(store.ALARM_BLINK_FLOOR_MS, Math.round(input.blinkMs ?? cfg.blinkMs));

  // Speaker set: explicit override → config → all (empty means all in the connector).
  const speakerIds = (Array.isArray(input.speakerIds) && input.speakerIds.length ? input.speakerIds : cfg.speakerIds) ?? [];

  // Light set: explicit override → config → all discovered lights.
  let lightIds = Array.isArray(input.lightIds) && input.lightIds.length ? input.lightIds : cfg.lightIds;
  if (!lightIds || lightIds.length === 0) {
    lightIds = (await readLightFleet()).map((l) => l.id);
  }

  // If an alarm is already running, fold this trigger into a fresh session (stop the old
  // timers/legs first so we don't double-blink or stack siren loops).
  if (store.get().alarmActive) {
    await stopAlarm(true);
  }

  const startedAt = new Date().toISOString();
  store.update((s) => {
    s.alarmActive = { startedAt, durationMs, lightIds, siren: true };
  });
  notifyAlarmEvent('triggered', { lightCount: lightIds.length, speakerCount: speakerIds.length, durationSec, volumePct });

  // --- Leg A: siren (Sonos) — fire-and-forget, never blocks the light leg.
  const mediaUrl = alarmMediaUrl(req);
  startSiren(volumePct, speakerIds, durationSec > 0 ? durationSec : null, mediaUrl);

  // --- Leg B: light-blink — best-effort, independent of the siren.
  try {
    await startBlink(lightIds, blinkMs);
  } catch (e) {
    console.error('[alarm] blink start failed:', (e as Error).message);
  }

  // --- Auto-stop timer (safety cap).
  if (autoStopTimer) clearTimeout(autoStopTimer);
  if (durationMs != null) {
    autoStopTimer = setTimeout(() => {
      void stopAlarm().catch(() => {});
    }, durationMs);
    autoStopTimer.unref?.();
  }

  return getAlarmStatus();
}

/** Stop the alarm: halt the siren, stop the blink, restore lights, clear `alarmActive`.
 *  `silent` skips the notify seam (used when a re-trigger immediately supersedes). */
export async function stopAlarm(silent = false): Promise<AlarmStatus> {
  const wasActive = Boolean(store.get().alarmActive);
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  stopBlinkTimer();

  // Stop the siren (independent of lights).
  try {
    await sonos.stopSiren();
  } catch (e) {
    console.error('[alarm] siren stop failed:', (e as Error).message);
  }

  // Restore lights to their pre-alarm snapshot (independent of the siren).
  try {
    await restoreLights();
  } catch (e) {
    console.error('[alarm] light restore failed:', (e as Error).message);
  }

  store.update((s) => {
    s.alarmActive = null;
  });
  if (wasActive && !silent) notifyAlarmEvent('stopped');
  return getAlarmStatus();
}

/**
 * Resume a still-active alarm on boot (a restart while the siren was sounding). If the
 * persisted duration already elapsed, stop instead. Called once from index.ts.
 */
export async function resumeAlarm(): Promise<void> {
  const a = store.get().alarmActive;
  if (!a) return;
  const cfg = store.get().alarmConfig;
  const elapsedMs = Date.now() - new Date(a.startedAt).getTime();
  if (a.durationMs != null && elapsedMs >= a.durationMs) {
    await stopAlarm().catch(() => {});
    return;
  }
  const remainingSec = a.durationMs != null ? Math.max(1, Math.round((a.durationMs - elapsedMs) / 1000)) : null;
  console.log('[alarm] resuming active alarm session after restart');
  if (a.siren) startSiren(cfg.volumePct, cfg.speakerIds ?? [], remainingSec, alarmMediaUrl());
  try {
    await startBlink(a.lightIds, cfg.blinkMs);
  } catch {
    /* best-effort */
  }
  if (remainingSec != null) {
    if (autoStopTimer) clearTimeout(autoStopTimer);
    autoStopTimer = setTimeout(() => void stopAlarm().catch(() => {}), remainingSec * 1000);
    autoStopTimer.unref?.();
  }
}
