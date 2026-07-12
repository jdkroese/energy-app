// Kiosk kitchen widgets (P3, docs/42 §1 — v4 mockup frame 5): the Tonight card,
// "we're out of…" quick-add tiles, the 7-day week strip and the order-status card.
// Shared by TabletHome (Tonight integrated on the kiosk home — owner decision,
// docs/38 §12) and the chef-hat kitchen tab. Everything runs over the existing
// kitchen APIs; quick-adds land in the order draft with source:'tablet' and go
// through mapping memory later on desktop/mobile. NO cart fill, account or
// settings surface here — kiosk authority stays quick-add / cooked! / timers.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Icon, Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { MealPlan, MealPlanDay, OrderLine, RecipeSlim, StaplesItem } from '../../lib/types';
import { CUISINE_LABEL, RecipePhoto, clientIngredientKey } from '../kitchen/shared';

/* ---- Date helpers ------------------------------------------------------------- */

export function localDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function currentWeekStart(): string {
  const x = new Date();
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return localDateStr(x);
}

/* ---- Shared data hook ------------------------------------------------------------ */

export interface TonightData {
  recipes: RecipeSlim[];
  plan: MealPlan | null;
  today: string;
  day: MealPlanDay | null;
  recipe: RecipeSlim | null;
  servingsSplit: string | null;
  refetchPlan: () => void;
  refetchRecipes: () => void;
  setTonight: (recipeId: string) => Promise<void>;
}

/** Plan + recipes + household for the kiosk "Tonight" surfaces (one week, today). */
export function useTonight(): TonightData {
  const { data: recipesResp, refetch: refetchRecipes } = usePolling(api.kitchen.recipesAll, 60_000);
  const { data: householdResp } = usePolling(api.kitchen.household, 0);
  const [plan, setPlan] = useState<MealPlan | null>(null);
  const week = currentWeekStart();
  const load = () => {
    api.kitchen
      .plan(week)
      .then((r) => setPlan(r.plan))
      .catch(() => undefined);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [week]);

  const today = localDateStr(new Date());
  const recipes = recipesResp?.recipes ?? [];
  const household = householdResp?.household ?? null;
  const day = plan?.days.find((d) => d.date === today) ?? null;
  const recipe = (day?.recipeId && recipes.find((r) => r.id === day.recipeId)) || null;
  const servingsSplit =
    day && household && day.servings === household.adults + household.kids && household.kids > 0
      ? `${household.adults}+${household.kids}`
      : day
        ? String(day.servings)
        : null;

  const setTonight = async (recipeId: string) => {
    await api.kitchen.setPlanDay(week, { date: today, recipeId });
    load();
  };

  return { recipes, plan, today, day, recipe, servingsSplit, refetchPlan: load, refetchRecipes, setTonight };
}

/* ---- Tonight card (mockup frame 5, left column) ------------------------------------ */

