// Cooking — the Kitchen Hub week planner (docs/38 D4, docs/39 P1; screens per the
// approved docs/mockups/kitchen-hub-v4.html). Desktop ≥768px: order-rhythm strip, AI
// request box, 7 day cards (photo · kcal · servings stepper · Swap/Skip), filter chips
// + the library shelf with URL import. Mobile <768px: thumb-first stacked rows with a
// sticky "Add week to Groceries" CTA. Recipe tap → quick-view overlay (modal / sheet).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ShellContext } from '../../components/shell/AppShell';
import { Badge, Button, Card, Icon, Input, LoadingState, Modal, ProgressBar, Slider, Switch } from '../../components/ui';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { useAuth } from '../../auth/AuthProvider';
import type {
  KitchenCuisine,
  KitchenHousehold,
  LibraryGenerateStatusResponse,
  MealPlan,
  MealPlanDay,
  PlanRequestCandidate,
  Recipe,
  RecipeSlim,
} from '../../lib/types';
import { MobileHeader } from '../_shared';
import {
  CUISINE_LABEL,
  MetaChips,
  nutritionScaleLabel,
  RecipePhoto,
  RecipeQuickView,
  ServingsStepper,
  dayLabel,
  weekLabel,
  type NutritionScaleKey,
} from './shared';
import { WhatCanIMake } from './WhatCanIMake';

// ---- Week helpers (client mirrors of the server's engine) ---------------------------

