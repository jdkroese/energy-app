// Cooking-mode session persistence (P3, docs/42). Everything cooking mode needs to
// survive a reload lives here in localStorage: the phase, check-offs, the cook-step
// index, tonight's servings and — most importantly — RUNNING TIMERS, stored as
// absolute end timestamps so a reload (or a phase change) never loses the rice.
// Client-side only: no server clock involved (docs/38 §2 Loop C). One session at a
// time (one kitchen); starting a different recipe replaces the old session.

export interface CookTimer {
  id: string;
  /** Short label for the header chip ("rice", "step 4"). */
  label: string;
  /** Absolute end (ms epoch) — survives reloads without drift. */
  endsAt: number;
  totalSec: number;
  /** Where it was started, so the source row can render its own countdown. */
  source: { phase: 2 | 3; index: number };
}

export interface CookSessionState {
  recipeId: string;
  servings: number;
  phase: 1 | 2 | 3;
  /** Cook-phase one-step-per-screen index. */
  stepIdx: number;
  toolsDone: number[];
  ingredientsDone: number[];
  miseDone: number[];
  timers: CookTimer[];
  startedAt: number;
}

const KEY = 'power.cook.session';
/** Drop sessions untouched for 12 h — yesterday's dinner shouldn't resume tonight. */
const STALE_MS = 12 * 3_600_000;

export function freshCookSession(recipeId: string, servings: number): CookSessionState {
  return {
    recipeId,
    servings,
    phase: 1,
    stepIdx: 0,
    toolsDone: [],
    ingredientsDone: [],
    miseDone: [],
    timers: [],
    startedAt: Date.now(),
  };
}

function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

/** Load the persisted session for this recipe, or null (missing / other recipe / stale). */
export function loadCookSession(recipeId: string): CookSessionState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<CookSessionState>;
    if (p.recipeId !== recipeId) return null;
    if (typeof p.startedAt !== 'number' || Date.now() - p.startedAt > STALE_MS) return null;
    return {
      recipeId,
      servings: typeof p.servings === 'number' && p.servings >= 1 ? Math.min(24, Math.round(p.servings)) : 4,
      phase: p.phase === 2 || p.phase === 3 ? p.phase : 1,
      stepIdx: typeof p.stepIdx === 'number' && p.stepIdx >= 0 ? Math.round(p.stepIdx) : 0,
      toolsDone: numArray(p.toolsDone),
      ingredientsDone: numArray(p.ingredientsDone),
      miseDone: numArray(p.miseDone),
      timers: Array.isArray(p.timers)
        ? p.timers.filter(
            (t): t is CookTimer =>
              !!t && typeof t.endsAt === 'number' && typeof t.label === 'string' && typeof t.id === 'string' &&
              // Keep just-finished timers (the chip shows "done"); drop ancient ones.
              t.endsAt > Date.now() - 3_600_000,
          )
        : [],
      startedAt: p.startedAt,
    };
  } catch {
    return null; // private mode / corrupt JSON — start clean
  }
}

export function saveCookSession(s: CookSessionState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore — in-memory state still drives the UI */
  }
}

export function clearCookSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** "12:05" (or "1:02:09" over an hour) for a timer chip; clamps at 0:00. */
export function fmtCountdown(remainingMs: number): string {
  const s = Math.max(0, Math.round(remainingMs / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}
