// Shared rule-overlap logic for schedules (rules). Enforced server-side on every
// schedule write and mirrored client-side in the editor (apps/web). The hard rule:
// for a single unit, two ENABLED rules may not cover the same minute on the same
// weekday, and windows within one rule may not overlap each other.
//
// A window that wraps past midnight (end <= start) is expanded into two segments
// before comparing — the evening part stays on its start day, the morning part
// moves to the next weekday (matching the coordinator's runtime semantics).

import type { Schedule, ScheduleWindow } from './store';

export interface DaySegment {
  day: number; // 0=Sun..6=Sat
  start: number; // minutes [0,1440)
  end: number; // minutes (0,1440]
}

function hhmmToMin(s: string): number {
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
        // wraps past midnight (or all-day when a === b): evening + next-day morning.
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

/** Do any two of these segments overlap (e.g. two windows within one rule)? */
export function selfOverlaps(segs: DaySegment[]): boolean {
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (segsOverlap(segs[i], segs[j])) return true;
    }
  }
  return false;
}

/** Do two segment sets share any covered minute? */
export function setsOverlap(a: DaySegment[], b: DaySegment[]): boolean {
  for (const x of a) for (const y of b) if (segsOverlap(x, y)) return true;
  return false;
}

/** Rules are "on the same unit" when both are unit-scoped to the same device. */
export function sameUnit(a: Schedule, b: Schedule): boolean {
  return a.scope.kind === 'unit' && b.scope.kind === 'unit' && a.scope.deviceId === b.scope.deviceId;
}

export interface OverlapCheck {
  ok: boolean;
  reason: string;
}

/**
 * Validate a candidate rule against itself and against the other enabled rules
 * on the same unit. `others` should already exclude the candidate (by id).
 */
export function checkRuleOverlap(candidate: Schedule, others: Schedule[]): OverlapCheck {
  const mine = expandSegments(candidate.days, candidate.windows);
  if (selfOverlaps(mine)) return { ok: false, reason: 'windows in this rule overlap each other' };
  if (!candidate.enabled) return { ok: true, reason: 'ok (disabled — not checked against others)' };
  for (const o of others) {
    if (!o.enabled || o.id === candidate.id || !sameUnit(candidate, o)) continue;
    if (setsOverlap(mine, expandSegments(o.days, o.windows))) {
      return { ok: false, reason: `overlaps rule "${o.name}" on the same unit` };
    }
  }
  return { ok: true, reason: 'ok' };
}
