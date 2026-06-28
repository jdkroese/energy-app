// Tuya onboarding INFERENCE — turns any paired Tuya device into a triageable
// "discovered device" the onboarding inbox (Devices → Needs setup) can show.
//
// The shipped category screens (lights, blinds) only surface a whitelist of
// categories; everything else the user paired (plugs, fans, sensors, locks,
// sirens, thermostats…) exists in the fleet but is invisible. This module makes
// those visible by deriving, for ANY device:
//   • proposedType  — coarse app type + icon, from the Tuya category code.
//   • capabilities[] — what the device can do/report, from its DP (datapoint)
//                      codes (spec functions = writable, spec status = readable).
//   • confidence     — how sure we are we could control it (high/monitor/review).
//   • roomGuess      — a room word parsed out of the device name, or null.
//
// PHASE 1 IS READ + TRIAGE ONLY: nothing here writes to a device. The capability
// vocabulary is deliberately a superset of what lights/blinds use so a later phase
// can build a generic control renderer on top of it without re-deriving.

import type { TuyaDevice, TuyaSpec } from './tuya';
import { proposedType, type ProposedType } from './tuya';

/** A normalized capability kind. Read-only kinds (`measure`, `status`) are sensor
 *  readouts; the rest are controllable levers a later phase can actuate. */
export type CapabilityKind =
  | 'switch' // on/off
  | 'range' // numeric setpoint / level (brightness, position, speed, temp…)
  | 'enum' // discrete mode/level choice
  | 'action' // momentary command (open/stop, trigger, reset, unlock)
  | 'color' // HSV colour
  | 'measure' // READ-ONLY numeric reading (temp, humidity, power, battery…)
  | 'status'; // READ-ONLY state flag (online, fault, tamper, contact…)

export interface Capability {
  kind: CapabilityKind;
  /** Stable key (the DP code) — used as the React key and a future control id. */
  key: string;
  /** Human label for the chip. */
  label: string;
  /** The Tuya DP code this capability maps to. */
  dp: string;
  /** Unit for a `measure` capability (°C, %, W, V…), when known. */
  unit?: string;
  /** Numeric bounds for a `range`/`measure`, when the spec provides them. */
  min?: number;
  max?: number;
  /** Allowed values for an `enum`, when the spec provides them. */
  options?: string[];
  /** True for sensor readouts (`measure`/`status`) — never written. */
  readOnly: boolean;
  /**
   * True for safety-critical `action` capabilities (lock/unlock, siren/alarm trigger,
   * garage/gate open) — the generic renderer requires a confirm tap before firing these.
   * Set by the inference from the device CATEGORY (locks/sirens/gates) and the DP CODE
   * (lock/unlock/trigger/alarm). Only ever set on `action` capabilities.
   */
  sensitive?: boolean;
}

export type Confidence = 'high' | 'monitor' | 'review';

export interface DiscoveredDevice {
  id: string;
  /** Raw Tuya device name (the inbox shows this verbatim). */
  name: string;
  category: string;
  productName: string | null;
  online: boolean;
  proposedType: ProposedType;
  capabilities: Capability[];
  confidence: Confidence;
  /** A room word parsed from the name (lowercased), or null. */
  roomGuess: string | null;
  /** A compact live readout for `monitor` rows (e.g. "21.4 °C · 48%"), or null. */
  readout: string | null;
}

// ---- DP-code → capability classification ------------------------------------
// Order matters: the FIRST matcher that fits a DP code wins. Read-only matchers
// (measure/status) come first so a `va_temperature` is never mistaken for a range.

interface Matcher {
  kind: CapabilityKind;
  test: (code: string) => boolean;
  label?: (code: string) => string;
  unit?: string;
  readOnly: boolean;
}

const has = (...needles: string[]) => (code: string) => needles.some((n) => code === n || code.includes(n));
const starts = (...prefixes: string[]) => (code: string) => prefixes.some((p) => code.startsWith(p));

