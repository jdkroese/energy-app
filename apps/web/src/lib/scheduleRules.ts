// Client-side mirror of the server's rule-overlap logic (apps/api/src/schedule-rules.ts)
// plus small display helpers shared by the schedule components. The editor uses
// checkRuleOverlap to block Save; the server re-validates on write.

import type { Action, DeviceType, RunCondition, Schedule, ScheduleWindow, TimeAnchor } from './types';

export interface DaySegment {
  day: number; // 0=Sun..6=Sat
  start: number; // minutes [0,1440)
  end: number; // minutes (0,1440]
}

export function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Expand a rule's (days × windows) into concrete per-weekday minute segments. */
export function expandSegments(days: number[], windows: ScheduleWindow[]): DaySegment[] {
  const segs: DaySegment[] = [];
  for (const day of days) {
    for (const w of windows) {
      const a = hhmmToMin(w.start);
      const b = hhmmToMin(w.end);
      if (a < b) {
        segs.push({ day, start: a, end: b });
      } else {
        if (a < 1440) segs.push({ day, start: a, end: 1440 });
        if (b > 0) segs.push({ day: (day + 1) % 7, start: 0, end: b });
      }
    }
  }
  return segs;
}

function segsOverlap(x: DaySegment, y: DaySegment): boolean {
  return x.day === y.day && x.start < y.end && y.start < x.end;
}

export function selfOverlaps(segs: DaySegment[]): boolean {
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) if (segsOverlap(segs[i], segs[j])) return true;
  return false;
}

export function setsOverlap(a: DaySegment[], b: DaySegment[]): boolean {
  for (const x of a) for (const y of b) if (segsOverlap(x, y)) return true;
  return false;
}

export function sameUnit(a: Schedule, b: Schedule): boolean {
  return a.scope.kind === 'unit' && b.scope.kind === 'unit' && a.scope.deviceId === b.scope.deviceId;
}

export interface OverlapCheck {
  ok: boolean;
  reason: string;
}

/** Validate a candidate rule against itself and the other enabled rules on its unit. */
export function checkRuleOverlap(candidate: Schedule, others: Schedule[]): OverlapCheck {
  const mine = expandSegments(candidate.days, candidate.windows);
  if (selfOverlaps(mine)) return { ok: false, reason: 'Time windows overlap each other.' };
  if (!candidate.enabled) return { ok: true, reason: 'ok' };
  for (const o of others) {
    if (!o.enabled || o.id === candidate.id || !sameUnit(candidate, o)) continue;
    if (setsOverlap(mine, expandSegments(o.days, o.windows))) {
      return { ok: false, reason: `Overlaps “${o.name}” on this unit.` };
    }
  }
  return { ok: true, reason: 'ok' };
}

/** Would `candidate` overlap any enabled rule already on `deviceId`? (for Copy-to-units) */
export function wouldOverlapUnit(candidate: Schedule, deviceId: string, all: Schedule[]): boolean {
  const probe: Schedule = { ...candidate, scope: { kind: 'unit', deviceId } };
  return !checkRuleOverlap(probe, all).ok;
}

// ---- Display helpers --------------------------------------------------------

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const fanLabel = (f: Action['fan']): string => (f === 'auto' ? 'auto' : `fan ${f}`);

/** Blinds target → label: "open" / "close" / "to 40%". */
export function blindTargetLabel(positionPct: number): string {
  if (positionPct >= 98) return 'open';
  if (positionPct <= 2) return 'close';
  return `to ${positionPct}% open`;
}

/** Short mono action summary, e.g. "cool 24° · fan auto" (or "close" for blinds). */
export function actionSummary(s: Schedule): string {
  if (s.type === 'blinds') return blindTargetLabel(s.action.positionPct ?? 0);
  if (s.type === 'circuit') {
    return 'on'
      + (s.action.speed != null ? ` · speed ${s.action.speed}` : '')
      + (s.action.direction ? ` · ${s.action.direction}` : '');
  }
  const a = s.action;
  if (!a.power) return 'off';
  const parts = [`${a.mode} ${a.setpointC}°`];
  if (a.fan !== 'auto') parts.push(fanLabel(a.fan));
  return parts.join(' · ');
}

function anchorLabel(hhmm: string, anchor?: TimeAnchor, offsetMin?: number): string {
  if (!anchor || anchor === 'fixed') return hhmm;
  const base = anchor === 'sunrise' ? 'Sunrise' : 'Sunset';
  const off = offsetMin ?? 0;
  if (off === 0) return base;
  return off > 0 ? `${base}+${off}m` : `${base}${off}m`;
}

/** Window list rendered compactly, e.g. "14:00–17:00 · 20:00–23:00". */
export function windowsSummary(windows: ScheduleWindow[]): string {
  return windows
    .map((w) => `${anchorLabel(w.start, w.startAnchor, w.startOffsetMin)}–${anchorLabel(w.end, w.endAnchor, w.endOffsetMin)}`)
    .join(' · ');
}

/** Condition tag text + tone, or null when 'always'. */
export function conditionTag(c: RunCondition): { text: string; tone: 'warm' | 'cool' } | null {
  if (c.kind === 'warmerThan') return { text: `if >${c.thresholdC}°`, tone: 'warm' };
  if (c.kind === 'coolerThan') return { text: `if <${c.thresholdC}°`, tone: 'cool' };
  return null;
}

export const TYPE_LABEL: Record<DeviceType, string> = {
  cooling: 'Cooling',
  heating: 'Heating',
  lighting: 'Lighting',
  circuit: 'Circuits',
  blinds: 'Blinds',
};

/** Accent colour per device type, matching the Power palette. */
export const TYPE_COLOR: Record<DeviceType, string> = {
  cooling: 'var(--battery)',
  heating: 'var(--grid)',
  lighting: 'var(--solar)',
  circuit: 'var(--home)',
  blinds: 'var(--ev)',
};

/** A fresh default rule for "+ Add rule" on a given unit + type. */
export function newRuleDraft(opts: { type: DeviceType; deviceId: string; name?: string }): Schedule {
  const isHeat = opts.type === 'heating';
  const isBlind = opts.type === 'blinds';
  const isCircuit = opts.type === 'circuit';
  // Climate fields are required by Action but ignored on blinds / circuit rules.
  const baseClimate = {
    power: true,
    mode: (isHeat ? 'heat' : 'cool') as Action['mode'],
    setpointC: isHeat ? 21 : 24,
    fan: 'auto' as const,
    vaneUpDown: 'auto' as const,
    vaneLeftRight: 'auto' as const,
  };
  const name = opts.name
    ?? (isBlind ? 'Close at night' : isCircuit ? 'On schedule' : isHeat ? 'Heating rule' : 'Cooling rule');
  const windows = isBlind
    ? [{ start: '21:00', end: '07:00' }] // close overnight by default
    : isCircuit
      ? [{ start: '18:00', end: '23:00' }] // on in the evening by default
      : [{ start: isHeat ? '06:00' : '14:00', end: isHeat ? '08:00' : '17:00' }];
  return {
    id: '',
    name,
    enabled: true,
    type: opts.type,
    scope: { kind: 'unit', deviceId: opts.deviceId },
    days: [1, 2, 3, 4, 5],
    windows,
    // Circuit: on during the window, off after — no speed/direction set (leave as-is).
    action: isBlind ? { ...baseClimate, positionPct: 0 } : baseClimate,
    condition: { kind: 'always' },
  };
}
