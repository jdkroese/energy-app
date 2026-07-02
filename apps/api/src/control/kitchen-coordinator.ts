// Kitchen reminders coordinator (docs/39 "Reminders / order rhythm"). A small HOURLY
// tick — LOG-ONLY + Push notify; it never touches the control loop, battery logic or
// any actuator. Two nudges, each at most once per week (deduped via kitchen.json):
//   1. Plan-week nudge: at/after the configured moment (default Sun 18:00), when NEXT
//      week's plan has fewer than 3 planned days.
//   2. Submit nudge: when the order draft isn't submitted by (submit deadline − 4h),
//      default deadline Sun 22:00 → nudge from 18:00.
// The tick takes an injectable clock so it is unit-testable (kitchen-coordinator.test.ts).

import { logEvent } from '../events';
import { sendPush } from '../notify';
import * as kitchen from '../kitchen/store';
import { addDays, weekStartOf } from '../kitchen/engine';

const TICK_MS = 60 * 60_000; // hourly

const SUBMIT_NUDGE_LEAD_H = 4;

export interface KitchenNudge {
  kind: 'plan-week' | 'submit-order';
  title: string;
  body: string;
}

/** The dow+hour occurrence INSIDE the current Mon–Sun week (may be past or future). */
function occurrenceThisWeek(now: Date, dow: number, hour: number): Date {
  const monday = new Date(`${weekStartOf(now)}T00:00:00`);
  const offsetDays = (dow - 1 + 7) % 7; // Mon=0 … Sun=6 within the plan week
  const candidate = new Date(monday);
  candidate.setDate(monday.getDate() + offsetDays);
  candidate.setHours(hour, 0, 0, 0);
  return candidate;
}

/**
 * Evaluate the nudge conditions at `now` (pure decision — I/O happens in tick()).
 * Exported for tests.
 */
export function evaluateNudges(data: kitchen.KitchenData, now: Date): KitchenNudge[] {
  const out: KitchenNudge[] = [];
  const rem = data.reminders;
  const thisWeek = weekStartOf(now);
  const nextWeek = addDays(thisWeek, 7);

  // --- 1. Plan-week nudge -----------------------------------------------------
  const planMoment = occurrenceThisWeek(now, rem.planWeekDow, rem.planWeekHour);
  if (now.getTime() >= planMoment.getTime() && rem.lastPlanNudgeWeek !== thisWeek) {
    const plan = data.plans[nextWeek];
    const plannedDays = plan ? plan.days.filter((d) => d.recipeId || d.skip).length : 0;
    if (plannedDays < 3) {
      out.push({
        kind: 'plan-week',
        title: 'Plan next week’s dinners',
        body: `Only ${plannedDays} of 7 days planned for the week of ${nextWeek}. Ten minutes now saves the weekly scramble.`,
      });
    }
  }

  // --- 2. Submit nudge (deadline − 4h) ------------------------------------------
  {
    // Window opens 4h before this week's deadline occurrence and closes at the deadline.
    const deadline = occurrenceThisWeek(now, rem.submitByDow, rem.submitByHour);
    const nudgeFrom = deadline.getTime() - SUBMIT_NUDGE_LEAD_H * 3_600_000;
    const inWindow = now.getTime() >= nudgeFrom && now.getTime() <= deadline.getTime();
    const draft = data.orderDraft;
    const hasOpenDraft = draft.status !== 'submitted' && draft.lines.some((l) => l.checked);
    if (inWindow && hasOpenDraft && rem.lastSubmitNudgeWeek !== thisWeek) {
      const hh = String(rem.submitByHour).padStart(2, '0');
      out.push({
        kind: 'submit-order',
        title: 'Groceries: submit before the cutoff',
        body: `Your draft (${draft.lines.filter((l) => l.checked).length} items · ${draft.totalEur.toFixed(2)} €) isn’t submitted — order before ${hh}:00 for the ${draft.targetSlot?.window ?? rem.targetSlotLabel} slot.`,
      });
    }
  }
  return out;
}

/**
 * One coordinator tick: evaluate + emit (event log + push) + persist dedupe marks.
 * The clock is injectable for tests; notify/log are best-effort and never throw.
 */
export async function kitchenTick(now: Date = new Date()): Promise<KitchenNudge[]> {
  let nudges: KitchenNudge[] = [];
  try {
    const data = kitchen.get();
    nudges = evaluateNudges(data, now);
    if (!nudges.length) return nudges;
    const thisWeek = weekStartOf(now);
    kitchen.update((d) => {
      for (const n of nudges) {
        if (n.kind === 'plan-week') d.reminders.lastPlanNudgeWeek = thisWeek;
        else d.reminders.lastSubmitNudgeWeek = thisWeek;
      }
    });
    for (const n of nudges) {
      logEvent({
        class: 'system',
        category: 'kitchen',
        severity: 'low',
        summary: n.title,
        detail: n.body,
        trigger: { source: 'coordinator', detail: `kitchen-${n.kind}` },
        data: { kind: n.kind },
      });
      await sendPush(n.title, n.body, { url: n.kind === 'plan-week' ? '/cooking' : '/groceries' }).catch(() => {});
    }
  } catch (e) {
    console.error('[kitchen-coordinator] tick failed:', (e as Error).message);
  }
  return nudges;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the hourly reminder tick (pattern of the other coordinators; log-only + push). */
export function startKitchenCoordinator(): void {
  if (timer) return;
  timer = setInterval(() => void kitchenTick(), TICK_MS);
  // First evaluation shortly after boot so a restart inside a nudge window still fires.
  setTimeout(() => void kitchenTick(), 30_000);
}

export function stopKitchenCoordinator(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