/** Tidy a DP code into a chip label ("bright_value_v2" → "Bright value"). */
function prettify(code: string): string {
  const cleaned = code.replace(/_v\d+$/i, '').replace(/_\d+$/i, '').replace(/_/g, ' ').trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// READ-ONLY measures first (numeric sensor readings).
const MEASURE_MATCHERS: Matcher[] = [
  { kind: 'measure', test: has('va_temperature', 'temp_current'), label: () => 'Temperature', unit: '°C', readOnly: true },
  { kind: 'measure', test: has('va_humidity', 'humidity_value'), label: () => 'Humidity', unit: '%', readOnly: true },
  { kind: 'measure', test: has('pm25', 'pm25_value'), label: () => 'PM2.5', unit: 'µg/m³', readOnly: true },
  { kind: 'measure', test: has('cur_power'), label: () => 'Power', unit: 'W', readOnly: true },
  { kind: 'measure', test: has('cur_voltage'), label: () => 'Voltage', unit: 'V', readOnly: true },
  { kind: 'measure', test: has('cur_current'), label: () => 'Current', unit: 'mA', readOnly: true },
  { kind: 'measure', test: starts('battery'), label: () => 'Battery', unit: '%', readOnly: true },
  { kind: 'measure', test: starts('filter'), label: () => 'Filter life', unit: '%', readOnly: true },
];

// READ-ONLY status flags (state signals, not numbers).
const STATUS_MATCHERS: Matcher[] = [
  { kind: 'status', test: has('online'), label: () => 'Online', readOnly: true },
  { kind: 'status', test: has('fault'), label: () => 'Fault', readOnly: true },
  { kind: 'status', test: has('tamper'), label: () => 'Tamper', readOnly: true },
  { kind: 'status', test: starts('doorcontact'), label: () => 'Contact', readOnly: true },
];

// CONTROLLABLE levers.
const CONTROL_MATCHERS: Matcher[] = [
  { kind: 'color', test: starts('colour_data'), label: () => 'Colour', readOnly: false },
  { kind: 'action', test: has('lock_motor_state', 'unlock_request', 'manual_lock', 'remote_no_dp_key'), label: () => 'Lock', readOnly: false },
  // Exact match: a bare `control` DP is the curtain open/stop/close lever. Do NOT
  // use substring matching here — `percent_control` is a position RANGE, not an
  // action, and must fall through to the range matcher below.
  { kind: 'action', test: (c) => c === 'control' || c === 'mach_operate', label: () => 'Open / stop', readOnly: false },
  { kind: 'action', test: has('trigger', 'reset', 'factory_reset'), label: (c) => prettify(c), readOnly: false },
  { kind: 'enum', test: has('work_mode', 'mode', 'level'), label: (c) => prettify(c), readOnly: false },
  { kind: 'enum', test: (c) => c.endsWith('_mode'), label: (c) => prettify(c), readOnly: false },
  { kind: 'switch', test: starts('switch'), label: (c) => prettify(c), readOnly: false },
  { kind: 'switch', test: has('led_switch'), label: () => 'Switch', readOnly: false },
  { kind: 'range', test: starts('bright_value', 'temp_value', 'percent_control', 'position', 'fan_speed', 'temp_set'), label: (c) => prettify(c), readOnly: false },
  { kind: 'range', test: (c) => c.endsWith('_set'), label: (c) => prettify(c), readOnly: false },
];

const ALL_MATCHERS = [...MEASURE_MATCHERS, ...STATUS_MATCHERS, ...CONTROL_MATCHERS];

// ---- Sensitive-action detection ---------------------------------------------
// Owner decision: safety-critical `action` controls (locks, sirens/alarms,
// garage/gate opens) require a confirm tap before firing. We flag them by both
// the device CATEGORY and the DP CODE so a lock's "unlock" or a siren's "alarm"
// is gated even when the device's other (innocuous) actions are not.

/** Tuya category codes whose ACTIONS are safety-critical (door locks, sirens). */
const SENSITIVE_CATEGORIES = new Set([
  'ms', 'jtmspro', 'jtmsbh', 'mk', // door locks
  'sgbj', 'bjq', // sirens / alarms
  'ckmkzq', // garage door opener
]);

/** DP-code needles that mark an action as safety-critical regardless of category. */
const SENSITIVE_DP = (code: string): boolean =>
  /(^|_)(lock|unlock|trigger|alarm|siren|open_door|door_control|garage)(_|$)/i.test(code) ||
  code === 'manual_lock' || code === 'remote_no_dp_key' || code === 'unlock_request';

/** Whether an `action` capability on `category`/`code` must require a confirm tap. */
function isSensitiveAction(category: string, code: string): boolean {
  return SENSITIVE_CATEGORIES.has(category) || SENSITIVE_DP(code);
}

/** Classify one DP code into a capability, or null if nothing recognizes it.
 *  `category` (when known) lets `action` capabilities be flagged `sensitive`. */
function classify(code: string, spec?: { type?: string; values?: string }, category = ''): Capability | null {
  for (const m of ALL_MATCHERS) {
    if (!m.test(code)) continue;
    const cap: Capability = {
      kind: m.kind,
      key: code,
      label: m.label ? m.label(code) : prettify(code),
      dp: code,
      readOnly: m.readOnly,
    };
    if (m.unit) cap.unit = m.unit;
    // Flag safety-critical actions so the generic renderer confirms before firing.
    if (m.kind === 'action' && isSensitiveAction(category, code)) cap.sensitive = true;
    // Pull bounds / options off the spec's JSON `values` blob when present.
    if (spec?.values) {
      try {
        const v = JSON.parse(spec.values) as { min?: number; max?: number; unit?: string; range?: string[] };
        if (typeof v.min === 'number') cap.min = v.min;
        if (typeof v.max === 'number') cap.max = v.max;
        if (!cap.unit && typeof v.unit === 'string' && v.unit) cap.unit = v.unit;
        if (Array.isArray(v.range) && v.range.length) cap.options = v.range;
      } catch {
        /* non-JSON values blob — ignore */
      }
    }
    return cap;
  }
  return null;
}

/**
 * Derive the capability list for a device. Prefers the device SPEC (which marks
 * each DP as a function = writable or a status = readable, and carries bounds);
 * falls back to the live status DP codes when no spec is available. De-dupes by
 * DP code, writable-wins, so a code that appears in both function+status is shown
 * once as a control.
 */
export function deriveCapabilities(d: TuyaDevice, spec?: TuyaSpec | null): Capability[] {
  const byDp = new Map<string, Capability>();
  const add = (cap: Capability | null) => {
    if (!cap) return;
    const existing = byDp.get(cap.dp);
    // Writable beats read-only when the same DP shows up twice.
    if (!existing || (existing.readOnly && !cap.readOnly)) byDp.set(cap.dp, cap);
  };

  const category = d.category;
  if (spec && (spec.functions.length || spec.status.length)) {
    for (const f of spec.functions) {
      const cap = classify(f.code, f, category);
      // A DP that the spec lists under `functions` is writable — if our matcher
      // tagged it read-only (rare), trust the spec and keep it writable.
      add(cap && cap.readOnly && !isInherentlyReadOnly(f.code) ? { ...cap, readOnly: false } : cap);
    }
    for (const s of spec.status) {
      if (spec.functions.some((f) => f.code === s.code)) continue; // already added as writable
      add(classify(s.code, s, category));
    }
  }
  // Always also fold in live status codes (covers devices with no spec, and any
  // DP the spec omitted but the device actually reports).
  for (const s of d.status) {
    if (!byDp.has(s.code)) add(classify(s.code, undefined, category));
  }
  return [...byDp.values()];
}

/** DP codes that are always read-only regardless of where the spec lists them. */
function isInherentlyReadOnly(code: string): boolean {
  return (
    MEASURE_MATCHERS.some((m) => m.test(code)) || STATUS_MATCHERS.some((m) => m.test(code))
  );
}

// ---- Confidence -------------------------------------------------------------
// Known categories that carry a recognized control DP → `high`. A device that only
// reports read-only sensor capabilities → `monitor`. Everything else → `review`.

/** The control DP a category is EXPECTED to expose, for the `high` confidence test. */
const EXPECTED_CONTROL: Record<string, (caps: Capability[]) => boolean> = {
  dj: hasKind('switch'), dd: hasKind('switch'), dc: hasKind('switch'), fwd: hasKind('switch'),
  xdd: hasKind('switch'), tgq: hasKind('switch'), tyndj: hasKind('switch'), fsd: hasKind('switch'),
  cl: (c) => hasKind('action')(c) || hasKind('range')(c),
  clkg: (c) => hasKind('action')(c) || hasKind('switch')(c),
  cz: hasKind('switch'), pc: hasKind('switch'), kg: hasKind('switch'), tdq: hasKind('switch'), wkcz: hasKind('switch'),
  fs: (c) => hasKind('switch')(c) || hasKind('range')(c), fskg: hasKind('switch'),
  wk: (c) => hasKind('range')(c) || hasKind('enum')(c), wkf: (c) => hasKind('range')(c) || hasKind('enum')(c),
  qn: hasKind('switch'), ktkzq: hasKind('enum'),
};

function hasKind(kind: CapabilityKind) {
  return (caps: Capability[]) => caps.some((c) => c.kind === kind);
}

export function deriveConfidence(category: string, capabilities: Capability[]): Confidence {
  const expected = EXPECTED_CONTROL[category];
  if (expected && expected(capabilities)) return 'high';
  const hasControllable = capabilities.some((c) => !c.readOnly);
  if (!hasControllable && capabilities.length > 0) return 'monitor';
  return 'review';
}

// ---- Room guess -------------------------------------------------------------

const ROOM_WORDS = ['bedroom', 'kitchen', 'living', 'bathroom', 'office', 'hall', 'entrance', 'garage'];

/** Parse a room word out of a device name (lowercased), or null if none match. */
export function guessRoom(name: string): string | null {
  const lower = name.toLowerCase();
  return ROOM_WORDS.find((w) => lower.includes(w)) ?? null;
}

// ---- Live readout (for monitor rows) ----------------------------------------

/** Build a compact live readout string from a device's measure readings, or null. */
function buildReadout(d: TuyaDevice, capabilities: Capability[]): string | null {
  const status = new Map(d.status.map((s) => [s.code, s.value]));
  const parts: string[] = [];
  for (const cap of capabilities) {
    if (cap.kind !== 'measure') continue;
    const raw = status.get(cap.dp);
    if (typeof raw !== 'number') continue;
    // Many Tuya sensors report scaled-by-10 integers (e.g. 214 = 21.4°C). The spec
    // would carry the scale, but for a readout a simple heuristic suffices: a temp
    // or humidity over a plausible bound is divided by 10.
    let v = raw;
    if ((cap.unit === '°C' && Math.abs(raw) > 80) || (cap.unit === '%' && raw > 100)) v = raw / 10;
    parts.push(`${Number.isInteger(v) ? v : v.toFixed(1)}${cap.unit ? ` ${cap.unit}` : ''}`);
    if (parts.length >= 3) break;
  }
  return parts.length ? parts.join(' · ') : null;
}

// ---- Top-level: build a DiscoveredDevice ------------------------------------

// ---- Capability overrides (Advanced DP-remap editor) ------------------------

/** One per-DP override from the setup sheet's Advanced datapoints editor. */
export interface CapabilityOverride {
  dp: string;
  kind?: CapabilityKind;
  label?: string;
  hidden?: boolean;
  readOnly?: boolean;
}

/**
 * Apply the user's per-DP overrides on top of the inferred capabilities. An override
 * may change a capability's kind, relabel it, hide it (dropped from the list), or force
 * it read-only. Overrides keyed to a dp the device doesn't expose are ignored. The
 * resulting list is what the generic renderer drives and what writes are validated
 * against.
 */
export function applyOverrides(caps: Capability[], overrides?: CapabilityOverride[] | null): Capability[] {
  if (!overrides || overrides.length === 0) return caps;
  const byDp = new Map(overrides.map((o) => [o.dp, o]));
  const out: Capability[] = [];
  for (const cap of caps) {
    const o = byDp.get(cap.dp);
    if (!o) { out.push(cap); continue; }
    if (o.hidden) continue;
    const kind = o.kind ?? cap.kind;
    const readOnly =
      typeof o.readOnly === 'boolean' ? o.readOnly : kind === 'measure' || kind === 'status' ? true : cap.readOnly;
    out.push({ ...cap, kind, readOnly, ...(o.label ? { label: o.label } : {}) });
  }
  return out;
}

/** Assemble the full discovered-device view from a raw device + (optional) spec. */
export function toDiscovered(d: TuyaDevice, spec?: TuyaSpec | null): DiscoveredDevice {
  const capabilities = deriveCapabilities(d, spec);
  return {
    id: d.id,
    name: d.name,
    category: d.category,
    productName: d.productName ?? null,
    online: d.online,
    proposedType: proposedType(d.category),
    capabilities,
    confidence: deriveConfidence(d.category, capabilities),
    roomGuess: guessRoom(d.name),
    readout: buildReadout(d, capabilities),
  };
}
