// Scene-controller coordinator (wireless scene switches, Tuya category 'wxkg').
//
// A scene switch's buttons emit a momentary `switch_mode{N}` datapoint event on press
// (value 'single_click' | 'double_click' | 'long_press'). Status polling CANNOT see
// repeated presses, so every ~3s we read each enabled controller's DEVICE LOGS (type=7
// DP-report history) and act on any NEW press whose event_time is past the per-controller
// watermark. Each gesture has its OWN binding (single/double/long), and each TOGGLES its
// scene — a Light scene (Lights feature, kind==='light') or a whole-home scene (kind==='home'):
//   • binding.on false → apply the scene (applyHomeScene / applyScene(id,true)),  set on = true
//   • binding.on true  → switch it off (applyHomeSceneOff / applyScene(id,false)), set on = false
// The watermark advances to the max processed event_time so old history never replays
// (on first sight a controller's watermark is seeded to "now" so boot doesn't fire).
//
// This fires LIVE on press and is NOT battery-arm gated — the per-controller `enabled`
// flag is the only gate. It
// touches NO battery-control logic. Best-effort: every device + every scene apply is
// wrapped in try/catch so one failure never blocks the others. Modelled on the
// device-schedule + irrigation coordinators (a setInterval loop started at boot).

import * as store from '../store';
import * as tuya from '../connectors/tuya';
import { applyHomeScene, applyHomeSceneOff } from '../routes/home-scenes';
import { applyScene as applyLightScene } from '../routes/lights';

// 5s (was 3s): the log-poll is the app's single biggest Tuya API consumer (each tick is
// one call per enabled controller, 24/7 ≈ 17k calls/day at 5s) and it helped exhaust the
// IoT Core trial quota on 2026-07-03. Worst-case button→scene latency rises ~2s.
const TICK_MS = 5_000;
/** Cap on how far back the first log read reaches (ms) — we seed the watermark to now,
 *  but the API requires start<end; this is just the read window for the very first tick. */
const LOG_LOOKBACK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

// docs/51 Change 3: the scene switch is a Zigbee sub-device dropped from the rest of the Home
// app (docs/51 Change 2) — its whole-fleet cloud device-logs poll must stop by default too, so
// steady-state cloud usage is zero. `integrations.tuya.sceneControllersEnabled` is the
// reversible Settings toggle: undefined/false = OFF (the new default — zero device-logs
// calls), explicit true = the old always-on behaviour. Checked BOTH here (so an already-armed
// interval no-ops every tick when off) and in startControllerCoordinator() below (so the
// interval isn't even armed at boot when off — no wasted 5s timer firing a no-op forever).
/** Exported for tests. */
export function sceneControlEnabled(): boolean {
  return store.get().integrations.tuya?.sceneControllersEnabled === true;
}