function currentWeekStart(): string {
  const d = new Date();
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function shiftWeek(weekStart: string, weeks: number): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  const x = new Date(y, m - 1, d + weeks * 7);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function submitCountdown(submitBy: string | undefined): string | null {
  if (!submitBy) return null;
  const ms = new Date(submitBy).getTime() - Date.now();
  if (ms <= 0) return null;
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `submit in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `submit in ${hours} h`;
}

/** "2+2" household-split label when servings match the household, else the number. */
function servingsLabel(servings: number, hh: KitchenHousehold | null): string {
  if (hh && servings === hh.adults + hh.kids) return hh.kids > 0 ? `${hh.adults}+${hh.kids}` : String(hh.adults);
  return String(servings);
}

/** True when this recipe was cooked ON that calendar day (P3 ✓ state on day cards). */
function cookedOn(recipe: Pick<Recipe, 'lastCookedAt'> | null | undefined, date: string): boolean {
  if (!recipe?.lastCookedAt) return false;
  const d = new Date(recipe.lastCookedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` === date;
}

type Filter = 'all' | KitchenCuisine | 'quick' | 'kids' | 'goal';

const mini: CSSProperties = {
  flex: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  minHeight: 30,
  borderRadius: 8,
  border: '1px solid var(--border-2)',
  background: 'var(--surface-2)',
  color: 'var(--text-2)',
  fontSize: 11.5,
  cursor: 'pointer',
  padding: '4px 8px',
};

export function Cooking({ ctx }: { ctx: ShellContext }) {
  const wide = ctx.desktop;
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [week, setWeek] = useState(currentWeekStart());
  const [plan, setPlan] = useState<MealPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [quickView, setQuickView] = useState<{ recipe: Recipe; day?: MealPlanDay } | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pickDay, setPickDay] = useState<MealPlanDay | null>(null);
  const [askText, setAskText] = useState('');
  const [askResult, setAskResult] = useState<{ ids: string[]; note?: string } | null>(null);

  // Shelf search + browse (docs/46 §2b/design spec A): a search box (debounced 300ms → server
  // `q`) + Fish/Veggie chips swap the default horizontal shelf for a paginated server-backed
  // grid; "Browse all" does the same with an empty query.
  const [shelfQuery, setShelfQuery] = useState('');
  const [shelfQueryDebounced, setShelfQueryDebounced] = useState('');
  const [browseAll, setBrowseAll] = useState(false);
  const [fishOnly, setFishOnly] = useState(false);
  const [veggieOnly, setVeggieOnly] = useState(false);
  const [gridPage, setGridPage] = useState(1);
  const [gridItems, setGridItems] = useState<RecipeSlim[]>([]);
  const [gridTotal, setGridTotal] = useState(0);
  const [gridLoading, setGridLoading] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShelfQueryDebounced(shelfQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [shelfQuery]);

  const { data: recipesResp, refetch: refetchRecipes } = usePolling(api.kitchen.recipesAll, 0);
  const { data: householdResp, refetch: refetchHousehold } = usePolling(api.kitchen.household, 0);
  const { data: remindersResp } = usePolling(api.kitchen.reminders, 0);
  const { data: intelResp } = usePolling(api.kitchen.intelligence, 0);
  const { data: draftResp } = usePolling(api.kitchen.orderDraft, 0);

  const recipes = recipesResp?.recipes ?? [];
  const household = householdResp?.household ?? null;
  const reminders = remindersResp?.reminders ?? null;
  const aiOn = Boolean(
    intelResp?.intelligence.enabled && intelResp.intelligence.configured && intelResp.intelligence.features.plannerRequestBox,
  );
  // The discovery hub's Invent/ask actions ride the recipe-generation feature (docs/43).
  const aiGenOn = Boolean(
    intelResp?.intelligence.enabled && intelResp.intelligence.configured && intelResp.intelligence.features.recipeGeneration,
  );
  const byId = useMemo(() => new Map(recipes.map((r) => [r.id, r])), [recipes]);

  const loadPlan = useCallback(() => {
    api.kitchen
      .plan(week)
      .then((r) => setPlan(r.plan))
      .catch(() => setNote('Could not load the week plan'));
  }, [week]);
  useEffect(loadPlan, [loadPlan]);

  const patchDay = async (patch: Parameters<typeof api.kitchen.setPlanDay>[1]) => {
    setBusy(patch.date);
    try {
      const r = await api.kitchen.setPlanDay(week, patch);
      setPlan(r.plan);
    } catch {
      setNote('Change failed — try again');
    } finally {
      setBusy(null);
    }
  };

  const suggest = async (day?: string) => {
    setBusy(day ?? 'week');
    try {
      const r = await api.kitchen.suggest(week, day);
      setPlan(r.plan);
      // Server flags a visible no-op ("Library too small to vary…") — show it
      // instead of letting Suggest/Swap look broken.
      setNote(r.note ?? null);
    } catch {
      setNote('Suggest failed — try again');
    } finally {
      setBusy(null);
    }
  };

  // Per-day "Pick" (docs/46 §1c): assign optimistically — close the sheet immediately, the
  // network call (same mechanism as a hand-pick: pinned:true) finishes in the background.
  const pickForDay = (date: string, recipeId: string) => {
    setPickDay(null);
    void patchDay({ date, recipeId });
  };

  const addWeekToGroceries = async () => {
    setBusy('to-groceries');
    try {
      await api.kitchen.draftFromPlan(week);
      navigate('/groceries');
    } catch {
      setNote('Could not build the order draft');
      setBusy(null);
    }
  };

  const ask = async () => {
    const text = askText.trim();
    if (!text) return;
    setBusy('ask');
    setAskResult(null);
    try {
      const r = await api.kitchen.ask(text);
      setAskResult({ ids: r.candidateIds, note: r.ok ? r.note : 'Closest matches from your library:' });
    } catch {
      setNote('Ask failed — try again');
    } finally {
      setBusy(null);
    }
  };

  /** "Plan it" from quick-view: into the tapped day, else the first open slot. */
  const planRecipe = async (recipe: Recipe, day?: MealPlanDay) => {
    const target = day ?? plan?.days.find((d) => !d.skip && !d.recipeId) ?? plan?.days.find((d) => !d.skip);
    if (!target) return;
    await patchDay({ date: target.date, recipeId: recipe.id });
    setQuickView(null);
  };

  // Discovery hub (docs/43): save an AI candidate INTO the library, then optionally plan it
  // into the week or open cooking mode. createRecipe accepts source:'ai' now; refetch so the
  // new recipe shows in the shelf + resolves in WhatCanIMake's byId map.
  const saveCandidate = async (candidate: Recipe): Promise<Recipe> => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...body } = candidate;
    const r = await api.kitchen.createRecipe(body);
    void refetchRecipes();
    return r.recipe;
  };
  // Only `.id` is needed (candidates may be a full Recipe or a slim library entry — docs/46
  // §2a P2 keeps the client off the full-recipe payload everywhere except cook mode/quick-view).
  const saveAndPlan = async (recipe: Pick<Recipe, 'id'>) => {
    const target = plan?.days.find((d) => !d.skip && !d.recipeId) ?? plan?.days.find((d) => !d.skip);
    if (target) await patchDay({ date: target.date, recipeId: recipe.id });
  };
  const saveAndCook = async (recipe: Pick<Recipe, 'id'>) => {
    navigate(`/cook/${recipe.id}`);
  };

  // Quick-view always needs the FULL recipe (ingredients + steps) — fetch it by id on open
  // rather than keeping every recipe's steps in the client's slim index (docs/46 §2a P2).
  const openRecipe = async (id: string, day?: MealPlanDay) => {
    setBusy(`open-${id}`);
    try {
      const r = await api.kitchen.recipe(id);
      setQuickView({ recipe: r.recipe, day });
    } catch {
      setNote('Could not load that recipe');
    } finally {
      setBusy(null);
    }
  };

  // Shelf search/browse (docs/46 §2b): query or Browse-all or a Fish/Veggie chip swaps the
  // default horizontal shelf for a paginated server-backed grid (search.ts's FTS/filters).
  // Cuisine + "quick" (≤25 min) chips carry over into the grid query; "kids ❤"/"fits goal"
  // have no server-side equivalent (not in docs/46's query param list) so they stay
  // default-shelf-only filters.
  const gridMode = Boolean(shelfQueryDebounced) || browseAll || fishOnly || veggieOnly;
  const gridCuisine = filter !== 'all' && filter !== 'quick' && filter !== 'kids' && filter !== 'goal' ? (filter as KitchenCuisine) : undefined;
  useEffect(() => {
    setGridPage(1);
  }, [shelfQueryDebounced, browseAll, fishOnly, veggieOnly, gridCuisine, filter]);
  useEffect(() => {
    if (!gridMode) return;
    let cancelled = false;
    setGridLoading(true);
    api.kitchen
      .searchRecipes({
        ...(shelfQueryDebounced ? { q: shelfQueryDebounced } : {}),
        ...(gridCuisine ? { cuisine: gridCuisine } : {}),
        ...(filter === 'quick' ? { maxMin: 25 } : {}),
        ...(fishOnly ? { fish: true } : {}),
        ...(veggieOnly ? { veggie: true } : {}),
        page: gridPage,
        pageSize: 30,
      })
      .then((r) => {
        if (cancelled) return;
        setGridItems((prev) => (gridPage === 1 ? r.recipes : [...prev, ...r.recipes]));
        setGridTotal(r.total);
      })
      .catch(() => {
        if (!cancelled) setNote('Search failed — try again');
      })
      .finally(() => {
        if (!cancelled) setGridLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridMode, shelfQueryDebounced, gridCuisine, filter, fishOnly, veggieOnly, gridPage]);

  const filteredShelf = recipes.filter((r) => {
    if (filter === 'all') return true;
    if (filter === 'quick') return r.prepMin + r.cookMin <= 25;
    if (filter === 'kids') return (r.kidScore ?? 0) >= 0.85;
    if (filter === 'goal')
      return Boolean(household?.goals.kcalPerDinner && r.nutrition && r.nutrition.kcal <= household.goals.kcalPerDinner);
    return r.cuisine === filter;
  });

  const showNutrition = household?.showNutritionOnCards ?? true;
  const countdown = submitCountdown(draftResp?.draft.submitBy);

  // ---- Shared fragments -----------------------------------------------------------

  const rhythmStrip = reminders && (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        flexWrap: 'wrap',
        padding: '9px 13px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-1)',
        background: 'var(--surface-1)',
      }}
    >
      <Icon name="truck" size={wide ? 17 : 15} color="var(--solar)" />
      <span style={{ fontSize: wide ? 12.5 : 11.5, color: 'var(--text-2)' }}>
        {wide ? 'Order rhythm — delivery ' : 'Delivery '}
        <b style={{ color: 'var(--text-1)' }}>{reminders.targetSlotLabel}</b> · submit before{' '}
        <b style={{ color: 'var(--text-1)' }}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][reminders.submitByDow]} {String(reminders.submitByHour).padStart(2, '0')}:00
        </b>
      </span>
      {countdown && <Badge tone="solar">{countdown}</Badge>}
      <div style={{ flex: 1 }} />
      {wide && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-3)' }}>
          <Icon name="bell" size={13} />
          Reminders {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][reminders.planWeekDow]}{' '}
          {String(reminders.planWeekHour).padStart(2, '0')}:00 + {String(reminders.submitByHour - 4).padStart(2, '0')}:00
        </span>
      )}
    </div>
  );

  const aiBar = aiOn ? (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '6px 8px 6px 13px',
        borderRadius: 'var(--radius-md)',
        border: '1px dashed var(--border-2)',
        background: 'var(--surface-1)',
        minHeight: 46,
      }}
    >
      <Icon name="sparkles" size={16} color="var(--solar)" />
      <input
        value={askText}
        onChange={(e) => setAskText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void ask();
        }}
        placeholder={wide ? 'Ask for anything — “something light with salmon for Thursday” · “use up the courgettes”' : 'Ask for anything…'}
        style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text-1)', fontSize: 12.5, minWidth: 0 }}
      />
      <button
        type="button"
        aria-label="Ask"
        onClick={() => void ask()}
        style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--solar-wash)', color: 'var(--solar)', border: 'none', cursor: 'pointer' }}
      >
        <Icon name="send" size={14} />
      </button>
    </div>
  ) : (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '9px 13px',
        borderRadius: 'var(--radius-md)',
        border: '1px dashed var(--border-1)',
        color: 'var(--text-3)',
        fontSize: 11.5,
        minHeight: 42,
      }}
    >
      <Icon name="sparkles" size={14} />
      Ask-for-anything needs Intelligence — enable it in Settings ▸ Intelligence. The Suggest engine works without it.
    </div>
  );

  const askResults = askResult && (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {askResult.note && <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{askResult.note}</span>}
      {askResult.ids.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>No matches found.</span>}
      {askResult.ids.map((id) => {
        const r = byId.get(id);
        if (!r) return null;
        return (
          <button key={id} type="button" onClick={() => void openRecipe(r.id)} style={{ ...mini, flex: 'none' }}>
            <Icon name="chef-hat" size={12} /> {r.title}
          </button>
        );
      })}
      <button type="button" onClick={() => setAskResult(null)} style={{ ...mini, flex: 'none' }} aria-label="Dismiss suggestions">
        <Icon name="x" size={12} />
      </button>
    </div>
  );

  // Search row (docs/46 §2b design spec A) — icon + input, 300ms debounce → server `q`.
  const searchRow = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '6px 8px 6px 13px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-2)',
        background: 'var(--surface-1)',
        minHeight: 40,
      }}
    >
      <Icon name="search" size={15} color="var(--text-3)" />
      <input
        value={shelfQuery}
        onChange={(e) => setShelfQuery(e.target.value)}
        placeholder="Search recipes — title, ingredient, tag…"
        style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text-1)', fontSize: 12.5, minWidth: 0 }}
      />
      {shelfQuery && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => setShelfQuery('')}
          style={{ border: 'none', background: 'none', color: 'var(--text-3)', cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 4 }}
        >
          <Icon name="x" size={13} />
        </button>
      )}
    </div>
  );

  const filterChips = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {(
        [
          ['all', 'All'],
          ['spanish', 'Spanish'],
          ['dutch', 'Dutch'],
          ['japanese', 'Japanese'],
          ['italian', 'Italian'],
          ['global', 'Global'],
          ['quick', '≤ 25 min'],
          ['kids', 'Kids ❤'],
          ['goal', 'Fits goal'],
        ] as Array<[Filter, string]>
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => setFilter(key)}
          style={{
            border: 'none',
            background: 'none',
            padding: 0,
            cursor: 'pointer',
          }}
        >
          <Badge tone={filter === key ? 'grid' : 'neutral'}>{label}</Badge>
        </button>
      ))}
      {/* Server-backed filters (docs/46 §2b) — selecting either swaps the shelf for the grid. */}
      <button type="button" onClick={() => setFishOnly((v) => !v)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}>
        <Badge tone={fishOnly ? 'grid' : 'neutral'}>Fish</Badge>
      </button>
      <button type="button" onClick={() => setVeggieOnly((v) => !v)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}>
        <Badge tone={veggieOnly ? 'grid' : 'neutral'}>Veggie</Badge>
      </button>
      <div style={{ flex: 1 }} />
      <Button size="sm" variant="secondary" iconLeft={<Icon name="link" size={13} />} onClick={() => setImportOpen(true)}>
        {wide ? 'New recipe · paste a URL' : 'Import'}
      </Button>
    </div>
  );

  const shelfCard = (r: RecipeSlim, width: number | undefined) => (
    <Card
      key={r.id}
      interactive
      style={{ width, flex: width ? 'none' : undefined, padding: 0, overflow: 'hidden', cursor: 'pointer' }}
      onClick={() => void openRecipe(r.id)}
    >
      <RecipePhoto recipe={r} height={72} />
      <div style={{ padding: '9px 11px 11px' }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.25, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {r.title}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10.5, color: 'var(--text-3)' }}>
          <span>{CUISINE_LABEL[r.cuisine]}</span>
          {showNutrition && r.nutrition && <span style={{ fontFamily: 'var(--font-mono)' }}>{r.nutrition.kcal} kcal</span>}
        </div>
      </div>
    </Card>
  );

  const shimmerCard = (key: number) => (
    <div
      key={key}
      style={{
        height: 72 + 46,
        borderRadius: 'var(--radius-card, 14px)',
        background: 'linear-gradient(90deg,var(--surface-1),var(--surface-2),var(--surface-1))',
        backgroundSize: '200% 100%',
        animation: 'pwr-shimmer 1.4s ease-in-out infinite',
      }}
    />
  );

  // "Your cookbook" section header — the count + "Browse all →" button live here (default
  // shelf only; the grid header shows "Showing X of Y" near its Load more footer instead).
  const cookbookHeader = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
        Your cookbook
      </div>
      {!gridMode && (
        <button
          type="button"
          onClick={() => setBrowseAll(true)}
          style={{ border: 'none', background: 'none', color: 'var(--solar)', fontSize: 11.5, cursor: 'pointer', padding: 0 }}
        >
          Browse all {recipes.length.toLocaleString()} →
        </button>
      )}
    </div>
  );

  const gridColumns = wide ? 'repeat(auto-fill, minmax(168px, 1fr))' : 'repeat(2, 1fr)';

  const shelf = gridMode ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: gridColumns, gap: 10 }}>
        {gridItems.map((r) => shelfCard(r, undefined))}
        {gridLoading && gridPage === 1 && Array.from({ length: 6 }).map((_, i) => shimmerCard(i))}
      </div>
      {!gridLoading && gridItems.length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', textAlign: 'center', padding: '18px 4px' }}>
          No recipes match — try fewer words
        </div>
      )}
      {gridItems.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {gridItems.length < gridTotal && (
            <Button size="sm" variant="secondary" loading={gridLoading && gridPage > 1} onClick={() => setGridPage((p) => p + 1)}>
              Load more
            </Button>
          )}
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            Showing {gridItems.length} of {gridTotal.toLocaleString()}
          </span>
        </div>
      )}
    </div>
  ) : (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
      {filteredShelf.slice(0, 30).map((r) => shelfCard(r, 168))}
      {filteredShelf.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '14px 4px' }}>No recipes match this filter yet.</div>
      )}
    </div>
  );

  // ---- Day cards -----------------------------------------------------------------------

  function DayCardWide({ day }: { day: MealPlanDay }) {
    const recipe = day.recipeId ? byId.get(day.recipeId) : null;
    if (day.skip) {
      return (
        <div
          style={{
            border: '1px dashed var(--border-2)',
            borderRadius: 'var(--radius-card, 14px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            minHeight: 240,
            color: 'var(--text-3)',
            padding: 12,
          }}
        >
          <Icon name="utensils-crossed" size={26} />
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{dayLabel(day.date)}</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>Skipped — eating out</div>
          <span style={{ fontSize: 11 }}>No ingredients ordered</span>
          <button type="button" style={{ ...mini, width: '70%', flex: 'none' }} onClick={() => void patchDay({ date: day.date, skip: false })}>
            <Icon name="refresh-cw" size={13} /> Undo
          </button>
        </div>
      );
    }
    return (
      <Card style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {recipe ? (
          <div style={{ cursor: 'pointer' }} onClick={() => void openRecipe(recipe.id, day)}>
            <RecipePhoto recipe={recipe} height={96} />
          </div>
        ) : (
          <div style={{ height: 96, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}>
            <Icon name="chef-hat" size={22} />
          </div>
        )}
        <div style={{ padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)' }}>
            <span>
              {dayLabel(day.date)}
              {cookedOn(recipe, day.date) && (
                <span style={{ color: 'var(--solar)', marginLeft: 6 }}>
                  <Icon name="check" size={11} /> cooked
                </span>
              )}
            </span>
            {recipe && (
              <button
                type="button"
                aria-label={day.pinned ? 'Unpin' : 'Pin'}
                onClick={() => void patchDay({ date: day.date, pinned: !day.pinned })}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: day.pinned ? 'var(--grid)' : 'var(--text-3)', padding: 2 }}
              >
                <Icon name="pin" size={13} />
              </button>
            )}
          </div>
          {recipe ? (
            <>
              <div
                style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3, cursor: 'pointer', minHeight: 35 }}
                onClick={() => void openRecipe(recipe.id, day)}
              >
                {recipe.title}
              </div>
              <MetaChips recipe={recipe} showNutrition={showNutrition} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--text-3)' }}>
                <ServingsStepper compact value={day.servings} onChange={(v) => void patchDay({ date: day.date, servings: v })} />
                servings
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-3)', flex: 1 }}>Nothing planned yet.</div>
          )}
          <div style={{ display: 'flex', gap: 7, marginTop: 'auto' }}>
            <button type="button" style={mini} disabled={busy === day.date} onClick={() => void suggest(day.date)}>
              <Icon name="refresh-cw" size={13} /> {recipe ? 'Swap' : 'Suggest'}
            </button>
            <button type="button" style={mini} onClick={() => setPickDay(day)}>
              <Icon name="search" size={13} /> Pick
            </button>
            <button type="button" style={mini} onClick={() => void patchDay({ date: day.date, skip: true })}>
              <Icon name="utensils-crossed" size={13} /> Skip
            </button>
          </div>
        </div>
      </Card>
    );
  }

  function DayRowMobile({ day }: { day: MealPlanDay }) {
    const recipe = day.recipeId ? byId.get(day.recipeId) : null;
    if (day.skip) {
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            border: '1px dashed var(--border-2)',
            borderRadius: 'var(--radius-card, 14px)',
            padding: '10px 12px',
            color: 'var(--text-3)',
            minHeight: 56,
          }}
        >
          <Icon name="utensils-crossed" size={18} />
          <div style={{ flex: 1, fontSize: 13, color: 'var(--text-2)', fontWeight: 500 }}>
            {dayLabel(day.date)} · skipped — eating out
          </div>
          <button type="button" style={{ ...mini, flex: 'none', minHeight: 46, minWidth: 60 }} onClick={() => void patchDay({ date: day.date, skip: false })}>
            Undo
          </button>
        </div>
      );
    }
    return (
      <Card style={{ padding: 10, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {recipe ? (
          <div style={{ width: 56, flex: 'none', cursor: 'pointer' }} onClick={() => void openRecipe(recipe.id, day)}>
            <RecipePhoto recipe={recipe} height={56} radius="var(--radius-md)" style={{ width: 56 }} />
          </div>
        ) : (
          <div style={{ width: 56, height: 56, flex: 'none', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)', display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}>
            <Icon name="chef-hat" size={18} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }} onClick={() => recipe && void openRecipe(recipe.id, day)}>
          <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {recipe ? recipe.title : 'Nothing planned'}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {dayLabel(day.date)}
              {recipe && ` · ${recipe.prepMin + recipe.cookMin} min`}
              {recipe && showNutrition && recipe.nutrition && ` · ${recipe.nutrition.kcal} kcal`}
              {cookedOn(recipe, day.date) && <span style={{ color: 'var(--solar)' }}> · ✓ cooked</span>}
            </span>
            {recipe && (recipe.kidScore ?? 0) >= 0.85 ? (
              <span style={{ color: 'var(--grid)' }}>Kids ❤</span>
            ) : (
              <span style={{ fontFamily: 'var(--font-mono)' }}>{servingsLabel(day.servings, household)}</span>
            )}
          </div>
        </div>
        <button type="button" aria-label={recipe ? 'Swap' : 'Suggest'} disabled={busy === day.date} onClick={() => void suggest(day.date)} style={{ ...mini, flex: 'none', width: 46, minHeight: 46 }}>
          <Icon name="refresh-cw" size={15} />
        </button>
        <button type="button" aria-label="Pick" onClick={() => setPickDay(day)} style={{ ...mini, flex: 'none', width: 46, minHeight: 46 }}>
          <Icon name="search" size={15} />
        </button>
        <button type="button" aria-label="Skip" onClick={() => void patchDay({ date: day.date, skip: true })} style={{ ...mini, flex: 'none', width: 46, minHeight: 46 }}>
          <Icon name="utensils-crossed" size={15} />
        </button>
      </Card>
    );
  }

  const weekNav = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button type="button" aria-label="Previous week" style={{ ...mini, flex: 'none', width: 30 }} onClick={() => setWeek(shiftWeek(week, -1))}>
        <Icon name="chevron-left" size={14} />
      </button>
      <span style={{ fontSize: wide ? 13 : 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{weekLabel(week)}</span>
      <button type="button" aria-label="Next week" style={{ ...mini, flex: 'none', width: 30 }} onClick={() => setWeek(shiftWeek(week, 1))}>
        <Icon name="chevron-right" size={14} />
      </button>
    </div>
  );

  if (!plan) {
    return (
      <>
        <MobileHeader eyebrow="Kitchen" title="Cooking" />
        <LoadingState label="Loading the week…" />
      </>
    );
  }

  const overlays = (
    <>
      {quickView && (
        <RecipeQuickView
          recipe={quickView.recipe}
          desktop={wide}
          planContext={quickView.day ? `Planned · ${dayLabel(quickView.day.date)}` : undefined}
          servings={quickView.day?.servings ?? (household ? household.adults + household.kids : quickView.recipe.servingsBase)}
          onServings={quickView.day ? (v) => void patchDay({ date: quickView.day!.date, servings: v }) : undefined}
          draftLines={draftResp?.draft.lines}
          showNutrition={showNutrition}
          goalKcal={household?.goals.kcalPerDinner}
          onClose={() => setQuickView(null)}
          onPlan={quickView.day ? undefined : () => void planRecipe(quickView.recipe)}
          onSendToGroceries={() => {
            void addWeekToGroceries();
          }}
          extraActions={
            <Button
              variant="secondary"
              style={{ flex: 1 }}
              iconLeft={<Icon name="play" size={15} />}
              onClick={() => navigate(`/cook/${quickView.recipe.id}${quickView.day ? `?date=${quickView.day.date}` : ''}`)}
            >
              Cook now
            </Button>
          }
        />
      )}
      {prefsOpen && household && (
        <PreferencesModal
          desktop={wide}
          household={household}
          onClose={() => setPrefsOpen(false)}
          onSaved={() => {
            setPrefsOpen(false);
            void refetchHousehold();
          }}
        />
      )}
      {importOpen && (
        <ImportModal
          desktop={wide}
          onClose={() => setImportOpen(false)}
          onImported={(r) => {
            setImportOpen(false);
            void refetchRecipes();
            setQuickView({ recipe: r });
          }}
        />
      )}
      {pickDay && (
        <PickSheet
          desktop={wide}
          day={pickDay}
          week={week}
          showNutrition={showNutrition}
          onClose={() => setPickDay(null)}
          onPick={(recipeId) => pickForDay(pickDay.date, recipeId)}
        />
      )}
    </>
  );

  if (wide) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1280, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {weekNav}
          <div style={{ flex: 1 }} />
          <Button variant="ghost" iconLeft={<Icon name="users" size={15} />} onClick={() => setPrefsOpen(true)}>
            Preferences
          </Button>
          <Button variant="secondary" loading={busy === 'week'} iconLeft={<Icon name="refresh-cw" size={15} />} onClick={() => void suggest()}>
            Suggest week
          </Button>
          <Button variant="primary" loading={busy === 'to-groceries'} iconRight={<Icon name="chevron-right" size={15} />} onClick={() => void addWeekToGroceries()}>
            Add week to Groceries
          </Button>
        </div>
        {note && (
          <div style={{ fontSize: 12, color: 'var(--grid)', background: 'var(--grid-wash)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }} onClick={() => setNote(null)}>
            {note}
          </div>
        )}
        {rhythmStrip}
        {aiBar}
        {askResults}
        {/* 7-across on a full desktop (mockup); auto-fit lets narrower windows wrap. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))', gap: 12 }}>
          {plan.days.map((d) => (
            <DayCardWide key={d.date} day={d} />
          ))}
        </div>
        {/* Discovery is a first-class section between the planner and the library shelf (docs/43). */}
        <div style={{ marginTop: 6, padding: '16px 18px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-1)', background: 'var(--surface-1)' }}>
          <WhatCanIMake
            recipes={recipes}
            aiOn={aiGenOn}
            wide
            showNutrition={showNutrition}
            onOpenRecipe={(r) => void openRecipe(r.id)}
            onSaveCandidate={saveCandidate}
            onSaveAndPlan={saveAndPlan}
            onSaveAndCook={saveAndCook}
          />
        </div>
        <LibraryCard isAdmin={isAdmin} libraryCount={recipes.length} />
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {cookbookHeader}
          {searchRow}
          {filterChips}
        </div>
        {shelf}
        {overlays}
      </div>
    );
  }

  // ---- Mobile (<768px) --------------------------------------------------------------
  return (
    <>
      <MobileHeader
        eyebrow="Kitchen"
        title="Cooking"
        right={
          <Button size="sm" variant="secondary" loading={busy === 'week'} iconLeft={<Icon name="refresh-cw" size={13} />} onClick={() => void suggest()}>
            Suggest
          </Button>
        }
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 14px 10px' }}>
        {note && (
          <div style={{ fontSize: 12, color: 'var(--grid)', background: 'var(--grid-wash)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }} onClick={() => setNote(null)}>
            {note}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {weekNav}
          <div style={{ flex: 1 }} />
          <Button size="sm" variant="ghost" iconLeft={<Icon name="users" size={13} />} onClick={() => setPrefsOpen(true)}>
            Prefs
          </Button>
        </div>
        {rhythmStrip}
        {aiBar}
        {askResults}
        {plan.days.map((d) => (
          <DayRowMobile key={d.date} day={d} />
        ))}
        {/* Discovery section — prominent, between the planner and the cookbook shelf (docs/43). */}
        <div style={{ marginTop: 4, padding: '13px 13px 15px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-1)', background: 'var(--surface-1)' }}>
          <WhatCanIMake
            recipes={recipes}
            aiOn={aiGenOn}
            wide={false}
            showNutrition={showNutrition}
            onOpenRecipe={(r) => void openRecipe(r.id)}
            onSaveCandidate={saveCandidate}
            onSaveAndPlan={saveAndPlan}
            onSaveAndCook={saveAndCook}
          />
        </div>
        <LibraryCard isAdmin={isAdmin} libraryCount={recipes.length} />
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 9 }}>
          {cookbookHeader}
          {searchRow}
          {filterChips}
        </div>
        {shelf}
      </div>
      <div style={{ position: 'sticky', bottom: 0, padding: '10px 14px calc(12px + env(safe-area-inset-bottom))', background: 'linear-gradient(transparent, var(--bg-0) 40%)' }}>
        <Button variant="primary" size="lg" block loading={busy === 'to-groceries'} iconRight={<Icon name="chevron-right" size={16} />} onClick={() => void addWeekToGroceries()}>
          Add week to Groceries
        </Button>
      </div>
      {overlays}
    </>
  );
}

// ---- Recipe library card (docs/46 §2c design spec B) — admin-only generation control; -----
// non-admin sees just the count line. Polls status every 5s only while a run is in progress
// (idle/done/error/cancelled don't need it — a manual refetch after Start/Cancel is enough).
function LibraryCard({ isAdmin, libraryCount }: { isAdmin: boolean; libraryCount: number }) {
  const [status, setStatus] = useState<LibraryGenerateStatusResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState(2000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.kitchen
      .libraryGenerateStatus()
      .then((r) => setStatus(r))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (status?.job.status !== 'running') return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [status?.job.status, load]);

  if (!isAdmin) {
    return (
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', padding: '2px 2px 0' }}>
        {libraryCount.toLocaleString()} recipe{libraryCount === 1 ? '' : 's'} in your cookbook
      </div>
    );
  }

  const job = status?.job;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.kitchen.startLibraryGeneration(target);
      setStatus(r);
      if (!r.ok) setError(r.reason ?? 'Could not start generation');
      else setConfirming(false);
    } catch {
      setError('Could not start generation — try again');
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      const r = await api.kitchen.cancelLibraryGeneration();
      setStatus(r);
    } catch {
      setError('Could not stop generation');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ padding: '13px 16px 15px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="pwr-eyebrow">RECIPE LIBRARY</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, color: 'var(--text-1)' }}>
          {(status?.libraryCount ?? libraryCount).toLocaleString()} recipe{(status?.libraryCount ?? libraryCount) === 1 ? '' : 's'}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Target 2,000 · AI-generated, tuned to your household</div>

      {(!job || job.status === 'idle' || job.status === 'cancelled') && !confirming && (
        <Button size="sm" variant="primary" iconLeft={<Icon name="sparkles" size={13} />} onClick={() => setConfirming(true)} style={{ alignSelf: 'flex-start' }}>
          Generate
        </Button>
      )}

      {(!job || job.status === 'idle' || job.status === 'cancelled') && confirming && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>Target</span>
            <button
              type="button"
              onClick={() => setTarget((t) => Math.max(250, t - 250))}
              style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-1)', cursor: 'pointer' }}
            >
              −
            </button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, minWidth: 52, textAlign: 'center' }}>{target.toLocaleString()}</span>
            <button
              type="button"
              onClick={() => setTarget((t) => Math.min(5000, t + 250))}
              style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-1)', cursor: 'pointer' }}
            >
              +
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>≈ €12–18 · hard cap €25</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void start()}>
              Start
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {job?.status === 'running' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ProgressBar value={job.insertedCount} max={Math.max(1, job.target)} tone="solar" height={7} />
          <div style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>
            queued {job.queued} · inserted {job.insertedCount} · dupes {job.duplicateCount} · failed {job.failedCount} · €{job.spentEur.toFixed(2)} spent
          </div>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void cancel()} style={{ alignSelf: 'flex-start' }}>
            Stop
          </Button>
        </div>
      )}

      {job?.status === 'done' && (
        <div style={{ fontSize: 12.5, color: 'var(--solar)' }}>
          Library grew to {(status?.libraryCount ?? libraryCount).toLocaleString()} recipes · €{job.spentEur.toFixed(2)} spent
        </div>
      )}

      {(job?.status === 'error' || error || (status && !status.configured && confirming)) && (
        <div style={{ fontSize: 12, color: 'var(--danger)' }}>
          {error || job?.error || 'No Anthropic key — add it in Settings → Intelligence'}
        </div>
      )}
    </Card>
  );
}

