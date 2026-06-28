// Generic Tuya capability writer — turns a capability-oriented command
// ({ dp, kind, value }) into the concrete Tuya DP command(s), with the correct
// inverse scaling per kind. This is the write counterpart to tuya-inference's
// read model: the onboarding generic renderer drives ANY set-up Tuya device
// (plug, fan, lock, siren, sensor-with-a-toggle…) through this single path,
// reusing the SAME scaling math the lights writer established.
//
// Scaling contract (mirrors tuya-lights):
//   • switch → boolean
//   • range  → app value 0..100 is mapped onto the device's [min,max] from the
//              spec (default Tuya 0..1000 when the spec omits bounds), EXCEPT a
//              range whose own bounds are already a small integer set (e.g. fan
//              speed 1..5) is sent verbatim within [min,max].
//   • enum   → string (validated against options when known)
//   • action → the command value verbatim (string|boolean), default the dp code's
//              conventional "go" value
//   • color  → HSV pack { h:0..360, s:0..1000, v:0..1000 } from app {h,s,v%}
//   • measure/status → read-only, never written (rejected upstream)

import type { TuyaDevice, TuyaSpec } from './tuya';
import type { Capability, CapabilityKind } from './tuya-inference';

function bad(msg: string): never {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  throw e;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Round an app percent (0..100) onto a device raw range [min,max]. */
function rawFromPct(pct: number, min: number, max: number): number {
  return Math.round(min + ((max - min) * clamp(pct, 0, 100)) / 100);
}

/** Parse a spec function/status DP's JSON `values` blob, or null when absent/non-JSON. */
function specValues(
  spec: TuyaSpec | null | undefined,
  dp: string,
): { min?: number; max?: number; range?: string[]; scale?: number } | null {
  if (!spec) return null;
  const fn = spec.functions.find((f) => f.code === dp) ?? spec.status.find((s) => s.code === dp);
  if (!fn?.values) return null;
  try {
    return JSON.parse(fn.values) as { min?: number; max?: number; range?: string[]; scale?: number };
  } catch {
    return null;
  }
}

/** Pull {min,max,range} bounds off a spec function's JSON `values` blob. */
function specBounds(spec: TuyaSpec | null | undefined, dp: string): { min?: number; max?: number; range?: string[] } {
  const v = specValues(spec, dp);
  if (!v) return {};
  return {
    ...(typeof v.min === 'number' ? { min: v.min } : {}),
    ...(typeof v.max === 'number' ? { max: v.max } : {}),
    ...(Array.isArray(v.range) ? { range: v.range } : {}),
  };
}

/**
 * The Tuya spec `scale` for a DP (raw / 10^scale → real units), when present.
 * Breakers report e.g. `cur_voltage` scale 1 (deci-volts), `cur_power` scale 1
 * (deci-watts), `cur_current` scale 0 (mA). Undefined when the spec omits scale.
 */
function specScale(spec: TuyaSpec | null | undefined, dp: string): number | undefined {
  const v = specValues(spec, dp);
  return v && typeof v.scale === 'number' && Number.isFinite(v.scale) ? v.scale : undefined;
}

export interface GenericCommandInput {
  dp: string;
  kind: CapabilityKind;
  value: unknown;
}

/**
 * Build the Tuya DP command list for a generic capability command against a
 * device. `cap` is the inference/override-resolved capability for this dp (its
 * min/max/options inform scaling); `spec` supplies raw bounds when the cap omits
 * them. Throws BAD_INPUT for read-only kinds or malformed values. The route does
 * auth gating + read-only validation; this only shapes the write.
 */
export function buildGenericCommands(
  _d: TuyaDevice,
  cap: Capability,
  input: GenericCommandInput,
  spec?: TuyaSpec | null,
): Array<{ code: string; value: unknown }> {
  const dp = input.dp;
  const kind = input.kind;

  if (kind === 'measure' || kind === 'status' || cap.readOnly) {
    bad(`${dp} is read-only`);
  }

  if (kind === 'switch') {
    return [{ code: dp, value: Boolean(input.value) }];
  }

  if (kind === 'range') {
    const n = Number(input.value);
    if (!Number.isFinite(n)) bad('range value must be a number');
    const bounds = specBounds(spec, dp);
    const min = cap.min ?? bounds.min ?? 0;
    const max = cap.max ?? bounds.max ?? 1000;
    // If the cap/spec exposes explicit small-integer bounds (e.g. fan speed 1..5),
    // the UI sends the value in device units already — clamp + round into range.
    // Otherwise treat the incoming value as an app percent (0..100) and scale it.
    const explicitBounds = (cap.min ?? bounds.min) !== undefined || (cap.max ?? bounds.max) !== undefined;
    const raw = explicitBounds ? Math.round(clamp(n, min, max)) : rawFromPct(n, min, max);
    return [{ code: dp, value: raw }];
  }

  if (kind === 'enum') {
    const s = String(input.value);
    const opts = cap.options ?? specBounds(spec, dp).range;
    if (opts && opts.length && !opts.includes(s)) bad(`${dp} value must be one of ${opts.join('|')}`);
    return [{ code: dp, value: s }];
  }

  if (kind === 'action') {
    // The renderer sends the desired command value (string|boolean). When absent,
    // default to the dp's conventional "go" — a string command echoes the dp's
    // primary option, else `true` for a momentary boolean trigger.
    if (input.value === undefined || input.value === null) {
      return [{ code: dp, value: true }];
    }
    return [{ code: dp, value: input.value as string | boolean }];
  }

  if (kind === 'color') {
    const c = (input.value ?? {}) as { h?: number; s?: number; v?: number };
    const h = clamp(Math.round(Number(c.h ?? 0)), 0, 360);
    const s = rawFromPct(Number(c.s ?? 100), 0, 1000);
    const v = rawFromPct(Number(c.v ?? 100), 0, 1000);
    return [{ code: dp, value: { h, s, v } }];
  }

  return bad(`unsupported capability kind ${kind}`);
}

/**
 * Read the live app-facing value for a capability from a device's status, applying
 * the inverse of the write scaling so the renderer shows current state. Returns
 * undefined when the dp isn't reported. (switch→bool, range→percent OR raw int for
 * explicit-bounds ranges, enum/measure→raw, status→raw, color→{h,s%,v%}.)
 */
export function readLiveValue(d: TuyaDevice, cap: Capability, spec?: TuyaSpec | null): unknown {
  const item = d.status.find((s) => s.code === cap.dp);
  if (!item) return undefined;
  const raw = item.value;

  if (cap.kind === 'switch') return Boolean(raw);
  if (cap.kind === 'enum' || cap.kind === 'status') return raw;

  if (cap.kind === 'range') {
    if (typeof raw !== 'number') return raw;
    const bounds = specBounds(spec, cap.dp);
    const explicitBounds = (cap.min ?? bounds.min) !== undefined || (cap.max ?? bounds.max) !== undefined;
    if (!explicitBounds) {
      const min = cap.min ?? bounds.min ?? 0;
      const max = cap.max ?? bounds.max ?? 1000;
      return max > min ? clamp(Math.round(((raw - min) / (max - min)) * 100), 0, 100) : 0;
    }
    return raw; // explicit-bounds range — report device units verbatim
  }

  if (cap.kind === 'measure') {
    // A measure reports raw device units; convert to real units before display.
    // Coerce numeric strings (some breaker firmwares report numbers as strings),
    // but pass a genuine non-numeric blob (e.g. a packed `phase_a` string) through.
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(num)) return raw;
    const scale = specScale(spec, cap.dp);
    let scaled: number;
    if (scale !== undefined) {
      scaled = num / 10 ** scale; // spec-driven: raw / 10^scale (e.g. cur_voltage scale 1 → ÷10)
    } else {
      // No spec scale — unit heuristic mirroring tuya-voltage's deci-unit detection.
      const unit = cap.unit;
      if (unit === 'V' && Math.abs(num) > 1000) scaled = num / 10;
      else if (unit === 'W' && Math.abs(num) > 100000) scaled = num / 10;
      else if (unit === '°C' && Math.abs(num) > 80) scaled = num / 10;
      else if (unit === '%' && num > 100) scaled = num / 10;
      else scaled = num;
    }
    return Math.round(scaled * 10) / 10; // 1 decimal max
  }

  if (cap.kind === 'color') {
    let obj: unknown = raw;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch { return null; }
    }
    if (obj && typeof obj === 'object') {
      const o = obj as { h?: number; s?: number; v?: number };
      if (typeof o.h === 'number' && typeof o.s === 'number' && typeof o.v === 'number') {
        return { h: clamp(Math.round(o.h), 0, 360), s: clamp(Math.round(o.s / 10), 0, 100), v: clamp(Math.round(o.v / 10), 0, 100) };
      }
    }
    return null;
  }

  return raw;
}
