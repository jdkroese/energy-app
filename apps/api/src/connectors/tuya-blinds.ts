// Blinds / curtains — the second Tuya device CATEGORY built on the generic
// `tuya.ts` cloud foundation (after lights). Normalizes Tuya curtain-motor and
// curtain-switch devices into a single `BlindUnit` shape and maps the app's
// levers (open / close / stop / position) onto Tuya datapoint (DP) commands.
//
// Curtain motors (category 'cl') expose a small, well-established instruction set:
//   • control      — enum 'open' | 'close' | 'stop'
//   • percent_control — set target position 0–100
//   • percent_state   — current position 0–100
// Curtain SWITCHES (category 'clkg') are open/close/stop only (no position).
// DP codes and the meaning of 0/100 vary by firmware: many motors report 0 = open
// / 100 = closed, others the reverse. We expose a per-device `invert` setting so
// the user can flip it; everywhere in the app, positionPct is 100 = fully OPEN.

import type { TuyaDevice, TuyaStatusItem } from './tuya';

/** Tuya category codes that are "blinds/curtains" for this category screen. */
const BLIND_CATEGORIES = new Set(['cl', 'clkg']);

export function isBlind(d: TuyaDevice): boolean {
  return BLIND_CATEGORIES.has(d.category);
}

// DP code candidates, most common first. We pick the first one the device reports.
const CONTROL_CODES = ['control', 'mach_operate']; // enum open/close/stop
const PERCENT_CTRL_CODES = ['percent_control', 'position']; // settable target 0–100
const PERCENT_STATE_CODES = ['percent_state', 'position']; // current 0–100
const SWITCH_CODES = ['switch_1', 'switch']; // on/off curtain switches (open/close only)
const WORKSTATE_CODES = ['work_state', 'situation_set']; // 'opening' | 'closing' | ...

export interface BlindUnit {
  id: string;
  name: string;
  room: string;
  /** First-class Rooms model: assigned room id (null = Unassigned) + resolved name. Set at
   *  the route layer from the rooms store (the connector doesn't know about rooms). */
  roomId?: string | null;
  roomName?: string | null;
  category: string;
  online: boolean;
  /** Current position, 0 = fully closed, 100 = fully open (invert already applied). */
  positionPct: number | null;
  /** Whether the motor is currently travelling. */
  moving: boolean;
  /** Device exposes a settable target position (percent_control). */
  supportsPosition: boolean;
  /**
   * How this blind can be positioned:
   *  - 'native' — hardware percent_control DP (supportsPosition true).
   *  - 'timed'  — no native DP, but a travelSec is configured (simulate via a timed motor run).
   *  - null     — open/stop/close only (no positioning). The slider is hidden.
   * Native wins when both are available.
   */
  positionMode: 'native' | 'timed' | null;
  /** Configured full-travel seconds for a timed blind (undefined for native/none). */
  travelSec?: number;
  /**
   * Best-known position for a TIMED blind, 0–100 (100 = open). This is the server's
   * assumed position (no feedback), echoed so the card can render the slider. For a
   * native blind it mirrors positionPct.
   */
  assumedPct?: number | null;
  /** Timed blind: false when the assumed position is unknown (post-restart / never moved). */
  anchored?: boolean;
  /** Echo of the per-device invert setting that was applied. */
  inverted: boolean;
}

function statusMap(status: TuyaStatusItem[]): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const s of status) m[s.code] = s.value;
  return m;
}

