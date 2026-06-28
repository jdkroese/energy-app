// Configured-lighting bridge — promotes a user-SET-UP Tuya device (typeId
// 'lighting') into a first-class member of the LIGHT fleet. Native lights flow
// through tuya-lights.ts on a fixed DP whitelist; a configured device instead
// carries inferred (+ override-applied) capabilities, so here we RESOLVE which of
// its datapoints act as the on/off, brightness, white-temp and colour levers, then
// normalize + build commands using the SAME light scaling math tuya-lights uses.
//
// This is what makes configured-lighting devices appear in the light grid, in
// Scenes/Schedules member pickers, and respond to scene/schedule apply — every one
// of those paths is fleet-driven, and this module makes such a device look like a
// LightUnit with a working command builder.

import type { TuyaDevice } from './tuya';
import type { LightUnit, LightLever, LightHsv } from './tuya-lights';
import { deriveCapabilities, applyOverrides, type Capability } from './tuya-inference';
import type { TuyaSpec } from './tuya';
import type { CapabilityOverride } from '../store';

// Light scaling constants — IDENTICAL to tuya-lights.ts (Tuya standard schema).
const BRIGHT_MIN = 10;
const BRIGHT_MAX = 1000;
const TEMP_MIN = 0;
const TEMP_MAX = 1000;
// colour_data HSV: h 0–360, s 0–1000, v 0–1000.
const SAT_MAX = 1000;
const VAL_MAX = 1000;

// ---- small helpers (duplicated from tuya-lights to keep risk low) -----------

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

function statusMap(d: TuyaDevice): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const s of d.status) m[s.code] = s.value;
  return m;
}

// ---- capability resolution --------------------------------------------------

export interface ConfiguredLightCaps {
  /** Main on/off switch capability, or undefined (then SKIP from the light fleet). */
  powerDp?: Capability;
  /** Brightness range capability (bright_value*), or undefined. */
  brightDp?: Capability;
  /** White-temperature range capability (temp_value*), or undefined. */
  tempDp?: Capability;
  /** Colour capability (colour_data*), or undefined. */
  colorDp?: Capability;
}

/** Non-power switch DP needles that must NEVER be treated as the main on/off. A
 *  metering plug/breaker synthesizes many boolean toggles (child lock, overcharge
 *  protection, cycle/random timers, countdown, inching…) into `switch`-kind caps;
 *  none of those drive the relay, so they're excluded as power candidates. */
function isNonPowerSwitch(dp: string): boolean {
  const lower = dp.toLowerCase();
  return [
    'inching', 'backlight', 'child', 'memory', 'overcharge',
    'cycle', 'random', 'countdown', 'lock', 'factory', 'test',
  ].some((n) => lower.includes(n));
}

/** Canonical main-relay switch codes, most-preferred first. The real on/off is one
 *  of these — prefer it over an arbitrary first synthesized switch so a metering
 *  plug actuates its relay (`switch_1`), not e.g. its overcharge toggle. */
const POWER_SWITCH_CODES = [
  'switch_led', 'switch_1', 'switch', 'switch_2', 'switch_3', 'switch_4', 'switch_5', 'switch_6',
];

/** Pick the capability that acts as the device's main on/off. */
function pickPowerSwitch(caps: Capability[]): Capability | undefined {
  const switches = caps.filter((c) => c.kind === 'switch' && !c.readOnly && !isNonPowerSwitch(c.dp));
  // 1) a canonical relay code (covers virtually every plug/switch/breaker).
  for (const code of POWER_SWITCH_CODES) {
    const m = switches.find((s) => s.dp === code);
    if (m) return m;
  }
  // 2) any other real `switch*` relay, then any leftover switch-kind capability.
  return switches.find((s) => s.dp.startsWith('switch')) ?? switches[0];
}

/**
 * Resolve which datapoints act as the light levers for a configured device,
 * using the inferred + override-applied capability list. Only `bright_value*`,
 * `temp_value*` and `colour_data*` map to brightness/temp/colour — everything else
 * stays off the light card (it lives on the device detail screen).
 */
export function resolveConfiguredLightCaps(
  d: TuyaDevice,
  cfg: { capOverrides?: CapabilityOverride[] },
  spec: TuyaSpec | null,
): ConfiguredLightCaps {
  const caps = applyOverrides(deriveCapabilities(d, spec), cfg.capOverrides);

  const powerDp = pickPowerSwitch(caps);
  const brightDp = caps.find((c) => c.kind === 'range' && c.dp.startsWith('bright_value'));
  const tempDp = caps.find((c) => c.kind === 'range' && c.dp.startsWith('temp_value'));
  const colorDp = caps.find((c) => c.kind === 'color');

  return { powerDp, brightDp, tempDp, colorDp };
}

