// Lights — the first Tuya device CATEGORY built on the generic `tuya.ts` cloud
// foundation. Normalizes Tuya light devices (bulbs, strips, ceiling lights,
// dimmers) into a single `LightUnit` shape and maps the app's levers
// (power / brightness / colorTemp / color) onto Tuya datapoint (DP) commands.
//
// Tuya lights expose a small, well-established standard instruction set, but DP
// codes come in two generations ("_v2" and legacy) and a device may only support
// a subset. We detect which codes a device actually reports and drive those, so a
// plain dimmable bulb, a tunable-white bulb and a full RGBCW strip all flow
// through the same path. Scaling ranges (below) match Tuya's standard schema;
// odd firmware can be refined later via tuya.getSpecifications().

import type { TuyaDevice, TuyaStatusItem } from './tuya';

/** Tuya category codes that are "lights" for this category screen. NOTE: 'fsd'
 *  (ceiling-fan light) is intentionally EXCLUDED — a fan-with-light is a fan, not
 *  a light; it belongs to the (future) fan category, not the Lighting list. */
const LIGHT_CATEGORIES = new Set(['dj', 'dd', 'dc', 'fwd', 'xdd', 'tgq', 'tyndj']);

export function isLight(d: TuyaDevice): boolean {
  return LIGHT_CATEGORIES.has(d.category);
}

// DP code candidates, newest first. We pick the first one the device reports.
const SWITCH_CODES = ['switch_led', 'switch_led_1', 'led_switch', 'switch'];
const BRIGHT_CODES = ['bright_value_v2', 'bright_value', 'bright_value_1'];
const TEMP_CODES = ['temp_value_v2', 'temp_value', 'temp_value_1'];
const COLOUR_CODES = ['colour_data_v2', 'colour_data'];
const WORKMODE_CODES = ['work_mode'];

// Tuya standard schema ranges (the common case for dj/dd/dc/etc.).
const BRIGHT_MIN = 10;
const BRIGHT_MAX = 1000;
const TEMP_MIN = 0;
const TEMP_MAX = 1000;
// colour_data HSV: h 0–360, s 0–1000, v 0–1000.
const SAT_MAX = 1000;
const VAL_MAX = 1000;

export interface LightHsv {
  /** Hue 0–360. */
  h: number;
  /** Saturation 0–100 (percent; mapped to/from Tuya's 0–1000). */
  s: number;
  /** Value/brightness 0–100 (percent). */
  v: number;
}

export interface LightUnit {
  id: string;
  name: string;
  room: string;
  category: string;
  online: boolean;
  power: boolean;
  /** Brightness percent 1–100, or null if the device isn't dimmable. */
  brightnessPct: number | null;
  /** Colour-temperature percent 0–100 (0 = warmest, 100 = coolest), or null. */
  colorTempPct: number | null;
  /** Current HSV colour, or null if not in/­capable of colour mode. */
  color: LightHsv | null;
  /** 'white' | 'colour' | 'scene' | 'music' | null. */
  workMode: string | null;
  dimmable: boolean;
  tunable: boolean;
  colorable: boolean;
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

function pctFromRaw(raw: number, min: number, max: number): number {
  if (max <= min) return 0;
  return clamp(Math.round(((raw - min) / (max - min)) * 100), 0, 100);
}
function rawFromPct(pct: number, min: number, max: number): number {
  return Math.round(min + ((max - min) * clamp(pct, 0, 100)) / 100);
}

/** colour_data may arrive as a JSON string or an object — tolerate both. */
function parseColour(raw: unknown): { h: number; s: number; v: number } | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    if (typeof o.h === 'number' && typeof o.s === 'number' && typeof o.v === 'number') {
      return { h: o.h, s: o.s, v: o.v };
    }
  }
  return null;
}

/** Normalize a Tuya light device into the app's LightUnit shape. `nameOverride`
 *  is the user's custom name (from deviceSettings); falls back to the Tuya name. */