function pick(dp: Record<string, unknown>, codes: string[]): string | null {
  for (const c of codes) if (c in dp) return c;
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Map a raw Tuya 0–100 to the app's "% open", flipping when inverted. */
function toOpenPct(raw: number, invert: boolean): number {
  const v = clamp(Math.round(raw), 0, 100);
  return invert ? 100 - v : v;
}
/** Map the app's "% open" back to the raw Tuya value to write. */
function fromOpenPct(openPct: number, invert: boolean): number {
  const v = clamp(Math.round(openPct), 0, 100);
  return invert ? 100 - v : v;
}

/** Normalize a Tuya curtain device into the app's BlindUnit shape.
 *  `runtime` carries the server's timed-position tracking (assumed % + anchored) so the
 *  card can render a slider for a timed blind that has no hardware feedback. */
export function normalizeBlind(
  d: TuyaDevice,
  opts?: {
    room?: string;
    invert?: boolean;
    travelSec?: number;
    runtime?: { assumedPct: number; anchored: boolean } | null;
  },
): BlindUnit {
  const invert = opts?.invert ?? false;
  const dp = statusMap(d.status);
  const stateCode = pick(dp, PERCENT_STATE_CODES);
  const percentCtrl = pick(dp, PERCENT_CTRL_CODES);
  const workCode = pick(dp, WORKSTATE_CODES);

  const positionPct =
    stateCode && typeof dp[stateCode] === 'number'
      ? toOpenPct(dp[stateCode] as number, invert)
      : null;

  const work = workCode ? String(dp[workCode]).toLowerCase() : '';
  const moving = work.includes('opening') || work.includes('closing') || work.includes('moving');

  const supportsPosition = percentCtrl !== null;
  const travelSec = opts?.travelSec;
  // Native positioning wins; otherwise a configured travelSec enables timed positioning.
  const positionMode: 'native' | 'timed' | null = supportsPosition
    ? 'native'
    : travelSec != null
      ? 'timed'
      : null;

  // assumedPct for the card: native → the real feedback; timed → the server's tracked value.
  const assumedPct =
    positionMode === 'native'
      ? positionPct
      : positionMode === 'timed'
        ? opts?.runtime?.assumedPct ?? null
        : null;

  return {
    id: d.id,
    name: d.name,
    room: opts?.room ?? d.name,
    category: d.category,
    online: d.online,
    positionPct,
    moving,
    supportsPosition,
    positionMode,
    travelSec: positionMode === 'timed' ? travelSec : undefined,
    assumedPct,
    anchored: positionMode === 'timed' ? opts?.runtime?.anchored ?? false : undefined,
    inverted: invert,
  };
}

export type BlindLever = 'open' | 'close' | 'stop' | 'position';
export const BLIND_LEVERS: BlindLever[] = ['open', 'close', 'stop', 'position'];

/**
 * Build the Tuya DP command list for a lever against a specific device, using the
 * codes that device actually reports. Throws (BAD_INPUT) if the device can't do
 * the requested lever. The route does auth/arm gating; this only shapes the write.
 */
export function buildCommands(
  d: TuyaDevice,
  lever: BlindLever,
  value: unknown,
  invert = false,
): Array<{ code: string; value: unknown }> {
  const dp = statusMap(d.status);
  const control = pick(dp, CONTROL_CODES);
  const percentCtrl = pick(dp, PERCENT_CTRL_CODES);
  const sw = pick(dp, SWITCH_CODES);
  const bad = (msg: string): never => {
    const e = new Error(msg) as Error & { code: string };
    e.code = 'BAD_INPUT';
    throw e;
  };

  if (lever === 'open' || lever === 'close') {
    const dir = lever; // 'open' | 'close'
    if (control) return [{ code: control, value: dir }];
    if (percentCtrl) return [{ code: percentCtrl, value: fromOpenPct(dir === 'open' ? 100 : 0, invert) }];
    if (sw) return [{ code: sw, value: dir === 'open' }];
    return bad(`blind ${d.id} cannot ${dir}`);
  }

  if (lever === 'stop') {
    if (control) return [{ code: control, value: 'stop' }];
    return bad(`blind ${d.id} has no stop control`);
  }

  // lever === 'position' (value is the app's 0–100 "% open")
  if (!percentCtrl) bad(`blind ${d.id} has no settable position`);
  const pct = Number(value);
  if (!Number.isFinite(pct)) bad('position must be 0–100');
  return [{ code: percentCtrl as string, value: fromOpenPct(pct, invert) }];
}
