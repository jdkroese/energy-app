// Generic-device schedule coordinator. Every 30s it fires any 'circuit' schedule
// EDGE that fell in the window since the last tick: at a window's START it turns the
// device ON (optionally at a chosen fan speed and/or direction); at the window's END
// it turns the device OFF. Edge-triggered (NOT continuously enforced) so a manual
// change between edges is respected — modelled on the LIGHTS coordinator, not the
// continuous-enforce blinds model.
//
// Scope = every configured generic device that has a power on/off switch capability.
//
// NO arm gate — matching the LIGHTS coordinator precedent: user-configured device
// scheduling runs autonomously, and every write still goes through the Tuya cloud.

import * as store from '../store';
import * as tuya from '../connectors/tuya';
import { deriveCapabilities, applyOverrides, type Capability } from '../connectors/tuya-inference';
import { buildGenericCommands } from '../connectors/tuya-generic';
import type { TuyaDevice, TuyaSpec } from '../connectors/tuya';
import { sunriseSunsetMin } from '../solar-model';
import { config } from '../config';
import { logScheduleAction } from './log-adapters';

const TICK_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;
let last: { day: number; min: number } | null = null;

function nowDM(): { day: number; min: number } {
  const d = new Date();
  return { day: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function resolveTimeMin(
  hhmm: string,
  anchor: store.TimeAnchor | undefined,
  offsetMin: number,
  sunriseMin: number,
  sunsetMin: number,
): number {
  if (!anchor || anchor === 'fixed') return hhmmToMin(hhmm);
  return (anchor === 'sunrise' ? sunriseMin : sunsetMin) + offsetMin;
}

/** Did a scheduled (weekday, minute) fall in the half-open interval (prev, now]? */
function crossed(
  prev: { day: number; min: number },
  now: { day: number; min: number },
  day: number,
  min: number,
): boolean {
  if (prev.day === now.day) {
    return now.day === day && prev.min < min && min <= now.min;
  }
  // Tick straddled midnight: fire the tail of the previous day and the head of the new.
  if (prev.day === day && min > prev.min) return true;
  if (now.day === day && min <= now.min) return true;
  return false;
}

/** Best-effort spec fetch (cached in the connector); null on failure. */
async function specFor(id: string): Promise<TuyaSpec | null> {
  try {
    return await tuya.getSpecifications(id);
  } catch {
    return null;
  }
}

/** DP codes that are a primary power switch (prefer these for the on/off lever). */
const PRIMARY_POWER_DPS = new Set([
  'switch', 'switch_1', 'switch_2', 'switch_3', 'switch_4', 'switch_5', 'switch_6', 'fan_switch',
]);

/** The power on/off switch: a primary-power dp if present, else the first switch cap. */
function powerCapOf(caps: Capability[]): Capability | null {
  return caps.find((c) => c.kind === 'switch' && PRIMARY_POWER_DPS.has(c.dp))
    ?? caps.find((c) => c.kind === 'switch')
    ?? null;
}

/** The fan-speed range: dp === 'fan_speed' if present, else the first range cap. */
function speedCapOf(caps: Capability[]): Capability | null {
  return caps.find((c) => c.kind === 'range' && c.dp === 'fan_speed')
    ?? caps.find((c) => c.kind === 'range')
    ?? null;
}

/** The direction enum: a dp mentioning 'direction' if present, else the first enum cap. */
function directionCapOf(caps: Capability[]): Capability | null {
  return caps.find((c) => c.kind === 'enum' && (c.dp.includes('direction') || c.dp.includes('fan_direction')))
    ?? caps.find((c) => c.kind === 'enum')
    ?? null;
}

function logCircuit(
  deviceId: string,
  lever: 'power' | 'speed' | 'direction',
  from: string | number | null,
  to: string | number,
  reason: string,
  ok: boolean,
  detail: string,
): void {
  store.update((st) => {
    // devices.log is ClimateLogEntry[] (lever: string; from/to: string|number|null) —
    // 'power'/'speed'/'direction' are circuit-rule levers; on/off are logged as strings.
    st.devices.log.push({ ts: Date.now(), deviceId, lever, from, to, reason, ok, detail });
    st.devices.log = store.pruneLog(st.devices.log);
    st.devices.updatedAt = Date.now();
    if (!ok) st.devices.lastError = `device ${deviceId}: ${detail}`;
  });
  // Shim: mirror into the unified event bus (docs/37 §3).
  logScheduleAction(deviceId, lever, from, to, reason, ok, detail);
}

/** Turn a scheduled device ON, optionally at a fan speed / direction. */
async function applyOn(d: TuyaDevice, caps: Capability[], spec: TuyaSpec | null, action: store.Action, ruleName: string): Promise<void> {
  const powerCap = powerCapOf(caps);
  if (!powerCap) return; // not switchable — nothing to do
  const reason = `rule ${ruleName}`;
  const cmds: Array<{ code: string; value: unknown }> = [];

  cmds.push(...buildGenericCommands(d, powerCap, { dp: powerCap.dp, kind: 'switch', value: true }, spec));

  let speedSet: number | null = null;
  if (action.speed != null) {
    const speedCap = speedCapOf(caps);
    if (speedCap) {
      // action.speed is in DEVICE units; buildGenericCommands clamps within the
      // cap's explicit min/max.
      cmds.push(...buildGenericCommands(d, speedCap, { dp: speedCap.dp, kind: 'range', value: action.speed }, spec));
      speedSet = action.speed;
    }
  }

  let dirSet: string | null = null;
  if (action.direction) {
    const dirCap = directionCapOf(caps);
    if (dirCap && (!dirCap.options || dirCap.options.includes(action.direction))) {
      cmds.push(...buildGenericCommands(d, dirCap, { dp: dirCap.dp, kind: 'enum', value: action.direction }, spec));
      dirSet = action.direction;
    }
  }

  try {
    // Dual-API: some relays/plugs accept v1 (success:true) yet only physically
    // actuate via iot-03 or the v2 thing-model — fire all, succeed if any lands.
    // Mirrors the manual generic command path (routes/discovered.ts) and lights.
    await tuya.sendCommandsDual(d.id, cmds);
    tuya.invalidateFleet();
    logCircuit(d.id, 'power', null, 'on', reason, true, 'on');
    if (speedSet != null) logCircuit(d.id, 'speed', null, speedSet, reason, true, `speed ${speedSet}`);
    if (dirSet != null) logCircuit(d.id, 'direction', null, dirSet, reason, true, `direction ${dirSet}`);
  } catch (e) {
    logCircuit(d.id, 'power', null, 'on', reason, false, (e as Error).message);
  }
}

/** Turn a scheduled device OFF. */
async function applyOff(d: TuyaDevice, caps: Capability[], spec: TuyaSpec | null, ruleName: string): Promise<void> {
  const powerCap = powerCapOf(caps);
  if (!powerCap) return;
  const reason = `rule ${ruleName}`;
  try {
    const cmds = buildGenericCommands(d, powerCap, { dp: powerCap.dp, kind: 'switch', value: false }, spec);
    await tuya.sendCommandsDual(d.id, cmds); // dual-API (see applyOn) — actuate v1/iot-03/v2
    tuya.invalidateFleet();
    logCircuit(d.id, 'power', null, 'off', reason, true, 'off');
  } catch (e) {
    logCircuit(d.id, 'power', null, 'off', reason, false, (e as Error).message);
  }
}

async function tick(): Promise<void> {
  try {
    const now = nowDM();
    if (!tuya.isConfigured()) {
      last = now;
      return;
    }
    if (!last) {
      last = now; // first tick establishes a baseline; never fire on boot
      return;
    }

    const schedules = store
      .get()
      .schedules.filter((s) => s.enabled && s.type === 'circuit' && s.scope.kind === 'unit');
    if (schedules.length === 0) {
      last = now;
      return;
    }

    const { sunriseMin, sunsetMin } = sunriseSunsetMin(config.site.lat, config.site.lon, new Date());
    const all = await tuya.getDevices();
    const byId = new Map(all.map((d) => [d.id, d]));
    const configured = store.get().deviceOnboarding.configured;

    for (const s of schedules) {
      const deviceId = (s.scope as { kind: 'unit'; deviceId: string }).deviceId;
      const d = byId.get(deviceId);
      if (!d) continue;
      const spec = await specFor(deviceId);
      const caps = applyOverrides(deriveCapabilities(d, spec), configured[deviceId]?.capOverrides);
      if (!powerCapOf(caps)) continue; // not a switchable device — skip

      for (const w of s.windows) {
        const startMin = resolveTimeMin(w.start, w.startAnchor, w.startOffsetMin ?? 0, sunriseMin, sunsetMin);
        const endMin = resolveTimeMin(w.end, w.endAnchor, w.endOffsetMin ?? 0, sunriseMin, sunsetMin);
        // A per-window action override (e.g. a different speed) inherits the rule action.
        const action: store.Action = { ...s.action, ...(w.action ?? {}) };
        for (const day of s.days) {
          if (crossed(last, now, day, startMin)) await applyOn(d, caps, spec, action, s.name);
          if (crossed(last, now, day, endMin)) await applyOff(d, caps, spec, s.name);
        }
      }
    }
    last = now;
  } catch (e) {
    store.update((st) => {
      st.devices.lastError = `device schedule tick failed: ${(e as Error).message}`;
    });
    console.error('[devices] schedule coordinator tick failed:', (e as Error).message);
  }
}

export function startDeviceScheduleCoordinator(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  console.log(`[devices] schedule coordinator started (every ${TICK_MS / 1000}s)`);
}

export function stopDeviceScheduleCoordinator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