export function normalizeLight(d: TuyaDevice, nameOverride?: string): LightUnit {
  const dp = statusMap(d.status);
  const switchCode = pick(dp, SWITCH_CODES);
  const brightCode = pick(dp, BRIGHT_CODES);
  const tempCode = pick(dp, TEMP_CODES);
  const colourCode = pick(dp, COLOUR_CODES);
  const workCode = pick(dp, WORKMODE_CODES);

  const brightnessPct =
    brightCode && typeof dp[brightCode] === 'number'
      ? pctFromRaw(dp[brightCode] as number, BRIGHT_MIN, BRIGHT_MAX)
      : null;
  const colorTempPct =
    tempCode && typeof dp[tempCode] === 'number'
      ? pctFromRaw(dp[tempCode] as number, TEMP_MIN, TEMP_MAX)
      : null;
  const rawColour = colourCode ? parseColour(dp[colourCode]) : null;
  const color: LightHsv | null = rawColour
    ? { h: clamp(Math.round(rawColour.h), 0, 360), s: pctFromRaw(rawColour.s, 0, SAT_MAX), v: pctFromRaw(rawColour.v, 0, VAL_MAX) }
    : null;

  const name = nameOverride?.trim() || d.name;
  return {
    id: d.id,
    name,
    room: name,
    category: d.category,
    online: d.online,
    power: switchCode ? Boolean(dp[switchCode]) : false,
    brightnessPct,
    colorTempPct,
    color,
    workMode: workCode ? String(dp[workCode]) : null,
    dimmable: brightCode !== null,
    tunable: tempCode !== null,
    colorable: colourCode !== null,
  };
}

export type LightLever = 'power' | 'brightness' | 'colorTemp' | 'color';
export const LIGHT_LEVERS: LightLever[] = ['power', 'brightness', 'colorTemp', 'color'];

/**
 * Build the Tuya DP command list for a lever against a specific device, using the
 * codes that device actually reports. Throws (BAD_INPUT) if the device can't do
 * the requested lever. The route does auth/arm gating; this only shapes the write.
 */
export function buildCommands(d: TuyaDevice, lever: LightLever, value: unknown): Array<{ code: string; value: unknown }> {
  const dp = statusMap(d.status);
  const bad = (msg: string): never => {
    const e = new Error(msg) as Error & { code: string };
    e.code = 'BAD_INPUT';
    throw e;
  };

  if (lever === 'power') {
    const code = pick(dp, SWITCH_CODES);
    if (!code) bad(`light ${d.id} has no power switch`);
    return [{ code: code as string, value: Boolean(value) }];
  }

  if (lever === 'brightness') {
    const code = pick(dp, BRIGHT_CODES);
    if (!code) bad(`light ${d.id} is not dimmable`);
    const pct = Number(value);
    if (!Number.isFinite(pct)) bad('brightness must be 0–100');
    const cmds: Array<{ code: string; value: unknown }> = [{ code: code as string, value: rawFromPct(pct, BRIGHT_MIN, BRIGHT_MAX) }];
    // Brightness applies in white mode — switch out of colour so it's visible.
    const work = pick(dp, WORKMODE_CODES);
    if (work && String(dp[work]) === 'colour') cmds.unshift({ code: work, value: 'white' });
    return cmds;
  }

  if (lever === 'colorTemp') {
    const code = pick(dp, TEMP_CODES);
    if (!code) bad(`light ${d.id} has no tunable white`);
    const pct = Number(value);
    if (!Number.isFinite(pct)) bad('colorTemp must be 0–100');
    const cmds: Array<{ code: string; value: unknown }> = [{ code: code as string, value: rawFromPct(pct, TEMP_MIN, TEMP_MAX) }];
    const work = pick(dp, WORKMODE_CODES);
    if (work) cmds.unshift({ code: work, value: 'white' });
    return cmds;
  }

  // lever === 'color'
  const code = pick(dp, COLOUR_CODES);
  if (!code) bad(`light ${d.id} has no colour`);
  const c = (value ?? {}) as Partial<LightHsv>;
  const h = clamp(Math.round(Number(c.h ?? 0)), 0, 360);
  const s = rawFromPct(Number(c.s ?? 100), 0, SAT_MAX);
  const v = rawFromPct(Number(c.v ?? 100), 0, VAL_MAX);
  const cmds: Array<{ code: string; value: unknown }> = [{ code: code as string, value: { h, s, v } }];
  const work = pick(dp, WORKMODE_CODES);
  if (work) cmds.unshift({ code: work, value: 'colour' });
  return cmds;
}
