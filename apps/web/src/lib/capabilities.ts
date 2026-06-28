// Capability triage for the GENERIC device renderer. A "never drop a DP" device
// (fan plug, ceiling fan, …) can surface a long list of capabilities — countdown,
// coe, voltage, fault, mode, direction… The listing CARD should only show the
// everyday levers (on/off + the main level, e.g. fan speed); everything else lives
// on the detail page behind a "More controls & configuration" disclosure.
//
// Pure + side-effect-free so it's trivially unit-testable.

import type { Capability } from './types';

/** Primary power/light switch DPs (the everyday on/off lever). */
const PRIMARY_SWITCH_DPS = new Set([
  'switch', 'switch_1', 'switch_2', 'switch_3', 'switch_4', 'switch_5', 'switch_6',
  'fan_switch', 'switch_led', 'led_switch', 'light',
]);

/** Prefixes for a main LEVEL range (brightness, percent, position, dimmer). */
const PRIMARY_RANGE_PREFIXES = ['bright_value', 'percent_control', 'position', 'dimmer'];

/** Is this capability a primary power/light switch? */
function isPrimarySwitch(c: Capability): boolean {
  return c.kind === 'switch' && PRIMARY_SWITCH_DPS.has(c.dp);
}

/**
 * Does this device have a power on/off switch (so it's schedulable as a circuit)?
 * ANY controllable (writable) switch capability qualifies — a relay/plug whose
 * on/off DP is non-standard (not in the curated primary set) must NOT be excluded
 * from scheduling. The schedule coordinator's `powerCapOf` still PREFERS a curated
 * primary-power DP and falls back to the first switch, so the right lever is driven.
 */
export function hasPowerSwitch(caps: Capability[]): boolean {
  return caps.some((c) => c.kind === 'switch' && !c.readOnly);
}

/** Is this capability a main LEVEL range (fan speed / brightness / position / dimmer)? */
function isPrimaryRange(c: Capability): boolean {
  if (c.kind !== 'range') return false;
  if (c.dp === 'fan_speed') return true;
  return PRIMARY_RANGE_PREFIXES.some((p) => c.dp.startsWith(p));
}

/** True for a capability that can be actuated (not a read-only sensor readout). */
function isControllable(c: Capability): boolean {
  return c.kind !== 'measure' && c.kind !== 'status' && !c.readOnly;
}

/**
 * The everyday levers to show on a listing card: primary power/light switches +
 * the main level range (fan speed / brightness / position / dimmer). Everything
 * else (enums like direction/mode, countdown ranges, measures, statuses, actions)
 * is excluded.
 *
 * FALLBACK so a non-fan/plug device never gets an empty card:
 *   1. if nothing matched, fall back to all controllable (non-sensor) caps;
 *   2. if THAT is empty, fall back to up to 3 measure caps (a sensor readout);
 *   3. if still empty, return the original list.
 */
export function primaryCapabilities(caps: Capability[]): Capability[] {
  const primary = caps.filter((c) => isPrimarySwitch(c) || isPrimaryRange(c));
  if (primary.length) return primary;

  const controllable = caps.filter(isControllable);
  if (controllable.length) return controllable;

  const measures = caps.filter((c) => c.kind === 'measure').slice(0, 3);
  if (measures.length) return measures;

  return caps;
}

/** The remaining caps (preserve order) — the detail "More controls" section. */
export function secondaryCapabilities(caps: Capability[]): Capability[] {
  const primary = new Set(primaryCapabilities(caps));
  return caps.filter((c) => !primary.has(c));
}

/**
 * The power on/off switch for a device: a primary-power switch DP if present, else
 * the first switch cap, else null. Mirrors the server's powerCapOf so the breaker
 * card drives the same DP the scheduler does.
 */
export function powerCap(caps: Capability[]): Capability | null {
  return (
    caps.find((c) => c.kind === 'switch' && PRIMARY_SWITCH_DPS.has(c.dp)) ??
    caps.find((c) => c.kind === 'switch') ??
    null
  );
}

/**
 * The first measure capability whose dp (lowercased) contains `needle` —
 * e.g. findMeasure(caps, 'current') → cur_current, findMeasure(caps, 'voltage') → cur_voltage.
 */
export function findMeasure(caps: Capability[], needle: string): Capability | null {
  const n = needle.toLowerCase();
  return caps.find((c) => c.kind === 'measure' && c.dp.toLowerCase().includes(n)) ?? null;
}
