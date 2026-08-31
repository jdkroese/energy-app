// Billing-period maths for the Water section (docs/52).
//
// AMJASA bills BIMONTHLY, and the calendar month is therefore the wrong unit for
// anything the owner actually cares about: the band his consumption lands in — and so
// the price of every m³ in the period — is decided over two months, not one. Factura
// 3/1836657 reads 01/05/2026 -> 01/07/2026, so periods start on the 1st of odd months.
//
// Pure functions; the caller supplies `now` and the configured anchor.

import { madridLocalToEpochSec } from '../connectors/contazara';

export interface BillingPeriod {
  /** Local Madrid date "YYYY-MM-DD" the period starts (inclusive). */
  startDay: string;
  /** Local Madrid date "YYYY-MM-DD" the period ends (exclusive — the next read date). */
  endDay: string;
  startSec: number;
  /** Exclusive upper bound, so [startSec, endSec) tiles the timeline with no gaps. */
  endSec: number;
  months: number;
  /** Whole days elapsed since the period started (0 on the first day). */
  daysElapsed: number;
  /** Total days in the period. */
  daysTotal: number;
}

function ymd(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Add `n` months to a (y, m) pair, normalising the month into 1..12. */
function addMonths(y: number, m: number, n: number): { y: number; m: number } {
  const zero = y * 12 + (m - 1) + n;
  return { y: Math.floor(zero / 12), m: (((zero % 12) + 12) % 12) + 1 };
}

/** Clamp a day-of-month to the target month's length (anchors on the 31st, Februaries). */
function clampDay(y: number, m: number, d: number): number {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.min(Math.max(1, d), last);
}

const DAY_SEC = 86_400;

/**
 * The billing period containing `now`, derived by stepping `months` at a time from
 * `anchorDay`. Works for anchors in the past or the future (a negative period index is
 * fine), so the owner can enter any known read date from any bill.
 *
 * Falls back to a calendar-month period if the anchor is unparseable, rather than
 * throwing into the request path.
 */
export function billingPeriodFor(now: Date, anchorDay: string, months: number): BillingPeriod {
  const span = Number.isFinite(months) && months >= 1 ? Math.round(months) : 1;
  const a = ymd(anchorDay) ?? { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: 1 };

  // Which period index contains `now`? Compare on the anchor's day-of-month so a period
  // that starts on the 1st does not roll early for a `now` earlier in the month.
  const nowY = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric' }).format(now));
  const nowM = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', month: '2-digit' }).format(now));
  const nowD = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', day: '2-digit' }).format(now));

  let monthsSince = (nowY - a.y) * 12 + (nowM - a.m);
  if (nowD < a.d) monthsSince -= 1; // still inside the previous period
  const index = Math.floor(monthsSince / span);

  const start = addMonths(a.y, a.m, index * span);
  const startD = clampDay(start.y, start.m, a.d);
  const end = addMonths(a.y, a.m, (index + 1) * span);
  const endD = clampDay(end.y, end.m, a.d);

  const startSec = madridLocalToEpochSec(start.y, start.m, startD, 0, 0, 0);
  const endSec = madridLocalToEpochSec(end.y, end.m, endD, 0, 0, 0);
  const nowSec = Math.floor(now.getTime() / 1000);

  return {
    startDay: `${start.y}-${pad(start.m)}-${pad(startD)}`,
    endDay: `${end.y}-${pad(end.m)}-${pad(endD)}`,
    startSec,
    endSec,
    months: span,
    daysElapsed: Math.max(0, Math.floor((nowSec - startSec) / DAY_SEC)),
    daysTotal: Math.max(1, Math.round((endSec - startSec) / DAY_SEC)),
  };
}

/**
 * Straight-line projection of the period total from consumption so far.
 *
 * Deliberately naive: with a bimonthly cycle and hourly-resolution data, a fancier model
 * would imply a confidence the data does not support. What matters is answering "at this
 * rate, which band do I land in?" early enough to still act on it.
 */
export function projectPeriodM3(m3ToDate: number, period: BillingPeriod): number {
  const elapsed = Math.max(1, period.daysElapsed); // day 0 projects off its first full day
  const rate = Math.max(0, m3ToDate) / elapsed;
  return Math.round(rate * period.daysTotal * 100) / 100;
}
