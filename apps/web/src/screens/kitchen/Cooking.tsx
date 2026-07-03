// Cooking — the Kitchen Hub week planner (docs/38 D4, docs/39 P1; screens per the
// approved docs/mockups/kitchen-hub-v4.html). Desktop ≥768px: order-rhythm strip, AI
// request box, 7 day cards (photo · kcal · servings stepper · Swap/Skip), filter chips
// + the library shelf with URL import. Mobile <768px: thumb-first stacked rows with a
// sticky "Add week to Groceries" CTA. Recipe tap → quick-view overlay (modal / sheet).

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ShellContext } from '../../components/shell/AppShell';
import { Badge, Button, Card, Icon, Input, LoadingState, Modal, Slider, Switch } from '../../components/ui';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { KitchenCuisine, KitchenHousehold, MealPlan, MealPlanDay, Recipe } from '../../lib/types';
import { MobileHeader } from '../_shared';
import { CUISINE_LABEL, MetaChips, RecipePhoto, RecipeQuickView, ServingsStepper, dayLabel, weekLabel } from './shared';
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
function cookedOn(recipe: Recipe | null | undefined, date: string): boolean {
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

  const [week, setWeek] = useState(currentWeekStart());
  const [plan, setPlan] = useState<MealPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [quickView, setQuickView] = useState<{ recipe: Recipe; day?: MealPlanDay } | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [askText, setAskText] = useState('');
  const [askResult, setAskResult] = useState<{ ids: string[]; note?: string } | null>(null);

  const { data: recipesResp, refetch: refetchRecipes } = usePolling(api.kitchen.recipes, 0);
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
  const saveAndPlan = async (recipe: Recipe) => {
    const target = plan?.days.find((d) => !d.skip && !d.recipeId) ?? plan?.days.find((d) => !d.skip);
    if (target) await patchDay({ date: target.date, recipeId: recipe.id });
  };
  const saveAndCook = async (recipe: Recipe) => {
    navigate(`/cook/${recipe.id}`);
  };

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
          <button key={id} type="button" onClick={() => setQuickView({ recipe: r })} style={{ ...mini, flex: 'none' }}>
            <Icon name="chef-hat" size={12} /> {r.title}
          </button>
        );
      })}
      <button type="button" onClick={() => setAskResult(null)} style={{ ...mini, flex: 'none' }} aria-label="Dismiss suggestions">
        <Icon name="x" size={12} />
      </button>
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
      <div style={{ flex: 1 }} />
      <Button size="sm" variant="secondary" iconLeft={<Icon name="link" size={13} />} onClick={() => setImportOpen(true)}>
        {wide ? 'New recipe · paste a URL' : 'Import'}
      </Button>
    </div>
  );

  const shelf = (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
      {filteredShelf.map((r) => (
        <Card
          key={r.id}
          interactive
          style={{ width: 168, flex: 'none', padding: 0, overflow: 'hidden', cursor: 'pointer' }}
          onClick={() => setQuickView({ recipe: r })}
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
      ))}
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
          <div style={{ cursor: 'pointer' }} onClick={() => setQuickView({ recipe, day })}>
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
                onClick={() => setQuickView({ recipe, day })}
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
          <div style={{ width: 56, flex: 'none', cursor: 'pointer' }} onClick={() => setQuickView({ recipe, day })}>
            <RecipePhoto recipe={recipe} height={56} radius="var(--radius-md)" style={{ width: 56 }} />
          </div>
        ) : (
          <div style={{ width: 56, height: 56, flex: 'none', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)', display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}>
            <Icon name="chef-hat" size={18} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }} onClick={() => recipe && setQuickView({ recipe, day })}>
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
            onOpenRecipe={(r) => setQuickView({ recipe: r })}
            onSaveCandidate={saveCandidate}
            onSaveAndPlan={saveAndPlan}
            onSaveAndCook={saveAndCook}
          />
        </div>
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 10 }}>
            Your cookbook
          </div>
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
            onOpenRecipe={(r) => setQuickView({ recipe: r })}
            onSaveCandidate={saveCandidate}
            onSaveAndPlan={saveAndPlan}
            onSaveAndCook={saveAndCook}
          />
        </div>
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>
            Your cookbook
          </div>
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
