/**
 * Reports period-navigator helpers. Mirrors the API window math (apps/api/src/
 * routes/history.ts) so the picker + nav label stay Europe/Madrid-correct and
 * match what the server returns for the selected offset (0 = now, negative = past).
 */

// Must match MAX_BACK in apps/api/src/routes/history.ts.
export const MAX_BACK: Record<string, number> = { hour: 0, day: 60, week: 26, month: 24, year: 5 };

const TZ = 'Europe/Madrid';
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

function madridOffsetMin(d: Date): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUTC - d.getTime()) / 60000);
}

function madridInstant(y: number, m: number, d: number, H = 12): Date {
  let guess = Date.UTC(y, m - 1, d, H);
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, m - 1, d, H) - madridOffsetMin(new Date(guess)) * 60000;
  return new Date(guess);
}

function madridCal(d: Date): { y: number; m: number; day: number; wd: number } {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const wmap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: Number(g('year')), m: Number(g('month')), day: Number(g('day')), wd: wmap[g('weekday')] ?? 1 };
}

/** User-facing label for a range + offset, with relative niceties (Today/Yesterday…). */
export function periodLabel(range: string, offset: number): string {
  const r = range.toLowerCase();
  if (r === 'hour') return 'Past hour';
  const today = madridCal(new Date());

  if (r === 'year') {
    if (offset === 0) return 'This year';
    if (offset === -1) return 'Last year';
    return String(today.y + offset);
  }
  if (r === 'month') {
    if (offset === 0) return 'This month';
    if (offset === -1) return 'Last month';
    const base = today.m - 1 + offset;
    const y = today.y + Math.floor(base / 12);
    const m = ((base % 12) + 12) % 12;
    return `${MONTHS[m]} ${y}`;
  }
  const anchor = madridInstant(today.y, today.m, today.day);
  if (r === 'day') {
    if (offset === 0) return 'Today';
    if (offset === -1) return 'Yesterday';
    const c = madridCal(new Date(anchor.getTime() + offset * DAY_MS));
    return `${WD[c.wd]} ${c.day} ${MONTHS[c.m - 1]} ${c.y}`;
  }
  // week
  if (offset === 0) return 'This week';
  if (offset === -1) return 'Last week';
  const isoWd = today.wd === 0 ? 7 : today.wd;
  const mondayInstant = new Date(anchor.getTime() + (offset * 7 - (isoWd - 1)) * DAY_MS);
  const a = madridCal(mondayInstant);
  const b = madridCal(new Date(mondayInstant.getTime() + 6 * DAY_MS));
  return a.m === b.m
    ? `${a.day}–${b.day} ${MONTHS[a.m - 1]} ${a.y}`
    : `${a.day} ${MONTHS[a.m - 1]} – ${b.day} ${MONTHS[b.m - 1]} ${b.y}`;
}

/** Selectable {offset,label} list for the picker, newest (0) → oldest. */
export function periodOptions(range: string): { offset: number; label: string }[] {
  const max = MAX_BACK[range.toLowerCase()] ?? 0;
  const out: { offset: number; label: string }[] = [];
  for (let o = 0; o >= -max; o--) out.push({ offset: o, label: periodLabel(range, o) });
  return out;
}