// ---- Per-day "Pick" sheet (docs/46 §1c + design addendum §A) --------------------------
// Request text + 6 candidates for ONE day. Deterministic-first (POST /plan/request), the
// server optionally re-ranks with AI behind the plannerRequestBox feature — this component
// doesn't know or care which path answered; it just renders what came back.

const PICK_QUICK_CHIPS: Array<{ label: string; text: string }> = [
  { label: 'Fish', text: 'fish' },
  { label: 'Veggie', text: 'veggie' },
  { label: 'Quick (≤25 min)', text: 'quick under 25 minutes' },
  { label: "Kids' favourite", text: 'kids favourite' },
];

/** "Tuesday · 15 Jul" for the sheet header. */
function pickSheetTitle(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' });
  const month = d.toLocaleDateString('en-GB', { month: 'short' });
  return `${weekday} · ${d.getDate()} ${month}`;
}

function PickSkeletonCard() {
  return (
    <div
      style={{
        height: 88,
        borderRadius: 'var(--radius-md)',
        background: 'linear-gradient(90deg,var(--surface-1),var(--surface-2),var(--surface-1))',
        backgroundSize: '200% 100%',
        animation: 'pwr-shimmer 1.4s ease-in-out infinite',
      }}
    />
  );
}

function PickCandidateCard({
  candidate,
  showNutrition,
  busy,
  onPick,
}: {
  candidate: PlanRequestCandidate;
  showNutrition: boolean;
  busy: boolean;
  onPick: () => void;
}) {
  const { recipe } = candidate;
  const [hot, setHot] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onPick}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => {
        setHot(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        textAlign: 'left',
        padding: 9,
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${hot ? 'var(--solar)' : 'var(--border-2)'}`,
        background: 'var(--surface-2)',
        cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.6 : pressed ? 0.75 : 1,
        transform: hot && !pressed ? 'translateY(-1px)' : 'none',
        transition: 'border-color var(--dur-fast, 120ms) var(--ease-out), transform var(--dur-fast, 120ms) var(--ease-out), opacity var(--dur-fast, 120ms) var(--ease-out)',
        width: '100%',
      }}
    >
      <RecipePhoto recipe={recipe} height={72} radius="var(--radius-md)" style={{ width: 72 }} />
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 1.25,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {recipe.title}
        </div>
        <MetaChips recipe={recipe} showNutrition={showNutrition} />
        <div style={{ fontSize: 11, color: 'var(--solar)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Icon name="zap" size={11} /> {candidate.why}
        </div>
      </div>
    </button>
  );
}

function PickSheet({
  desktop,
  day,
  week,
  showNutrition,
  onClose,
  onPick,
}: {
  desktop: boolean;
  day: MealPlanDay;
  week: string;
  showNutrition: boolean;
  onClose: () => void;
  onPick: (recipeId: string) => void;
}) {
  const [text, setText] = useState('');
  const [candidates, setCandidates] = useState<PlanRequestCandidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const shownIds = useRef<string[]>([]);

  const run = useCallback(
    async (queryText: string, excludeIds: string[] = []) => {
      setLoading(true);
      setError(null);
      try {
        const r = await api.kitchen.planRequest(week, day.date, queryText || undefined, excludeIds);
        setCandidates(r.candidates);
        // Refresh ACCUMULATES exclusions (excludeIds carried the previous rounds) so a
        // third Refresh can't re-surface the first set; a fresh run (submit / quick chip /
        // sheet open — empty excludeIds) resets the memory to just this new list.
        shownIds.current = [...excludeIds, ...r.candidates.map((c) => c.recipe.id)];
      } catch {
        setError('Could not load suggestions — try again');
        setCandidates([]);
      } finally {
        setLoading(false);
      }
    },
    [week, day.date],
  );

  useEffect(() => {
    void run('');
    // day.date pins this effect to the day this sheet was opened for; run() itself is
    // stable per (week, day.date) so it's safe to omit from the deps list here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day.date]);

  const submit = () => void run(text.trim());
  const refresh = () => void run(text.trim(), shownIds.current);
  const quickChip = (q: string) => {
    setText(q);
    void run(q);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span>
          <span className="pwr-eyebrow" style={{ display: 'block', marginBottom: 2 }}>
            Pick a dinner
          </span>
          {pickSheetTitle(day.date)}
        </span>
      }
      icon="search"
      size="lg"
      placement={desktop ? 'center' : 'sheet'}
      wideViewport={desktop}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 18px 18px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px 6px 13px',
            borderRadius: 'var(--radius-md)',
            border: '1px dashed var(--border-2)',
            background: 'var(--surface-1)',
            minHeight: 46,
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="What do you fancy? e.g. light, with fish…"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text-1)', fontSize: 12.5, minWidth: 0 }}
          />
          <button
            type="button"
            aria-label="Search"
            onClick={submit}
            style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--solar-wash)', color: 'var(--solar)', border: 'none', cursor: 'pointer', flex: 'none' }}
          >
            <Icon name="arrow-right" size={15} />
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PICK_QUICK_CHIPS.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => quickChip(c.text)}
              style={{
                fontSize: 11.5,
                padding: '4px 10px',
                borderRadius: 999,
                border: '1px solid var(--border-2)',
                background: 'var(--surface-2)',
                color: 'var(--text-2)',
                cursor: 'pointer',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>

        {loading && (
          <div style={{ display: 'grid', gridTemplateColumns: desktop ? '1fr 1fr' : '1fr', gap: 8 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <PickSkeletonCard key={i} />
            ))}
          </div>
        )}

        {!loading && error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>}

        {!loading && !error && candidates && candidates.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '20px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Nothing matches that — try loosening the request</div>
            <Button size="sm" variant="secondary" onClick={() => quickChip('')}>
              Show good options
            </Button>
          </div>
        )}

        {!loading && !error && candidates && candidates.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: desktop ? '1fr 1fr' : '1fr', gap: 8 }}>
            {candidates.map((c) => (
              <PickCandidateCard key={c.recipe.id} candidate={c} showNutrition={showNutrition} busy={false} onPick={() => onPick(c.recipe.id)} />
            ))}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-start', paddingTop: 2 }}>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-2)',
              background: 'none',
              border: 'none',
              cursor: loading ? 'default' : 'pointer',
              padding: '4px 2px',
            }}
          >
            <Icon name="rotate-ccw" size={13} /> Refresh
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- Preferences (household · goals · loves · allergies · dislikes · cuisine weights) ----

function ChipsEditor({
  label,
  hint,
  values,
  tone,
  onChange,
  presets,
}: {
  label: string;
  hint: string;
  values: string[];
  tone: 'solar' | 'neutral';
  onChange: (next: string[]) => void;
  /** Optional preset toggles rendered before the free-text chips (e.g. diet slugs). */
  presets?: Array<{ value: string; label: string }>;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim().toLowerCase();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  const presetValues = new Set((presets ?? []).map((p) => p.value));
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border-1)' }}>
      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', margin: '2px 0 8px' }}>{hint}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {(presets ?? []).map((p) => {
          const active = values.includes(p.value);
          return (
            <button
              key={p.value}
              type="button"
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}
              onClick={() => onChange(active ? values.filter((x) => x !== p.value) : [...values, p.value])}
            >
              <Badge tone={active ? 'grid' : 'neutral'}>
                {p.label}
                {active ? ' ✓' : ''}
              </Badge>
            </button>
          );
        })}
        {values.filter((v) => !presetValues.has(v)).map((v) => (
          <button key={v} type="button" style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }} onClick={() => onChange(values.filter((x) => x !== v))}>
            <Badge tone={tone}>{v} ✕</Badge>
          </button>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder="＋ add"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 999, padding: '3px 10px', fontSize: 11.5, color: 'var(--text-1)', width: 90, outline: 'none' }}
        />
      </div>
    </div>
  );
}

function PreferencesModal({
  desktop,
  household,
  onClose,
  onSaved,
}: {
  desktop: boolean;
  household: KitchenHousehold;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [h, setH] = useState<KitchenHousehold>(structuredClone(household));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.kitchen.setHousehold(h);
      onSaved();
    } catch {
      setSaving(false);
    }
  };
  const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-1)' };
  const restrictions = h.dietRestrictions ?? [];
  return (
    <Modal
      open
      onClose={onClose}
      title="Preferences"
      subtitle="Household · diet · goals · cuisine weights"
      icon="users"
      size="lg"
      placement={desktop ? 'center' : 'sheet'}
      wideViewport={desktop}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save preferences
          </Button>
        </>
      }
    >
      {/* 18px horizontal inset aligns the body with the Modal header/footer. */}
      <div style={{ display: 'flex', flexDirection: 'column', padding: '4px 18px 10px' }}>
        {/* Household first — family size drives every default serving. */}
        <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--home)', padding: '10px 0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="users" size={12} /> Household
        </div>
        <div
          style={{
            border: '1px solid var(--border-2)',
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>Family size</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Who’s at the table — sizes every dinner</div>
            </div>
            <span style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11, color: 'var(--text-3)' }}>
              <ServingsStepper compact value={h.adults} onChange={(v) => setH({ ...h, adults: v })} /> adults
              <ServingsStepper compact min={0} value={h.kids} onChange={(v) => setH({ ...h, kids: Math.max(0, v) })} /> kids
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-2)', background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '7px 10px' }}>
            {h.adults} adult{h.adults === 1 ? '' : 's'}
            {h.kids > 0 ? ` + ${h.kids} kid${h.kids === 1 ? '' : 's'}` : ''} →{' '}
            <b style={{ color: 'var(--text-1)' }}>default {h.adults + h.kids} serving{h.adults + h.kids === 1 ? '' : 's'} per dinner</b>
          </div>
        </div>
        <div style={row}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Weeknight time budget</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Mon–Thu suggestions stay under this</div>
          </div>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ServingsStepper compact value={Math.round(h.weeknightMaxMin / 5)} onChange={(v) => setH({ ...h, weeknightMaxMin: Math.max(10, Math.min(180, v * 5)) })} />
            <b style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>≤ {h.weeknightMaxMin} min</b>
          </span>
        </div>

        <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--home)', padding: '14px 0 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="target" size={12} /> Goals
        </div>
        <div style={row}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Eating direction</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Weights suggestions — never blocks your own picks</div>
          </div>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {(
              [
                ['weight-loss', 'Weight loss'],
                ['maintain', 'Maintain'],
                ['high-protein', 'High protein'],
              ] as Array<[NonNullable<KitchenHousehold['goals']['mode']>, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}
                onClick={() => setH({ ...h, goals: { ...h.goals, mode: h.goals.mode === mode ? null : mode } })}
              >
                <Badge tone={h.goals.mode === mode ? 'solar' : 'neutral'}>
                  {label}
                  {h.goals.mode === mode ? ' ✓' : ''}
                </Badge>
              </button>
            ))}
          </span>
        </div>
        <div style={row}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Dinner calorie target</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Per adult serving · powers the “Fits goal” badge</div>
          </div>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ServingsStepper
              compact
              value={Math.round((h.goals.kcalPerDinner ?? 650) / 50)}
              onChange={(v) => setH({ ...h, goals: { ...h.goals, kcalPerDinner: Math.max(200, Math.min(2000, v * 50)) } })}
            />
            <b style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{h.goals.kcalPerDinner ? `≤ ${h.goals.kcalPerDinner} kcal` : 'off'}</b>
          </span>
        </div>
        <div style={row}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Show nutrition on cards</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>kcal on cards · macros in quick-view</div>
          </div>
          <Switch checked={h.showNutritionOnCards} onChange={(e) => setH({ ...h, showNutritionOnCards: e.target.checked })} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0 4px' }}>
          <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--home)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="leaf" size={12} /> Nutrition &amp; sourcing
          </div>
          <button
            type="button"
            onClick={() => setH({ ...h, nutritionScales: { calories: 5, carbs: 5, fish: 5, veg: 5, protein: 5 } })}
            style={{ border: 'none', background: 'none', color: 'var(--text-3)', fontSize: 11.5, cursor: 'pointer', padding: 0 }}
          >
            Reset
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '2px 0 8px' }}>
          {(
            [
              ['calories', 'Calories'],
              ['carbs', 'Carbs'],
              ['fish', 'Fish'],
              ['veg', 'Veg'],
              ['protein', 'Protein'],
            ] as Array<[NutritionScaleKey, string]>
          ).map(([key, label]) => (
            <div key={key}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 13, color: 'var(--text-1)' }}>{label}</span>
                <span style={{ fontSize: 11.5, color: 'var(--solar)', fontWeight: 600 }}>{nutritionScaleLabel(key, h.nutritionScales[key])}</span>
              </div>
              <Slider
                min={1}
                max={10}
                showValue={false}
                value={h.nutritionScales[key]}
                onChange={(v) => setH({ ...h, nutritionScales: { ...h.nutritionScales, [key]: v } })}
              />
            </div>
          ))}
        </div>
        <div style={row}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Seasonal &amp; local</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Prefer in-season produce (Costa Blanca)</div>
          </div>
          <Switch checked={h.seasonalLocal} onChange={(e) => setH({ ...h, seasonalLocal: e.target.checked })} />
        </div>
        <ChipsEditor
          label="Boost ingredients (garden surplus)"
          hint="We'll favour recipes that use these — e.g. aguacate, tomate"
          values={h.boostIngredients ?? []}
          tone="solar"
          onChange={(boostIngredients) => setH({ ...h, boostIngredients })}
        />

        <ChipsEditor
          label="Loves — always welcome"
          hint="Ingredients the suggestion engine boosts"
          values={h.loves}
          tone="solar"
          onChange={(loves) => setH({ ...h, loves })}
        />
        <ChipsEditor
          label="Diet restrictions"
          hint="Hard filter — matching recipes are never suggested. Toggle presets or add your own"
          values={restrictions}
          tone="neutral"
          presets={[
            { value: 'vegetarian', label: 'Vegetarian' },
            { value: 'vegan', label: 'Vegan' },
            { value: 'pescatarian', label: 'Pescatarian' },
            { value: 'no-pork', label: 'No pork' },
            { value: 'no-beef', label: 'No beef' },
            { value: 'gluten-free', label: 'Gluten-free' },
            { value: 'lactose-free', label: 'Lactose-free' },
          ]}
          onChange={(dietRestrictions) => setH({ ...h, dietRestrictions })}
        />
        <ChipsEditor
          label="Allergies"
          hint="Hard filter — never suggested"
          values={h.allergies}
          tone="neutral"
          onChange={(allergies) => setH({ ...h, allergies })}
        />
        <ChipsEditor
          label="Dislikes"
          hint="Soft filter — needs a manual pick"
          values={h.dislikes}
          tone="neutral"
          onChange={(dislikes) => setH({ ...h, dislikes })}
        />

        <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-3)', padding: '14px 0 6px' }}>Cuisine weights</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 4 }}>
          {(Object.keys(CUISINE_LABEL) as KitchenCuisine[]).map((c) => (
            <Slider
              key={c}
              label={CUISINE_LABEL[c]}
              unit="%"
              value={h.cuisineWeights[c]}
              onChange={(v: number) => setH({ ...h, cuisineWeights: { ...h.cuisineWeights, [c]: v } })}
            />
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ---- URL import ------------------------------------------------------------------------

function ImportModal({ desktop, onClose, onImported }: { desktop: boolean; onClose: () => void; onImported: (r: Recipe) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<{ detail?: string; title?: string } | null>(null);

  const run = async () => {
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    setFail(null);
    try {
      const r = await api.kitchen.importRecipe(u);
      if (r.ok && r.recipe) onImported(r.recipe);
      else setFail({ detail: r.detail, title: r.prefill?.title });
    } catch (e) {
      setFail({ detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const createManual = async () => {
    setBusy(true);
    try {
      const r = await api.kitchen.createRecipe({
        title: fail?.title || 'New recipe',
        source: 'manual',
        sourceUrl: url.trim() || undefined,
        ingredients: [],
        steps: [],
      });
      onImported(r.recipe);
    } catch {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Import a recipe"
      subtitle="Paste any recipe URL — most sites parse automatically"
      icon="link"
      placement={desktop ? 'center' : 'sheet'}
      wideViewport={desktop}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void run()} disabled={!url.trim()}>
            Import
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px' }}>
        <Input
          label="Recipe URL"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
        />
        {fail && (
          <div style={{ fontSize: 12, color: 'var(--text-2)', background: 'var(--grid-wash)', borderRadius: 'var(--radius-md)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>
              Couldn’t parse that page{fail.detail ? ` (${fail.detail})` : ''}. You can still add it by hand
              {fail.title ? ` — we found the title “${fail.title}”` : ''}.
            </span>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void createManual()}>
              Create manual entry
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