export function TonightCard({ t }: { t: TonightData }) {
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const now = new Date();
  const eyebrow = `Tonight · ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}`;

  const frame: CSSProperties = {
    background: 'var(--surface-1)',
    border: '1px solid var(--border-1)',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  };

  const picker = pickerOpen && (
    <RecipePicker
      recipes={t.recipes}
      onClose={() => setPickerOpen(false)}
      onPick={async (r) => {
        await t.setTonight(r.id).catch(() => undefined);
        setPickerOpen(false);
      }}
    />
  );

  if (!t.plan) {
    return (
      <div style={{ ...frame, minHeight: 220, alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: 13 }}>
        Loading tonight…
      </div>
    );
  }

  // Empty states: skipped (eating out) / nothing planned (docs/42 acceptance #3).
  if (!t.recipe) {
    return (
      <div style={{ ...frame, minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 20, textAlign: 'center' }}>
        <Icon name={t.day?.skip ? 'utensils-crossed' : 'chef-hat'} size={30} color="var(--text-3)" />
        <div style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--grid)' }}>{eyebrow}</div>
        <div style={{ fontSize: 19, fontWeight: 700 }}>{t.day?.skip ? 'Eating out tonight' : 'Nothing planned tonight'}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {t.day?.skip ? 'Enjoy — no ingredients were ordered for tonight.' : 'Pick something from the library and it becomes tonight’s dinner.'}
        </div>
        <Button variant="secondary" size="lg" iconLeft={<Icon name="chef-hat" size={16} />} onClick={() => setPickerOpen(true)}>
          {t.day?.skip ? 'Cook something anyway' : 'Pick dinner'}
        </Button>
        {picker}
      </div>
    );
  }

  const r = t.recipe;
  return (
    <div style={frame}>
      <RecipePhoto recipe={r} height={190} radius="0" />
      <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: 11, flex: 1 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--grid)' }}>{eyebrow}</div>
        <h3 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em' }}>{r.title}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Badge tone="neutral">
            <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{r.prepMin + r.cookMin} min</b>
          </Badge>
          <Badge tone="home">{CUISINE_LABEL[r.cuisine]}</Badge>
          {r.nutrition && (
            <Badge tone="neutral">
              <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{r.nutrition.kcal}</b>&nbsp;kcal
            </Badge>
          )}
          {t.servingsSplit && (
            <Badge tone="neutral">
              <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{t.servingsSplit}</b>&nbsp;servings
            </Badge>
          )}
          {(r.kidScore ?? 0) >= 0.85 && <Badge tone="grid">Kids ❤</Badge>}
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 'auto' }}>
          <Button
            variant="primary"
            size="lg"
            style={{ flex: 1.6, minHeight: 54 }}
            iconLeft={<Icon name="play" size={17} />}
            onClick={() => navigate(`/cook/${r.id}?date=${t.today}`)}
          >
            Start cooking
          </Button>
          <Button variant="secondary" size="lg" style={{ flex: 1, minHeight: 54 }} iconLeft={<Icon name="refresh-cw" size={16} />} onClick={() => setPickerOpen(true)}>
            Something else
          </Button>
        </div>
      </div>
      {picker}
    </div>
  );
}

/* ---- Kiosk-friendly library picker ("Cook something else") -------------------------- */

function RecipePicker({ recipes, onClose, onPick }: { recipes: RecipeSlim[]; onClose: () => void; onPick: (r: RecipeSlim) => void }) {
  const [q, setQ] = useState('');
  const list = recipes.filter((r) => !q.trim() || r.title.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal open onClose={onClose} title="Cook something else" subtitle="Tap a recipe — it becomes tonight’s dinner" icon="chef-hat" size="lg" wideViewport>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the library…"
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border-1)',
            borderRadius: 'var(--radius-md)',
            padding: '11px 14px',
            fontSize: 14,
            color: 'var(--text-1)',
            outline: 'none',
            minHeight: 46,
          }}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, maxHeight: 420, overflowY: 'auto' }}>
          {list.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onPick(r)}
              style={{
                padding: 0,
                overflow: 'hidden',
                border: '1px solid var(--border-1)',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--surface-1)',
                color: 'var(--text-1)',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <RecipePhoto recipe={r} height={64} />
              <span style={{ display: 'block', padding: '8px 10px 10px' }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, lineHeight: 1.25, minHeight: 31, overflow: 'hidden' }}>{r.title}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{r.prepMin + r.cookMin} min</span>
              </span>
            </button>
          ))}
          {list.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No recipes match.</span>}
        </div>
      </div>
    </Modal>
  );
}

/* ---- "We're out of…" quick-add (staple tiles + free text → draft, source 'tablet') ---- */

const STAPLE_EMOJI: Array<[RegExp, string]> = [
  [/milk|leche/i, '🥛'],
  [/bread|pan\b/i, '🍞'],
  [/egg|huevo/i, '🥚'],
  [/banana|plátano|platano/i, '🍌'],
  [/paper|papel/i, '🧻'],
  [/water|agua/i, '💧'],
  [/coffee|café|cafe/i, '☕'],
  [/butter|mantequilla/i, '🧈'],
  [/cheese|queso/i, '🧀'],
  [/yog|yogur/i, '🥣'],
  [/rice|arroz/i, '🍚'],
  [/oil|aceite/i, '🫒'],
  [/tomato|tomate/i, '🍅'],
  [/apple|manzana/i, '🍎'],
];

function emojiFor(name: string): string {
  for (const [re, e] of STAPLE_EMOJI) if (re.test(name)) return e;
  return '🛒';
}

