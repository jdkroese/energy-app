// Cooking mode (P3, docs/42 + docs/38 §2 Loop C) — the three-phase guided cook per the
// approved v4 mockup frames 6a/6b/6c: 1 · Prepare (tools + ingredients on the bench,
// amounts rescaled to tonight's servings) → 2 · Mise en place (check-off prep tasks,
// early timers like rice) → 3 · Cook (one step per screen, huge type, inline rescaled
// amounts, per-step timers). The phase bar is always visible; "Skip checks" jumps
// straight to Cook. Started timers persist across phases AND reloads (lib/cookSession)
// and render as compact countdown chips in the header. Screen Wake Lock keeps the
// tablet awake while cooking (feature-detected, re-acquired on visibilitychange).
// Runs on EVERY surface: /cook/:recipeId on desktop + mobile, and full-screen inside
// the kiosk TabletShell (standing rule: never tablet-only).

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ShellContext } from '../../components/shell/AppShell';
import { Button, Icon, LoadingState } from '../../components/ui';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import {
  clearCookSession,
  fmtCountdown,
  freshCookSession,
  loadCookSession,
  saveCookSession,
  type CookSessionState,
  type CookTimer,
} from '../../lib/cookSession';
import type { CookedRating, MealPlan, Recipe, RecipeIngredient } from '../../lib/types';
import { fmtQty, ServingsStepper } from './shared';

/* ---- Small helpers -------------------------------------------------------------- */

function localDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function weekStartOf(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const x = new Date(y, m - 1, d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return localDateStr(x);
}

/** Significant, singular-collapsed word tokens ("Chicken breasts" → chicken·breast). */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length > 3)
    .map((w) => (w.endsWith('s') ? w.slice(0, -1) : w));
}

/** Ingredients referenced by a cook step (deterministic name match → rescaled chips). */
function stepIngredients(recipe: Recipe, stepText: string): RecipeIngredient[] {
  const bag = new Set(words(stepText));
  if (!bag.size) return [];
  return recipe.ingredients.filter((ing) => words(ing.name).some((w) => bag.has(w)) || words(ing.es).some((w) => bag.has(w)));
}

/** "start the rice" → a short timer-chip label. */
function timerLabel(text: string): string {
  const clean = text.replace(/[—–].*$/, '').trim();
  const short = clean.split(/\s+/).slice(0, 3).join(' ');
  return (short.length > 18 ? `${short.slice(0, 17)}…` : short).toLowerCase();
}

const PHASES = [
  { n: 1 as const, label: 'Prepare', icon: 'utensils' },
  { n: 2 as const, label: 'Mise en place', icon: 'list-checks' },
  { n: 3 as const, label: 'Cook', icon: 'flame' },
];

/* ---- Route wrapper (normal desktop/mobile shell) ---------------------------------- */

export function Cook({ ctx }: { ctx: ShellContext }) {
  const { recipeId } = useParams<{ recipeId: string }>();
  return <CookScreen recipeId={recipeId ?? ''} desktop={ctx.desktop} />;
}

/* ---- The screen (also mounted full-screen by the kiosk TabletShell) ---------------- */