// ---- normalize → LightUnit --------------------------------------------------

/**
 * Normalize a configured-lighting device into the app's LightUnit shape, marked
 * `configured: true`. Returns null when the device exposes no usable power switch
 * (it must then be skipped from the light fleet). `nameOverride` is the user's
 * deviceSettings name; falls back to cfg.name then the Tuya name.
 */
export function normalizeConfiguredLight(
  d: TuyaDevice,
  cfg: { name?: string; capOverrides?: CapabilityOverride[] },
  spec: TuyaSpec | null,
  nameOverride?: string,
): LightUnit | null {
  const caps = resolveConfiguredLightCaps(d, cfg, spec);
  if (!caps.powerDp) return null;

  const dp = statusMap(d);

  const rangePct = (cap: Capability | undefined, defMin: number, defMax: number): number | null => {
    if (!cap) return null;
    const raw = dp[cap.dp];
    if (typeof raw !== 'number') return null;
    const min = cap.min ?? defMin;
    const max = cap.max ?? defMax;
    return pctFromRaw(raw, min, max);
  };

  const brightnessPct = rangePct(caps.brightDp, BRIGHT_MIN, BRIGHT_MAX);
  const colorTempPct = rangePct(caps.tempDp, TEMP_MIN, TEMP_MAX);

  const rawColour = caps.colorDp ? parseColour(dp[caps.colorDp.dp]) : null;
  const color: LightHsv | null = rawColour
    ? {
        h: clamp(Math.round(rawColour.h), 0, 360),
        s: pctFromRaw(rawColour.s, 0, SAT_MAX),
        v: pctFromRaw(rawColour.v, 0, VAL_MAX),
      }
    : null;

  const name = nameOverride?.trim() || cfg.name?.trim() || d.name;

  return {
    id: d.id,
    name,
    room: name,
    category: d.category,
    online: d.online,
    power: Boolean(dp[caps.powerDp.dp]),
    brightnessPct,
    colorTempPct,
    color,
    // These devices aren't standard light bulbs and carry no work_mode lever.
    workMode: null,
    dimmable: !!caps.brightDp,
    tunable: !!caps.tempDp,
    colorable: !!caps.colorDp,
    configured: true,
  };
}

// ---- command builder --------------------------------------------------------

function badInput(msg: string): never {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  throw e;
}

/**
 * Build the Tuya DP command list for a light lever against a configured device,
 * using its resolved capability dps and the SAME scaling as tuya-lights. Throws
 * BAD_INPUT when the device can't do the requested lever. No work_mode juggling —
 * these aren't standard bulbs.
 */
export function buildConfiguredLightCommands(
  _d: TuyaDevice,
  caps: ConfiguredLightCaps,
  lever: LightLever,
  value: unknown,
): Array<{ code: string; value: unknown }> {
  if (lever === 'power') {
    if (!caps.powerDp) badInput('light has no power switch');
    return [{ code: caps.powerDp!.dp, value: Boolean(value) }];
  }

  if (lever === 'brightness') {
    if (!caps.brightDp) badInput('light is not dimmable');
    const pct = Number(value);
    if (!Number.isFinite(pct)) badInput('brightness must be 0–100');
    return [{ code: caps.brightDp!.dp, value: rawFromPct(pct, BRIGHT_MIN, BRIGHT_MAX) }];
  }

  if (lever === 'colorTemp') {
    if (!caps.tempDp) badInput('light has no tunable white');
    const pct = Number(value);
    if (!Number.isFinite(pct)) badInput('colorTemp must be 0–100');
    return [{ code: caps.tempDp!.dp, value: rawFromPct(pct, TEMP_MIN, TEMP_MAX) }];
  }

  // lever === 'color'
  if (!caps.colorDp) badInput('light has no colour');
  const c = (value ?? {}) as Partial<LightHsv>;
  const h = clamp(Math.round(Number(c.h ?? 0)), 0, 360);
  const s = rawFromPct(Number(c.s ?? 100), 0, SAT_MAX);
  const v = rawFromPct(Number(c.v ?? 100), 0, VAL_MAX);
  return [{ code: caps.colorDp!.dp, value: { h, s, v } }];
}
