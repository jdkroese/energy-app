// THROWAWAY SPIKE — proof we can detect a press on button 1 of a Tuya wireless
// 4-button Zigbee scene switch and flip an ON/OFF toggle on a debug page.
//
// Why device-LOGS, not status polling: polling /status returns the LAST DP value
// (e.g. switch_mode1="click"). Two identical clicks in a row look the same, so a
// status poll cannot tell them apart. Tuya's device-logs endpoint (type=7,
// DP-report) returns timestamped rows — we advance a watermark (lastSeenEventTime)
// and treat every NEW switch_mode1 row past the watermark as a fresh press.
//
// The switch is a Zigbee SUB-DEVICE of a gateway with its OWN device_id (category
// `wxkg`, productName ~"ZC-YED"). It only exists on the production fleet, so we
// resolve the id at runtime by scanning the fleet — never hardcoded.
//
// Self-stopping poller: only runs while the debug page is polling (client pings
// keep it alive; 15s of silence stops it). Touches NO control logic.

import { getDevices, getDeviceLogs } from '../connectors/tuya';

interface PressEvent {
  gesture: string;
  at: number;
}

const state: {
  deviceId: string | null;
  deviceName: string | null;
  online: boolean;
  on: boolean;
  lastSeenEventTime: number;
  lastPress: PressEvent | null;
  recent: PressEvent[];
  lastError: string | null;
  lastClientPing: number;
  timer: ReturnType<typeof setInterval> | null;
} = {
  deviceId: null,
  deviceName: null,
  online: false,
  on: false,
  lastSeenEventTime: 0,
  lastPress: null,
  recent: [],
  lastError: null,
  lastClientPing: 0,
  timer: null,
};

const BUTTON_DP = 'switch_mode1'; // button 1 of the 4-button scene switch

/** Find the scene switch in the Tuya fleet and cache its id/name/online. */
async function resolveDevice(): Promise<void> {
  if (state.deviceId) return;
  const devices = await getDevices();
  const match =
    devices.find((d) => d.category === 'wxkg') ??
    devices.find((d) => (d.productName ?? '').includes('ZC-YED')) ??
    devices.find((d) => d.name.toLowerCase().includes('scene'));
  if (!match) {
    state.lastError = 'scene switch not found in Tuya fleet';
    return;
  }
  state.deviceId = match.id;
  state.deviceName = match.name;
  state.online = match.online;
  state.lastError = null;
}

/** One poll cycle: pull recent DP-report rows, flip on each new button-1 press. */
async function poll(): Promise<void> {
  try {
    await resolveDevice();
    const id = state.deviceId;
    if (!id) return;

    const now = Date.now();
    const start = state.lastSeenEventTime || now - 60_000;
    const res = await getDeviceLogs(id, start, now + 5_000, 20);

    const rows = (res.logs ?? [])
      .filter((r) => r.code === BUTTON_DP)
      .sort((a, b) => a.event_time - b.event_time);

    for (const r of rows) {
      if (r.event_time <= state.lastSeenEventTime) continue;
      state.on = !state.on;
      state.lastPress = { gesture: r.value, at: r.event_time };
      state.recent.unshift({ gesture: r.value, at: r.event_time });
      if (state.recent.length > 10) state.recent.length = 10;
      state.lastSeenEventTime = r.event_time;
    }
    state.lastError = null;
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
  }
}

/** Start the self-stopping poller if it isn't already running. */
function ensurePoller(): void {
  if (state.timer) return;
  // Start the watermark at "now" so we don't replay old history and false-trigger.
  state.lastSeenEventTime = Date.now();
  state.timer = setInterval(() => {
    if (Date.now() - state.lastClientPing > 15_000) {
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      return;
    }
    void poll();
  }, 2000);
}

export interface ButtonTestState {
  resolved: boolean;
  deviceId: string | null;
  deviceName: string | null;
  online: boolean;
  on: boolean;
  lastPress: PressEvent | null;
  recent: PressEvent[];
  lastError: string | null;
}

/** Read the current state (also keeps the poller alive while the page polls). */
export function getButtonTestState(): ButtonTestState {
  state.lastClientPing = Date.now();
  ensurePoller();
  return {
    resolved: !!state.deviceId,
    deviceId: state.deviceId,
    deviceName: state.deviceName,
    online: state.online,
    on: state.on,
    lastPress: state.lastPress,
    recent: state.recent,
    lastError: state.lastError,
  };
}

/** Reset the toggle (debug convenience). */
export function resetButtonTest(): ButtonTestState {
  state.on = false;
  return getButtonTestState();
}