export function CookScreen({ recipeId, desktop, kiosk = false }: { recipeId: string; desktop: boolean; kiosk?: boolean }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const planDate = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? (params.get('date') as string) : localDateStr(new Date());

  const { data: recipesResp } = usePolling(api.kitchen.recipes, 0);
  const { data: householdResp } = usePolling(api.kitchen.household, 0);
  const [plan, setPlan] = useState<MealPlan | null>(null);
  useEffect(() => {
    api.kitchen
      .plan(weekStartOf(planDate))
      .then((r) => setPlan(r.plan))
      .catch(() => setPlan(null));
  }, [planDate]);

  const recipe = recipesResp?.recipes.find((r) => r.id === recipeId) ?? null;
  const household = householdResp?.household ?? null;

  // Tonight's servings: resumed session > the plan's entry for this recipe/day >
  // household default > the recipe base (docs/42 rescaling rule).
  const [session, setSession] = useState<CookSessionState | null>(() => loadCookSession(recipeId));
  useEffect(() => {
    if (session || !recipe) return;
    const resumed = loadCookSession(recipeId);
    if (resumed) {
      setSession(resumed);
      return;
    }
    if (!household || !plan) return; // wait for both so the default is right
    const day = plan.days.find((d) => d.date === planDate && d.recipeId === recipeId);
    const servings = day?.servings ?? (household.adults + household.kids || recipe.servingsBase);
    setSession(freshCookSession(recipeId, Math.max(1, servings)));
  }, [session, recipe, household, plan, planDate, recipeId]);

  const patch = useCallback((p: Partial<CookSessionState>) => {
    setSession((s) => {
      if (!s) return s;
      const next = { ...s, ...p };
      saveCookSession(next);
      return next;
    });
  }, []);

  // 1 Hz tick while any timer runs (drives every countdown in the tree).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!session?.timers.length) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [session?.timers.length]);

  // ---- Screen Wake Lock (feature-detected; re-acquire on visibilitychange) --------
  useEffect(() => {
    type WakeLockLike = { request: (type: 'screen') => Promise<{ release: () => Promise<void>; addEventListener?: (t: string, f: () => void) => void }> };
    const wl = 'wakeLock' in navigator ? ((navigator as unknown as { wakeLock: WakeLockLike }).wakeLock) : null;
    if (!wl) {
      console.log('[cook] wake lock unsupported — screen may sleep');
      return;
    }
    let lock: Awaited<ReturnType<WakeLockLike['request']>> | null = null;
    let disposed = false;
    const acquire = async () => {
      try {
        lock = await wl.request('screen');
        console.log('[cook] wake lock acquired');
        lock.addEventListener?.('release', () => console.log('[cook] wake lock released'));
      } catch (e) {
        console.log('[cook] wake lock request failed:', (e as Error).message);
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible' && !disposed) void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => undefined);
    };
  }, []);

  const [done, setDone] = useState<'rating' | 'logged' | null>(null);
  const [busy, setBusy] = useState(false);

  const exit = useCallback(() => navigate(kiosk ? '/' : '/cooking'), [navigate, kiosk]);

  const miseSteps = useMemo(() => (recipe ? recipe.steps.filter((s) => s.phase === 'mise') : []), [recipe]);
  const cookSteps = useMemo(() => (recipe ? recipe.steps.filter((s) => s.phase === 'cook') : []), [recipe]);

  if (!recipesResp) return <LoadingState label="Loading the recipe…" />;
  if (!recipe) {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'var(--text-2)' }}>
        <Icon name="chef-hat" size={30} color="var(--text-3)" />
        Recipe not found — it may have been removed.
        <Button variant="secondary" onClick={exit}>Back</Button>
      </div>
    );
  }
  if (!session) return <LoadingState label="Setting the bench…" />;

  const scale = session.servings / recipe.servingsBase;
  const servingsSplit =
    household && session.servings === household.adults + household.kids && household.kids > 0
      ? `${household.adults}+${household.kids}`
      : String(session.servings);

  const toggleIn = (list: number[], i: number) => (list.includes(i) ? list.filter((x) => x !== i) : [...list, i]);

  const startTimer = (sec: number, label: string, source: CookTimer['source']) => {
    const t: CookTimer = {
      id: `t-${source.phase}-${source.index}`,
      label,
      endsAt: Date.now() + sec * 1000,
      totalSec: sec,
      source,
    };
    patch({ timers: [...session.timers.filter((x) => x.id !== t.id), t] });
    setNow(Date.now());
  };
  const dismissTimer = (id: string) => patch({ timers: session.timers.filter((t) => t.id !== id) });
  const timerFor = (source: CookTimer['source']) => session.timers.find((t) => t.id === `t-${source.phase}-${source.index}`);

  const goPhase = (n: 1 | 2 | 3) => patch({ phase: n === 2 && !miseSteps.length ? 3 : n });

  const finishCooking = async (rating?: CookedRating) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.kitchen.cooked(recipe.id, rating);
      clearCookSession();
      setDone('logged');
      window.setTimeout(exit, 1400);
    } catch {
      setBusy(false);
    }
  };

  /* ---- Shared visual bits --------------------------------------------------------- */

  const wide = desktop; // kiosk tablets are ≥768 landscape → wide branch

  const checkbox = (on: boolean): CSSProperties => ({
    width: 22,
    height: 22,
    flex: 'none',
    borderRadius: 7,
    border: `1.5px solid ${on ? 'var(--solar)' : 'var(--border-2)'}`,
    background: on ? 'var(--solar-wash)' : 'transparent',
    display: 'grid',
    placeItems: 'center',
    color: 'var(--solar)',
  });

  const phaseBar = (
    <div
      style={{
        display: 'flex',
        gap: 2,
        padding: 3,
        background: 'var(--surface-2)',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--radius-md)',
        marginLeft: wide ? 'auto' : 0,
      }}
    >
      {PHASES.map((p) => {
        const state = session.phase === p.n ? 'now' : session.phase > p.n ? 'done' : 'todo';
        const disabled = p.n === 2 && !miseSteps.length;
        // Compact labels once past a phase (mockup frame 6c: "✓ 1 · ✓ 2 · 3 Cook").
        const label = wide || state === 'now' ? `${p.n} · ${p.label}` : String(p.n);
        return (
          <button
            key={p.n}
            type="button"
            disabled={disabled}
            onClick={() => goPhase(p.n)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              height: 34,
              padding: '0 12px',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              whiteSpace: 'nowrap',
              fontSize: 12,
              fontWeight: 700,
              cursor: disabled ? 'default' : 'pointer',
              background: state === 'now' ? 'var(--grid-wash)' : 'transparent',
              color: disabled ? 'var(--text-3)' : state === 'now' ? 'var(--grid)' : state === 'done' ? 'var(--solar)' : 'var(--text-3)',
              boxShadow: state === 'now' ? 'inset 0 0 0 1px rgba(245,165,36,.35)' : 'none',
              opacity: disabled ? 0.45 : 1,
            }}
          >
            <Icon name={state === 'done' ? 'check' : p.icon} size={14} />
            {label}
          </button>
        );
      })}
    </div>
  );

  const timerChips = session.timers.length > 0 && (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {session.timers.map((t) => {
        const remaining = t.endsAt - now;
        const finished = remaining <= 0;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => finished && dismissTimer(t.id)}
            title={finished ? 'Timer done — tap to dismiss' : t.label}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              minHeight: 34,
              padding: '0 11px',
              borderRadius: 'var(--radius-sm)',
              border: `1px solid ${finished ? 'rgba(46,230,160,.45)' : 'rgba(245,165,36,.35)'}`,
              background: finished ? 'var(--solar-wash)' : 'var(--grid-wash)',
              color: finished ? 'var(--solar)' : 'var(--grid)',
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              fontWeight: 600,
              cursor: finished ? 'pointer' : 'default',
            }}
          >
            <Icon name={finished ? 'check' : 'timer'} size={14} />
            {finished ? 'done' : fmtCountdown(remaining)}
            <span style={{ fontFamily: 'var(--font-sans, inherit)', fontWeight: 500, color: 'inherit', opacity: 0.85 }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: wide ? 14 : 8, flexWrap: 'wrap' }}>
      <Button variant="ghost" size={wide ? 'md' : 'sm'} iconLeft={<Icon name="x" size={15} />} onClick={exit}>
        Exit
      </Button>
      <h3 style={{ margin: 0, fontSize: wide ? 19 : 15.5, fontWeight: 600, flex: wide ? 'none' : 1, minWidth: 0 }}>{recipe.title}</h3>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-3)' }}>
        <ServingsStepper compact value={session.servings} onChange={(v) => patch({ servings: v })} />
        <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)', fontSize: 12.5 }}>{servingsSplit}</b> servings
      </span>
      {timerChips}
      {phaseBar}
    </div>
  );

  const navBtnRow = (left: { label: string; onClick: () => void } | null, right: { label: string; onClick: () => void; icon?: string }) => (
    <div style={{ display: 'flex', gap: 12, marginTop: 'auto', paddingTop: 16 }}>
      {left && (
        <Button variant="secondary" size="lg" style={{ flex: 1, minHeight: 52 }} iconLeft={<Icon name="chevron-left" size={16} />} onClick={left.onClick}>
          {left.label}
        </Button>
      )}
      <Button
        variant="primary"
        size="lg"
        style={{ flex: 2.5, minHeight: 52 }}
        iconRight={<Icon name={right.icon ?? 'chevron-right'} size={16} />}
        onClick={right.onClick}
      >
        {right.label}
      </Button>
    </div>
  );

  /* ---- Completion ("Cooked!") ------------------------------------------------------ */

  if (done || session.phase === 3 && session.stepIdx >= cookSteps.length && cookSteps.length > 0) {
    const ratingBtn = (rating: CookedRating, emoji: string, label: string) => (
      <button
        key={rating}
        type="button"
        disabled={busy}
        onClick={() => void finishCooking(rating)}
        style={{
          flex: 1,
          maxWidth: 150,
          minHeight: 84,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border-2)',
          background: 'var(--surface-2)',
          color: 'var(--text-1)',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        <span style={{ fontSize: 30 }}>{emoji}</span>
        {label}
      </button>
    );
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: wide ? '22px 32px 24px' : '14px 14px 20px', gap: 12 }}>
        {header}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, textAlign: 'center' }}>
          {done === 'logged' ? (
            <>
              <span style={{ width: 74, height: 74, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--solar-wash)', color: 'var(--solar)' }}>
                <Icon name="check" size={38} />
              </span>
              <div style={{ fontSize: wide ? 24 : 19, fontWeight: 700 }}>Logged — enjoy dinner!</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Rotation updated · the planner knows this was cooked tonight</div>
            </>
          ) : (
            <>
              <span style={{ width: 74, height: 74, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)' }}>
                <Icon name="chef-hat" size={36} />
              </span>
              <div style={{ fontSize: wide ? 26 : 20, fontWeight: 700 }}>Cooked!</div>
              <div style={{ fontSize: 13, color: 'var(--text-2)' }}>How did it go down? One tap logs it for the rotation.</div>
              <div style={{ display: 'flex', gap: 12, width: '100%', maxWidth: 480, justifyContent: 'center' }}>
                {ratingBtn('up', '👍', 'Keeper')}
                {ratingBtn('meh', '😐', 'Fine')}
                {ratingBtn('down', '👎', 'Not again')}
              </div>
              <Button variant="ghost" disabled={busy} onClick={() => void finishCooking()}>
                Skip rating — just log it
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  /* ---- Phase bodies ------------------------------------------------------------------ */

  let body: React.ReactNode = null;

  if (session.phase === 1) {
    const card: CSSProperties = { background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' };
    const cardHead = (icon: string, title: string, doneN: number, total: number) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border-1)' }}>
        <Icon name={icon} size={16} color="var(--grid)" />
        <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>{title}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: doneN >= total ? 'var(--solar)' : 'var(--text-3)' }}>
          {doneN} of {total}
        </span>
      </div>
    );
    body = (
      <>
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: wide ? '1fr 1.25fr' : '1fr', gap: 14, alignItems: 'start', overflowY: 'auto' }}>
          <div style={card}>
            {cardHead('utensils', 'Tools on the bench', session.toolsDone.length, recipe.tools.length)}
            <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1fr' : '1fr', gap: 9, padding: 12 }}>
              {recipe.tools.map((t, i) => {
                const on = session.toolsDone.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => patch({ toolsDone: toggleIn(session.toolsDone, i) })}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      minHeight: 48,
                      padding: '10px 12px',
                      border: `1px solid ${on ? 'rgba(46,230,160,.35)' : 'var(--border-1)'}`,
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--surface-2)',
                      color: on ? 'var(--text-1)' : 'var(--text-2)',
                      fontSize: 13,
                      fontWeight: 500,
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={checkbox(on)}>{on && <Icon name="check" size={14} />}</span>
                    {t}
                  </button>
                );
              })}
              {recipe.tools.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--text-3)', padding: 4 }}>No special tools — just the basics.</span>}
            </div>
          </div>
          <div style={card}>
            {cardHead('carrot', `Ingredients · rescaled to ${session.servings} servings`, session.ingredientsDone.length, recipe.ingredients.length)}
            <div style={{ padding: '4px 12px 10px' }}>
              {recipe.ingredients.map((ing, i) => {
                const on = session.ingredientsDone.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => patch({ ingredientsDone: toggleIn(session.ingredientsDone, i) })}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 11,
                      width: '100%',
                      minHeight: 46,
                      padding: '8px 4px',
                      border: 'none',
                      borderBottom: i < recipe.ingredients.length - 1 ? '1px solid var(--border-1)' : 'none',
                      background: 'none',
                      color: on ? 'var(--text-3)' : 'var(--text-1)',
                      fontSize: wide ? 14.5 : 13.5,
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={checkbox(on)}>{on && <Icon name="check" size={14} />}</span>
                    <span style={{ textDecoration: on ? 'line-through' : 'none' }}>
                      {ing.name}
                      {ing.qty != null ? (
                        <b style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}> · {fmtQty(ing.qty * scale, ing.unit)}</b>
                      ) : (
                        <span style={{ color: 'var(--text-3)' }}> · to taste</span>
                      )}
                      {ing.pantryStaple && <small style={{ color: 'var(--text-3)' }}> · pantry</small>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {navBtnRow(
          { label: 'Skip checks', onClick: () => patch({ phase: 3 }) },
          miseSteps.length
            ? { label: 'Bench ready — Mise en place', onClick: () => patch({ phase: 2 }) }
            : { label: 'Bench ready — Start cooking', onClick: () => patch({ phase: 3 }) },
        )}
      </>
    );
  } else if (session.phase === 2) {
    body = (
      <>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', maxWidth: 860 }}>
            {miseSteps.map((s, i) => {
              const on = session.miseDone.includes(i);
              const t = timerFor({ phase: 2, index: i });
              const remaining = t ? t.endsAt - now : 0;
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 13,
                    padding: wide ? '13px 16px' : '11px 12px',
                    borderBottom: i < miseSteps.length - 1 ? '1px solid var(--border-1)' : 'none',
                    fontSize: wide ? 15.5 : 13.5,
                  }}
                >
                  <button
                    type="button"
                    aria-label={on ? 'Mark not done' : 'Mark done'}
                    onClick={() => patch({ miseDone: toggleIn(session.miseDone, i) })}
                    style={{ ...checkbox(on), width: 26, height: 26, cursor: 'pointer', minWidth: 26 }}
                  >
                    {on && <Icon name="check" size={16} />}
                  </button>
                  <span
                    style={{ flex: 1, color: on ? 'var(--text-3)' : 'var(--text-1)', textDecoration: on ? 'line-through' : 'none', cursor: 'pointer' }}
                    onClick={() => patch({ miseDone: toggleIn(session.miseDone, i) })}
                  >
                    {s.text}
                  </span>
                  {s.timerSec != null && (
                    t ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 7,
                          color: remaining <= 0 ? 'var(--solar)' : 'var(--grid)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 13.5,
                          border: `1px solid ${remaining <= 0 ? 'rgba(46,230,160,.4)' : 'rgba(245,165,36,.35)'}`,
                          background: remaining <= 0 ? 'var(--solar-wash)' : 'var(--grid-wash)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '6px 10px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <Icon name={remaining <= 0 ? 'check' : 'timer'} size={14} /> {remaining <= 0 ? 'done' : fmtCountdown(remaining)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => startTimer(s.timerSec!, timerLabel(s.text), { phase: 2, index: i })}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 7,
                          minHeight: 40,
                          padding: '0 13px',
                          border: '1px solid rgba(245,165,36,.35)',
                          background: 'var(--grid-wash)',
                          color: 'var(--grid)',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: 12.5,
                          fontWeight: 700,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <Icon name="play" size={13} /> {Math.round(s.timerSec! / 60)} min
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {navBtnRow({ label: 'Prepare', onClick: () => patch({ phase: 1 }) }, { label: 'Start cooking', onClick: () => patch({ phase: 3 }) })}
      </>
    );
  } else {
    // ---- Phase 3 · Cook — one step per screen -------------------------------------
    const idx = Math.min(session.stepIdx, Math.max(0, cookSteps.length - 1));
    const step = cookSteps[idx];
    const chips = step ? stepIngredients(recipe, step.text) : [];
    const t = step ? timerFor({ phase: 3, index: idx }) : undefined;
    const remaining = t ? t.endsAt - now : 0;
    const nextTitle = idx + 1 < cookSteps.length ? timerLabel(cookSteps[idx + 1].text) : null;
    body = step ? (
      <>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          {cookSteps.map((_, i) => (
            <i
              key={i}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: i < idx ? 'var(--grid-dim, rgba(245,165,36,.4))' : i === idx ? 'var(--grid)' : 'var(--surface-3)',
                boxShadow: i === idx ? '0 0 10px rgba(245,165,36,.7)' : 'none',
              }}
            />
          ))}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: wide ? 18 : 13, maxWidth: 780, overflowY: 'auto' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--grid)', letterSpacing: '0.1em' }}>
            STEP {idx + 1} OF {cookSteps.length}
          </div>
          <p style={{ margin: 0, fontSize: wide ? 27 : 19, lineHeight: 1.35, fontWeight: 600, textWrap: 'balance' as never }}>{step.text}</p>
          {chips.length > 0 && (
            <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
              {chips.map((ing, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: wide ? 14 : 12.5,
                    color: 'var(--text-2)',
                    background: 'var(--surface-1)',
                    border: '1px solid var(--border-1)',
                    borderRadius: 'var(--radius-pill, 999px)',
                    padding: '6px 14px',
                  }}
                >
                  {ing.qty != null && (
                    <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)', fontWeight: 600 }}>{fmtQty(ing.qty * scale, ing.unit)} </b>
                  )}
                  {ing.name.toLowerCase()}
                </span>
              ))}
            </div>
          )}
          {step.timerSec != null ? (
            t ? (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 12,
                  background: remaining <= 0 ? 'var(--solar-wash)' : 'var(--grid-wash)',
                  border: `1px solid ${remaining <= 0 ? 'rgba(46,230,160,.45)' : 'rgba(245,165,36,.4)'}`,
                  borderRadius: 'var(--radius-lg)',
                  padding: '12px 20px',
                  width: 'fit-content',
                  color: remaining <= 0 ? 'var(--solar)' : 'var(--grid)',
                }}
              >
                <Icon name={remaining <= 0 ? 'check' : 'timer'} size={20} />
                <b style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 600 }}>{remaining <= 0 ? 'done' : fmtCountdown(remaining)}</b>
                {remaining <= 0 && (
                  <Button size="sm" variant="ghost" onClick={() => dismissTimer(t.id)}>
                    Dismiss
                  </Button>
                )}
              </div>
            ) : (
              <Button
                variant="secondary"
                size="lg"
                style={{ width: 'fit-content', minHeight: 52 }}
                iconLeft={<Icon name="timer" size={17} />}
                onClick={() => startTimer(step.timerSec!, timerLabel(step.text), { phase: 3, index: idx })}
              >
                Start {Math.round(step.timerSec / 60)} min timer
              </Button>
            )
          ) : (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: 'var(--text-3)', fontSize: 13 }}>
              <Icon name="timer" size={15} /> No timer this step
            </div>
          )}
        </div>
        {navBtnRow(
          idx > 0 ? { label: 'Back', onClick: () => patch({ stepIdx: idx - 1 }) } : { label: 'Mise en place', onClick: () => goPhase(2) },
          idx + 1 < cookSteps.length
            ? { label: nextTitle ? `Next — ${nextTitle}` : 'Next', onClick: () => patch({ stepIdx: idx + 1 }) }
            : { label: 'Done — Cooked!', icon: 'check', onClick: () => patch({ stepIdx: cookSteps.length }) },
        )}
      </>
    ) : (
      <>
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-3)', fontSize: 13 }}>
          This recipe has no cook steps — log it when it's on the table.
        </div>
        {navBtnRow(null, { label: 'Done — Cooked!', icon: 'check', onClick: () => void finishCooking() })}
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: kiosk ? 0 : '70vh', padding: wide ? '22px 32px 24px' : '14px 14px 20px', gap: 14 }}>
      {header}
      {body}
    </div>
  );
}
