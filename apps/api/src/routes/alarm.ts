// HTTP surface for the Sonos house-alarm: the alarm trigger/stop/status, the speaker
// fleet + per-speaker volume/test, and the Sonos integration config (enable + seed IP).
// Reads are any-authed; all writes are admin-gated at the route in index.ts.

import type { Request } from 'express';
import * as sonos from '../connectors/sonos';
import { triggerAlarm, stopAlarm, getAlarmStatus } from '../control/alarm';
import { alarmMediaUrl } from './media';
import * as store from '../store';

function badInput(msg: string): never {
  const e = new Error(msg) as Error & { code?: string };
  e.code = 'BAD_INPUT';
  throw e;
}

// ---- Speakers (fleet + per-speaker control) --------------------------------

/** GET /api/speakers — the discovered Sonos fleet + a small context strip. */
export async function getSpeakers(): Promise<unknown> {
  const info = await sonos.getInfo();
  const speakers = await sonos.getFleet();
  return {
    ts: new Date().toISOString(),
    enabled: info.enabled,
    seedIp: info.seedIp,
    discoveredCount: info.discoveredCount,
    lastError: info.lastError,
    speakers,
    context: { deviceCount: speakers.length },
  };
}

/** POST /api/speakers/:id/volume { pct } — set one speaker's volume (admin). */
export async function setSpeakerVolume(id: string, pctRaw: unknown): Promise<unknown> {
  const pct = Number(pctRaw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) badInput('pct must be 0–100');
  await sonos.setVolume(id, pct);
  return { ts: new Date().toISOString(), ok: true, id, pct: Math.round(pct) };
}

/**
 * POST /api/speakers/:id/test — a brief chime on ONE speaker (smoke-test discovery +
 * playback + the LAN media URL without sounding the whole-house siren). Plays the alarm
 * clip once at a modest volume; PlayNotification restores prior playback after.
 */
export async function testSpeaker(id: string, req?: Request): Promise<unknown> {
  const m = await sonos.getFleet(); // ensures discovery has run
  if (!m.some((s) => s.id === id)) badInput(`speaker ${id} not found`);
  const url = alarmMediaUrl(req);
  // Reuse the connector's single-shot path by playing the siren with a tiny budget at a
  // gentle volume. groupCoordinators dedupe means a stereo-pair member still chimes once.
  await sonos
    .playSiren({ trackUri: url, volumePct: 30, durationSec: 3 }, 3)
    .catch((e) => badInput(`test failed: ${(e as Error).message}`));
  return { ts: new Date().toISOString(), ok: true, id };
}

// ---- Alarm trigger / stop / status -----------------------------------------

/** POST /api/alarm/trigger { lightIds?, speakerIds?, durationSec?, volumePct?, blinkMs? } (admin). */
export async function postAlarmTrigger(body: unknown, req?: Request): Promise<unknown> {
  const b = (body ?? {}) as { lightIds?: unknown; speakerIds?: unknown; durationSec?: unknown; volumePct?: unknown; blinkMs?: unknown };
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  const durationSec = b.durationSec === undefined ? undefined : Number(b.durationSec);
  const volumePct = b.volumePct === undefined ? undefined : Number(b.volumePct);
  const blinkMs = b.blinkMs === undefined ? undefined : Number(b.blinkMs);
  if (durationSec !== undefined && !Number.isFinite(durationSec)) badInput('durationSec must be a number');
  if (volumePct !== undefined && !Number.isFinite(volumePct)) badInput('volumePct must be a number');
  if (blinkMs !== undefined && !Number.isFinite(blinkMs)) badInput('blinkMs must be a number');
  const status = await triggerAlarm(
    { lightIds: strArr(b.lightIds), speakerIds: strArr(b.speakerIds), durationSec, volumePct, blinkMs },
    req,
  );
  return { ts: new Date().toISOString(), ...status };
}

// ---- Alarm config (Settings → Alarm / Panic) -------------------------------

/** GET /api/alarm/config (any-authed). */
export function getAlarmConfig(): unknown {
  return { ts: new Date().toISOString(), config: store.get().alarmConfig };
}

/** PUT /api/alarm/config (admin) — patch + persist; enforces the blink floor. */
export function setAlarmConfig(body: unknown): unknown {
  const b = (body ?? {}) as Partial<store.AlarmConfig>;
  const strArr = (v: unknown, fb: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fb);
  const saved = store.update((s) => {
    const cur = s.alarmConfig;
    s.alarmConfig = {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled,
      speakerIds: b.speakerIds !== undefined ? strArr(b.speakerIds, cur.speakerIds) : cur.speakerIds,
      volumePct: typeof b.volumePct === 'number' ? Math.max(0, Math.min(100, Math.round(b.volumePct))) : cur.volumePct,
      lightIds: b.lightIds !== undefined ? strArr(b.lightIds, cur.lightIds) : cur.lightIds,
      blinkMs: typeof b.blinkMs === 'number' ? Math.max(store.ALARM_BLINK_FLOOR_MS, Math.round(b.blinkMs)) : cur.blinkMs,
      autoStopSec: typeof b.autoStopSec === 'number' && b.autoStopSec >= 0 ? Math.round(b.autoStopSec) : cur.autoStopSec,
    };
    return s.alarmConfig;
  });
  return { ts: new Date().toISOString(), config: saved };
}

/** POST /api/alarm/stop (admin). */
export async function postAlarmStop(): Promise<unknown> {
  const status = await stopAlarm();
  return { ts: new Date().toISOString(), ...status };
}

/** GET /api/alarm/status (any-authed). */
export function getAlarmStatusRoute(): unknown {
  return { ts: new Date().toISOString(), ...getAlarmStatus() };
}

// ---- Sonos integration config (enable + seed IP) ---------------------------

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/** GET /api/integrations/sonos — status for the Settings panel. */
export async function getSonosIntegration(): Promise<unknown> {
  const info = await sonos.getInfo();
  return { ts: new Date().toISOString(), ...info };
}

/** PUT /api/integrations/sonos { enabled?, seedIp? } (admin) — persist + re-scan. */
export async function setSonosIntegration(body: unknown): Promise<unknown> {
  const b = (body ?? {}) as { enabled?: unknown; seedIp?: unknown };
  const enabled = b.enabled === undefined ? true : Boolean(b.enabled);
  let seedIp: string | undefined;
  if (b.seedIp !== undefined && b.seedIp !== null && String(b.seedIp).trim() !== '') {
    seedIp = String(b.seedIp).trim();
    if (!IP_RE.test(seedIp)) badInput('Seed IP must be a valid IPv4 address (e.g. 192.168.1.149)');
  }
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.sonos = { enabled, ...(seedIp ? { seedIp } : {}) };
  });
  // Apply immediately: drop the cached manager so the new config takes effect, then probe.
  const scan = await sonos.rescan();
  return { ts: new Date().toISOString(), enabled, seedIp: seedIp ?? null, ...scan };
}

/** POST /api/integrations/sonos/rescan (admin) — force a fresh discovery. */
export async function rescanSonos(): Promise<unknown> {
  const scan = await sonos.rescan();
  return { ts: new Date().toISOString(), ...scan };
}