export function QuickAddGrid() {
  const { data: staplesResp } = usePolling(api.kitchen.staples, 0);
  const { data: draftResp, refetch: refetchDraft } = usePolling(api.kitchen.orderDraft, 30_000);
  const { data: historyResp } = usePolling(api.kitchen.orderHistory, 0);
  const [typeOpen, setTypeOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const draft = draftResp?.draft ?? null;

  // Top staples by order frequency (history hits), configured order as the tie-break.
  const topStaples = useMemo(() => {
    const staples = staplesResp?.staples ?? [];
    const history = historyResp?.history ?? [];
    const freq = new Map<string, number>();
    for (const h of history) for (const l of h.lines) freq.set(l.ingredientKey, (freq.get(l.ingredientKey) ?? 0) + 1);
    return staples
      .map((s, i) => ({ s, n: freq.get(`staple:${s.id}`) ?? 0, i }))
      .sort((a, b) => b.n - a.n || a.i - b.i)
      .slice(0, 5)
      .map((x) => x.s);
  }, [staplesResp, historyResp]);

  const keyFor = (name: string, staple?: StaplesItem) => (staple ? `staple:${staple.id}` : clientIngredientKey(name));
  const inDraft = (name: string, staple?: StaplesItem) =>
    Boolean(draft?.lines.some((l) => l.ingredientKey === keyFor(name, staple) && l.checked));

  const quickAdd = async (name: string, staple?: StaplesItem) => {
    if (!draft || busy) return;
    const key = keyFor(name, staple);
    setBusy(key);
    try {
      const lines: OrderLine[] = draft.lines.some((l) => l.ingredientKey === key)
        ? draft.lines.map((l) => (l.ingredientKey === key ? { ...l, checked: true } : l))
        : [
            ...draft.lines,
            {
              id: '', // server assigns
              source: 'tablet',
              productId: staple?.productId ?? null,
              ingredientKey: key,
              label: name,
              qty: staple?.defaultQty ?? 1,
              unit: 'count',
              checked: true,
              ...(staple?.priceEur != null ? { priceEur: Math.round(staple.priceEur * (staple.defaultQty || 1) * 100) / 100 } : {}),
            },
          ];
      await api.kitchen.setOrderDraft({ lines });
      await refetchDraft();
      setFlash(key);
      window.setTimeout(() => setFlash((f) => (f === key ? null : f)), 1600);
    } catch {
      /* tile stays un-added — tap again */
    } finally {
      setBusy(null);
    }
  };

  const tile = (label: string, icon: React.ReactNode, added: boolean, onClick: () => void, key: string) => (
    <button
      key={key}
      type="button"
      disabled={busy === key}
      onClick={onClick}
      style={{
        background: added ? 'var(--solar-wash)' : 'var(--surface-1)',
        border: `1px solid ${added ? 'rgba(46,230,160,.4)' : 'var(--border-1)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: '11px 8px 9px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        minHeight: 66,
        fontSize: 11.5,
        fontWeight: 500,
        color: added ? 'var(--solar)' : 'var(--text-2)',
        cursor: 'pointer',
        opacity: busy === key ? 0.6 : 1,
        textAlign: 'center',
      }}
    >
      <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
      {label}
      {added ? ' ✓' : ''}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <span style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-3)', fontWeight: 700 }}>
        We’re out of… <span style={{ letterSpacing: 0, textTransform: 'none', fontWeight: 400 }}>→ next order</span>
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 9 }}>
        {topStaples.map((s) => tile(s.name, emojiFor(s.name), inDraft(s.name, s) || flash === `staple:${s.id}`, () => void quickAdd(s.name, s), `staple:${s.id}`))}
        {tile('Type it…', <Icon name="pencil" size={19} />, false, () => setTypeOpen(true), 'type-it')}
      </div>
      {typeOpen && (
        <Modal open onClose={() => setTypeOpen(false)} title="We're out of…" subtitle="Free text — it lands in the next order draft" icon="pencil" wideViewport>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text.trim()) {
                  void quickAdd(text.trim());
                  setText('');
                  setTypeOpen(false);
                }
              }}
              placeholder="e.g. dishwasher tablets"
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border-1)',
                borderRadius: 'var(--radius-md)',
                padding: '13px 15px',
                fontSize: 15,
                color: 'var(--text-1)',
                outline: 'none',
                minHeight: 50,
              }}
            />
            <Button
              variant="primary"
              size="lg"
              disabled={!text.trim()}
              onClick={() => {
                void quickAdd(text.trim());
                setText('');
                setTypeOpen(false);
              }}
            >
              Add to the order
            </Button>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Unmatched items get their product picked later on desktop/mobile (mapping memory).
            </span>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---- Week strip (7 mini-days) --------------------------------------------------------- */

export function WeekStrip({ t }: { t: TonightData }) {
  const byId = useMemo(() => new Map(t.recipes.map((r) => [r.id, r])), [t.recipes]);
  if (!t.plan) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <span style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-3)', fontWeight: 700 }}>This week</span>
      <div style={{ display: 'flex', gap: 7 }}>
        {t.plan.days.map((d) => {
          const r = d.recipeId ? byId.get(d.recipeId) : null;
          const today = d.date === t.today;
          return (
            <div
              key={d.date}
              title={r?.title ?? (d.skip ? 'Eating out' : 'Nothing planned')}
              style={{
                flex: 1,
                background: 'var(--surface-1)',
                border: `1px solid ${today ? 'var(--grid)' : 'var(--border-1)'}`,
                borderRadius: 'var(--radius-md)',
                padding: '7px 4px',
                textAlign: 'center',
                boxShadow: today ? '0 0 10px rgba(245,165,36,.25)' : 'none',
              }}
            >
              <b style={{ display: 'block', fontSize: 9.5, letterSpacing: '0.08em', color: today ? 'var(--grid)' : 'var(--text-3)', textTransform: 'uppercase', marginBottom: 4 }}>
                {new Date(`${d.date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short' })}
              </b>
              {r ? (
                <RecipePhoto recipe={r} height={26} radius="6px" style={{ width: 26, margin: '0 auto' }} />
              ) : (
                <span style={{ fontSize: 13, color: 'var(--text-3)', lineHeight: '26px' }}>{d.skip ? '✕' : '—'}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Order status card (reuses the P2 syncOrderStatus data) ---------------------------- */

export function OrderStatusCard() {
  const { data: draftResp, refetch: refetchDraft } = usePolling(api.kitchen.orderDraft, 60_000);
  const { data: historyResp, refetch: refetchHistory } = usePolling(api.kitchen.orderHistory, 60_000);

  // One P2 reconcile pass when the kiosk surface mounts (cheap no-op unless 'filled').
  useEffect(() => {
    api.kitchen
      .syncOrderStatus()
      .then(() => {
        void refetchDraft();
        void refetchHistory();
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draft = draftResp?.draft ?? null;
  if (!draft) return null;

  const placed = historyResp?.history.find((h) => h.source === 'mercadona') ?? null;
  const filled = draft.status === 'filled' || draft.status === 'submitted';
  const submitted = draft.status === 'submitted';
  const items = draft.lines.filter((l) => l.checked).length;

  // Delivery countdown from the placed order's real slot (P2 read), else the target.
  const slotStart = submitted && placed?.slot?.start ? new Date(placed.slot.start) : null;
  const hoursTo = slotStart ? Math.round((slotStart.getTime() - Date.now()) / 3_600_000) : null;
  const slotLabel = slotStart
    ? `${slotStart.toLocaleDateString('en-GB', { weekday: 'short' })} ${slotStart.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}${
        placed?.slot?.end ? `–${new Date(placed.slot.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''
      }`
    : draft.targetSlot
      ? `${draft.targetSlot.window}`
      : null;

  const step = (label: string, state: 'done' | 'next') => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: state === 'done' ? 'var(--solar)' : 'var(--text-3)', whiteSpace: 'nowrap' }}>
      <i
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: state === 'done' ? 'var(--solar)' : 'var(--surface-4, var(--surface-3))',
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  );
  const line = (dim: boolean) => <span style={{ flex: 1, height: 1.5, background: dim ? 'var(--surface-3)' : 'var(--solar-dim, var(--solar))', margin: '0 8px', minWidth: 12 }} />;

  return (
    <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="truck" size={16} color="var(--solar)" />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Groceries order</span>
        <span style={{ marginLeft: 'auto' }}>
          {hoursTo != null && hoursTo > 0 ? (
            <Badge tone="solar">delivery in {hoursTo} h</Badge>
          ) : submitted ? (
            <Badge tone="solar">order placed</Badge>
          ) : filled ? (
            <Badge tone="battery">in the cart</Badge>
          ) : (
            <Badge tone="neutral">draft</Badge>
          )}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {step('Cart filled', filled ? 'done' : 'next')}
        {line(!filled)}
        {step(submitted ? 'Submitted' : 'Checkout (human)', submitted ? 'done' : 'next')}
        {line(!submitted)}
        {step(slotLabel ? `Delivery ${slotLabel}` : 'Delivery', 'next')}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)' }}>
        {items} items · {draft.totalEur.toFixed(2).replace('.', ',')} € · Mercadona
      </div>
    </div>
  );
}
