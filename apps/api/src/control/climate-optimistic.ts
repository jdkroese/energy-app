// Server-side optimistic overlay for climate reads.
//
// Why this exists: a successful climate write does NOT show up in reads right away.
// Each connector caches its fleet (Intesis 30s, Airzone 10s, Panasonic 30s) and the
// cloud/device itself can lag a few seconds behind a set_ack. The client toggle hides
// that gap with its own optimistic state — but only while the Devices screen stays
// mounted. Navigate away and back (or just wait) and the client optimism is gone, so
// the UI reads the stale cache and the toggle shows the OLD status until the TTL
// expires. That made the on/off toggles unreliable.
//
// This records the last value we successfully wrote per (device, lever) and overlays
// it onto reads until the real read catches up (reconciled) or it ages out. It lives
// on the server, so it is shared by every client and independent of any UI lifecycle.
// It is applied to the READ endpoints only — never to the control path's unit lookup,
// so it can't make issueClimate() mistake a pending value for the real one.

import type { ClimateUnit } from '../connectors/intesis';
import type { ClimateLever } from './climate-guardrails';

type OverlayValue = boolean | number | string;
interface Entry {
  value: OverlayValue;
  at: number;
}

// Only levers that surface in a ClimateUnit read can be overlaid.
const OVERLAY_LEVERS: readonly ClimateLever[] = ['power', 'mode', 'setpoint'] as const;

// How long an unreconciled optimistic value survives. Long enough to cover cache TTL
// + cloud propagation, short enough that a write that silently didn't stick self-heals.
const TTL_MS = 60_000;

const overlay = new Map<string, Entry>();
const key = (id: string, lever: ClimateLever) => `${id}:${lever}`;

/** Record a value we just wrote so reads reflect it until the device catches up. */
export function recordWrite(id: string, lever: ClimateLever, value: OverlayValue): void {
  if (!OVERLAY_LEVERS.includes(lever)) return;
  overlay.set(key(id, lever), { value, at: Date.now() });
}

/** Forget any optimistic value for this lever (e.g. the command was rejected). */
export function clearWrite(id: string, lever: ClimateLever): void {
  overlay.delete(key(id, lever));
}

function readField(u: ClimateUnit, lever: ClimateLever): OverlayValue | null | undefined {
  return lever === 'power' ? u.power : lever === 'mode' ? u.mode : lever === 'setpoint' ? u.setpointC : undefined;
}

function withField(u: ClimateUnit, lever: ClimateLever, value: OverlayValue): ClimateUnit {
  if (lever === 'power') return { ...u, power: value as boolean };
  if (lever === 'mode') return { ...u, mode: value as string };
  if (lever === 'setpoint') return { ...u, setpointC: value as number };
  return u;
}

/**
 * Overlay recently-written values onto a freshly-read fleet. Drops an entry once the
 * real read matches it (reconciled) or it exceeds the TTL, so the overlay is
 * self-clearing and never masks genuine external changes for long. Pure w.r.t. the
 * input units (returns patched copies); mutates only the internal overlay map.
 */
export function applyOptimistic(units: ClimateUnit[]): ClimateUnit[] {
  if (overlay.size === 0) return units;
  const now = Date.now();
  return units.map((u) => {
    let patched = u;
    for (const lever of OVERLAY_LEVERS) {
      const k = key(u.id, lever);
      const entry = overlay.get(k);
      if (!entry) continue;
      if (now - entry.at > TTL_MS) { overlay.delete(k); continue; }
      if (readField(u, lever) === entry.value) { overlay.delete(k); continue; } // reconciled
      patched = withField(patched, lever, entry.value);
    }
    return patched;
  });
}

/** Test hook — clear all overlay state. */
export function _reset(): void {
  overlay.clear();
}