/** Match a `switch_mode{N}` DP code → its 1-based button index, or null. */
function buttonIndexOf(code: string): number | null {
  const m = /^switch_mode(\d+)$/.exec(code);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

/** Tuya gesture DP value → our per-button binding key. */
const GESTURE_BY_VALUE: Record<string, 'single' | 'double' | 'long'> = {
  single_click: 'single',
  double_click: 'double',
  long_press: 'long',
};

/** Toggle one button's binding for a gesture (Light or Home scene), persisting on-state. */
async function toggleButtonBinding(
  deviceId: string,
  index: number,
  gesture: 'single' | 'double' | 'long',
  value: string,
): Promise<void> {
  // Re-read the binding fresh (it may have been edited mid-loop).
  const btn = store.get().sceneControllers[deviceId]?.buttons.find((b) => b.index === index);
  const binding = btn?.[gesture];
  if (!binding || !binding.sceneId) return;

  // Light scenes live in store.lightScenes; whole-home scenes in store.homeScenes.
  // A binding without an explicit kind (legacy) is treated as 'home'.
  const isLight = binding.kind === 'light';
  const scene = isLight
    ? store.get().lightScenes.find((x) => x.id === binding.sceneId)
    : store.get().homeScenes.find((x) => x.id === binding.sceneId);
  if (!scene) {
    console.error(`[scene-controller] btn ${index} ${value} -> ${isLight ? 'light' : 'home'} scene ${binding.sceneId} missing — skipped`);
    return;
  }

  const turnOn = !binding.on;
  try {
    if (isLight) {
      // applyScene(id, on): on=true applies saved states, on=false switches its lights off.
      await applyLightScene(binding.sceneId, turnOn);
    } else if (turnOn) {
      await applyHomeScene(binding.sceneId);
    } else {
      await applyHomeSceneOff(binding.sceneId);
    }
    // Persist the new toggle state for THIS gesture.
    store.update((s) => {
      const b = s.sceneControllers[deviceId]?.buttons.find((x) => x.index === index);
      const bind = b?.[gesture];
      if (bind) bind.on = turnOn;
    });
    console.log(`[scene-controller] btn ${index} ${value} -> ${isLight ? 'light' : 'home'} scene "${scene.name}" on=${turnOn}`);
  } catch (e) {
    console.error(`[scene-controller] btn ${index} ${value} apply failed for scene "${scene.name}":`, (e as Error).message);
  }
}

/** Process one controller: read its new press logs and toggle bound scenes per gesture. */
async function processController(deviceId: string, online: boolean): Promise<void> {
  const ctrl = store.get().sceneControllers[deviceId];
  if (!ctrl || !ctrl.enabled) return;
  if (!online) return; // offline switch can't report anything new

  const now = Date.now();
  // First sight (no watermark) → seed to now so historical presses never replay.
  if (ctrl.watermarkMs == null) {
    store.update((s) => {
      const c = s.sceneControllers[deviceId];
      if (c && c.watermarkMs == null) c.watermarkMs = now;
    });
    return;
  }

  const since = ctrl.watermarkMs;
  // Read a little before the watermark window opened; the API needs start<end.
  const start = Math.min(since, now - LOG_LOOKBACK_MS);
  let logs: tuya.TuyaDeviceLog[];
  try {
    const res = await tuya.getDeviceLogs(deviceId, start, now, 100);
    logs = res.logs ?? [];
  } catch (e) {
    console.error(`[scene-controller] log read failed for ${deviceId}:`, (e as Error).message);
    return;
  }

  // NEW button presses (any recognised gesture) on a switch_mode{N} code, oldest-first
  // so toggles apply in order.
  const events = logs
    .filter(
      (l) => l.event_time > since && GESTURE_BY_VALUE[l.value] != null && buttonIndexOf(l.code) != null,
    )
    .sort((a, b) => a.event_time - b.event_time);

  let maxTs = since;
  for (const ev of events) {
    if (ev.event_time > maxTs) maxTs = ev.event_time;
    const index = buttonIndexOf(ev.code);
    const gesture = GESTURE_BY_VALUE[ev.value];
    if (index == null || gesture == null) continue;
    await toggleButtonBinding(deviceId, index, gesture, ev.value);
  }

  // Advance the watermark past everything we just saw (even unbound presses) so we never
  // re-scan the same window.
  if (maxTs > since) {
    store.update((s) => {
      const c = s.sceneControllers[deviceId];
      if (c && (c.watermarkMs == null || maxTs > c.watermarkMs)) c.watermarkMs = maxTs;
    });
  }
}

/** Exported for tests. */
export async function tick(): Promise<void> {
  try {
    if (!sceneControlEnabled()) return; // docs/51 Change 3 — off by default, zero cloud calls
    if (!tuya.isConfigured()) return;
    const ids = Object.keys(store.get().sceneControllers).filter(
      (id) => store.get().sceneControllers[id]?.enabled,
    );
    if (ids.length === 0) return;

    // Per-controller direct reads (NOT the bulk tuya.getDevices() fleet listing): docs/51
    // Change 2 drops sub-devices/gateway from that listing unconditionally at the fleet
    // boundary, so a wxkg scene switch would never be found there any more. getDeviceDirect()
    // is a single-device cloud read (its own 20s/300s cache) untouched by that filter — the
    // right tool here since this loop only ever needs the handful of ids that are enabled.
    for (const id of ids) {
      const d = await tuya.getDeviceDirect(id);
      // Only a real, category-'wxkg' device gets log-polled (defensive — a binding could
      // outlive its device or be mis-targeted). Each controller is independently guarded.
      if (!d || d.category !== 'wxkg') continue;
      await processController(id, d.online);
    }
  } catch (e) {
    console.error('[scene-controller] coordinator tick failed:', (e as Error).message);
  }
}

export function startControllerCoordinator(): void {
  if (timer) return;
  if (!sceneControlEnabled()) {
    // docs/51 Change 3: don't even arm the interval when scene control is off — the scene
    // switch left the app by owner decision, so this is the "zero device-logs calls" state
    // by default, not just an idle no-op every 5s.
    console.log('[scene-controller] coordinator disabled (integrations.tuya.sceneControllersEnabled is not true) — no interval armed');
    return;
  }
  timer = setInterval(() => void tick(), TICK_MS);
  console.log(`[scene-controller] coordinator started (every ${TICK_MS / 1000}s, gated on per-controller enabled)`);
}

/** Stop the coordinator's interval (graceful shutdown / tests). Exported so tests can verify
 *  start/stop without leaking a live timer across test files. */
export function stopControllerCoordinator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
