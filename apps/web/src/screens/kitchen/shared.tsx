// Kitchen Hub shared UI (Cooking + Groceries, docs/38 + docs/39): recipe photos with a
// graceful fallback tile, the servings stepper, cuisine/meta chips, the recipe quick-view
// overlay (desktop modal / mobile bottom sheet), and small formatters. All visuals follow
// the approved mockup (docs/mockups/kitchen-hub-v4.html) built on the live Power tokens.

import { useState, type CSSProperties, type ReactNode } from 'react';
import { Badge, Button, Icon, Modal } from '../../components/ui';
import type { KitchenCuisine, OrderLine, Recipe } from '../../lib/types';

export const CUISINE_LABEL: Record<KitchenCuisine, string> = {
  spanish: 'Spanish',
  dutch: 'Dutch',
  japanese: 'Japanese',
  italian: 'Italian',
  global: 'Global',
};

export function fmtEur(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v.toFixed(2).replace('.', ',')} €`;
}

/** "900 g" / "1.5 kg" / "3" — mirrors the server's formatQty. */
export function fmtQty(qty: number, unit: string): string {
  const trim = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
  if (unit === 'g') return qty >= 1000 ? `${trim(qty / 1000)} kg` : `${trim(qty)} g`;
  if (unit === 'ml') return qty >= 1000 ? `${trim(qty / 1000)} L` : `${trim(qty)} ml`;
  if (unit === 'count') return trim(qty);
  if (unit === 'to taste') return 'to taste';
  return `${trim(qty)} ${unit}`;
}

/** "Week of 6 – 12 July" for a Monday YYYY-MM-DD. */
export function weekLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T12:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const month = (d: Date) => d.toLocaleDateString('en-GB', { month: 'long' });
  if (start.getMonth() === end.getMonth()) return `Week of ${start.getDate()} – ${end.getDate()} ${month(end)}`;
  return `Week of ${start.getDate()} ${month(start)} – ${end.getDate()} ${month(end)}`;
}

export function dayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.getDate()}`;
}

/** Client mirror of the server's normalized mapping-memory key. */
export function clientIngredientKey(es: string): string {
  return es
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// ---- Recipe photo (illustrated cuisine-tinted card when the image is missing) ----------
// AI-generated and photo-less recipes render a DESIGNED card (docs/43): a cuisine-tinted
// diagonal gradient + a soft utensil glyph + the dish's initials — so a recipe without a
// photo looks intentional, not like a broken image. Consistent at every size it's used
// (42/48/56/72/96/140/180). recipe.photo is honoured when present (a future image provider
// drops URLs straight in). Design-system tokens only.

const CUISINE_WASH: Record<KitchenCuisine, string> = {
  spanish: 'var(--solar-wash)',
  dutch: 'var(--grid-wash)',
  japanese: 'var(--battery-wash)',
  italian: 'var(--home-wash)',
  global: 'var(--surface-3)',
};

/** Per-cuisine accent token + a representative lucide glyph for the illustrated card. */
const CUISINE_ART: Record<KitchenCuisine, { accent: string; glyph: string }> = {
  spanish: { accent: 'var(--solar)', glyph: 'flame' },
  dutch: { accent: 'var(--grid)', glyph: 'wheat' },
  japanese: { accent: 'var(--battery)', glyph: 'fish' },
  italian: { accent: 'var(--home)', glyph: 'wheat' },
  global: { accent: 'var(--text-2)', glyph: 'utensils' },
};

/** Up to two initials from the dish title (first letters of the first two words). */
function recipeInitials(title: string): string {
  const words = title
    .trim()
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (!words.length) return '·';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function RecipePhoto({
  recipe,
  height = 96,
  radius = 'var(--radius-md) var(--radius-md) 0 0',
  style,
}: {
  recipe: Pick<Recipe, 'photo' | 'title' | 'cuisine'>;
  height?: number | string;
  radius?: string;
  style?: CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const base: CSSProperties = {
    height,
    borderRadius: radius,
    overflow: 'hidden',
    flex: 'none',
    background: CUISINE_WASH[recipe.cuisine] ?? 'var(--surface-3)',
    display: 'grid',
    placeItems: 'center',
    ...style,
  };
  if (!recipe.photo || failed) {
    const art = CUISINE_ART[recipe.cuisine] ?? CUISINE_ART.global;
    // Scale the glyph + initials to the tile so the same component reads well at 42px and
    // at 180px. Numeric heights get exact sizing; a non-numeric height (rare) falls back.
    const h = typeof height === 'number' ? height : 96;
    const small = h < 60;
    const glyphSize = Math.round(Math.max(16, Math.min(40, h * 0.34)));
    const initialsSize = Math.round(Math.max(11, Math.min(28, h * 0.24)));
    return (
      <div
        style={{
          ...base,
          position: 'relative',
          // Diagonal cuisine-tinted gradient over the surface — designed, not flat.
          backgroundImage: `linear-gradient(135deg, ${CUISINE_WASH[recipe.cuisine] ?? 'var(--surface-3)'} 0%, var(--surface-2) 78%)`,
        }}
        aria-hidden="true"
        title={recipe.title}
      >
        {/* Soft oversized glyph, offset to the corner as a watermark. */}
        <Icon
          name={art.glyph}
          size={Math.round(h * 0.72)}
          color={art.accent}
          style={{ position: 'absolute', right: small ? -6 : -8, bottom: small ? -8 : -10, opacity: 0.14 }}
        />
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: small ? 0 : 4 }}>
          {!small && <Icon name={art.glyph} size={glyphSize} color={art.accent} style={{ opacity: 0.9 }} />}
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: initialsSize,
              fontWeight: 700,
              letterSpacing: '0.04em',
              color: small ? art.accent : 'var(--text-2)',
              lineHeight: 1,
            }}
          >
            {recipeInitials(recipe.title)}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div style={base}>
      <img
        src={recipe.photo}
        alt={recipe.title}
        loading="lazy"
        onError={() => setFailed(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </div>
  );
}

// ---- Servings stepper ----------------------------------------------------------------

export function ServingsStepper({
  value,
  onChange,
  compact = false,
  min = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  compact?: boolean;
  /** Lower bound (default 1); pass 0 where zero is meaningful (e.g. kids count). */
  min?: number;
}) {
  const btn: CSSProperties = {
    width: compact ? 26 : 32,
    height: compact ? 26 : 32,
    minWidth: compact ? 26 : 32,
    borderRadius: 8,
    display: 'grid',
    placeItems: 'center',
    background: 'var(--surface-3)',
    border: '1px solid var(--border-2)',
    color: 'var(--text-2)',
    cursor: 'pointer',
    padding: 0,
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button type="button" aria-label="Fewer servings" style={btn} onClick={() => onChange(Math.max(min, value - 1))}>
        <Icon name="minus" size={13} />
      </button>
      <b style={{ fontFamily: 'var(--font-mono)', fontSize: compact ? 12 : 13, minWidth: 18, textAlign: 'center' }}>{value}</b>
      <button type="button" aria-label="More servings" style={btn} onClick={() => onChange(Math.min(24, value + 1))}>
        <Icon name="plus" size={13} />
      </button>
    </span>
  );
}

// ---- Meta chips (time / cuisine / kcal / kids) ------------------------------------------

export function MetaChips({ recipe, showNutrition }: { recipe: Recipe; showNutrition: boolean }) {
  const chip: CSSProperties = {
    fontSize: 11,
    padding: '2px 7px',
    borderRadius: 999,
    background: 'var(--surface-3)',
    color: 'var(--text-2)',
    whiteSpace: 'nowrap',
  };
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ ...chip, fontFamily: 'var(--font-mono)' }}>{recipe.prepMin + recipe.cookMin} min</span>
      <span style={chip}>{CUISINE_LABEL[recipe.cuisine]}</span>
      {showNutrition && recipe.nutrition && (
        <span style={{ ...chip, color: 'var(--solar)', background: 'var(--solar-wash)' }}>{recipe.nutrition.kcal} kcal</span>
      )}
      {(recipe.kidScore ?? 0) >= 0.85 && <span style={{ ...chip, color: 'var(--grid)', background: 'var(--grid-wash)' }}>Kids ❤</span>}
    </div>
  );
}

// ---- Recipe quick-view overlay (desktop modal / mobile bottom sheet) ---------------------

export function RecipeQuickView({
  recipe,
  desktop,
  planContext,
  servings,
  onServings,
  draftLines,
  showNutrition,
  goalKcal,
  onClose,
  onPlan,
  onSendToGroceries,
  extraActions,
  statusBadge,
  actionsLabel,
}: {
  recipe: Recipe;
  desktop: boolean;
  /** e.g. "Planned · Mon 6" when opened from a day card. */
  planContext?: string;
  /** Extra badge in the header row — e.g. "Not saved yet" for an AI candidate (docs/43). */
  statusBadge?: ReactNode;
  /** Optional heading above the action row (e.g. "Keep this recipe" for a candidate). */
  actionsLabel?: string;
  servings: number;
  onServings?: (v: number) => void;
  /** Current order-draft lines — used to show mapped product + price per ingredient. */
  draftLines?: OrderLine[];
  showNutrition: boolean;
  goalKcal?: number | null;
  onClose: () => void;
  onPlan?: () => void;
  onSendToGroceries?: () => void;
  extraActions?: ReactNode;
}) {
  const scale = servings / recipe.servingsBase;
  const fitsGoal = Boolean(goalKcal && recipe.nutrition && recipe.nutrition.kcal <= goalKcal);
  const mapped = (es: string) => draftLines?.find((l) => l.ingredientKey === clientIngredientKey(es) && l.productId);

  const macro = (v: string, label: string) => (
    <div style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '9px 12px', textAlign: 'center', flex: 1 }}>
      <b style={{ fontFamily: 'var(--font-mono)', fontSize: 17 }}>{v}</b>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>{label}</div>
    </div>
  );

  return (
    <Modal open onClose={onClose} title={recipe.title} size="lg" placement={desktop ? 'center' : 'sheet'} wideViewport={desktop} icon="chef-hat">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '14px 18px 18px' }}>
        <RecipePhoto recipe={recipe} height={desktop ? 180 : 140} radius="var(--radius-md)" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {planContext && <Badge tone="grid">{planContext}</Badge>}
          {statusBadge}
          <Badge tone="neutral">
            <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{recipe.prepMin + recipe.cookMin} min</b>
          </Badge>
          <Badge tone="home">{CUISINE_LABEL[recipe.cuisine]}</Badge>
          {fitsGoal && (
            <Badge tone="solar">
              <Icon name="target" size={12} /> Fits goal
            </Badge>
          )}
          <div style={{ flex: 1 }} />
          {onServings && (
            <>
              <ServingsStepper value={servings} onChange={onServings} compact />
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>servings</span>
            </>
          )}
        </div>

        {showNutrition && recipe.nutrition && (
          <div style={{ display: 'flex', gap: 8 }}>
            {macro(String(recipe.nutrition.kcal), 'kcal / serving')}
            {macro(`${recipe.nutrition.proteinG} g`, 'protein')}
            {macro(`${recipe.nutrition.carbsG} g`, 'carbs')}
            {macro(`${recipe.nutrition.fatG} g`, 'fat')}
          </div>
        )}

        <div style={{ border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 13px', borderBottom: '1px solid var(--border-1)' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>Ingredients · {servings} servings</span>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{recipe.ingredients.length} items</span>
          </div>
          <div style={{ padding: '4px 13px 8px' }}>
            {recipe.ingredients.map((ing, i) => {
              const line = mapped(ing.es);
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '7px 0',
                    borderBottom: i < recipe.ingredients.length - 1 ? '1px solid var(--border-1)' : 'none',
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ color: ing.pantryStaple ? 'var(--text-3)' : 'var(--text-1)', minWidth: 0 }}>
                    {ing.name}
                    {ing.qty != null && <span style={{ color: 'var(--text-2)' }}> · {fmtQty(ing.qty * scale, ing.unit)}</span>}
                    {ing.pantryStaple && <small style={{ color: 'var(--text-3)' }}> · pantry</small>}
                    {line?.coverageNote && (
                      <small style={{ display: 'block', color: 'var(--text-3)' }}>→ {line.coverageNote}</small>
                    )}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)', flex: 'none' }}>
                    {line ? fmtEur(line.priceEur) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {recipe.tools.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
            <b style={{ color: 'var(--text-1)', fontWeight: 600 }}>Tools · </b>
            {recipe.tools.join(' · ')}
          </div>
        )}

        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Steps</div>
          {(['mise', 'cook'] as const).map((phase) => {
            const steps = recipe.steps.filter((s) => s.phase === phase);
            if (!steps.length) return null;
            return (
              <div key={phase} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: phase === 'mise' ? 'var(--battery)' : 'var(--solar)', marginBottom: 4 }}>
                  {phase === 'mise' ? 'Mise en place' : 'Cook'}
                </div>
                {steps.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, color: 'var(--text-2)', padding: '3px 0' }}>
                    <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', flex: 'none' }}>{i + 1}.</span>
                    <span>
                      {s.text}
                      {s.timerSec != null && (
                        <span style={{ color: 'var(--battery)', whiteSpace: 'nowrap' }}>
                          {' '}
                          <Icon name="timer" size={11} /> {Math.round(s.timerSec / 60)} min
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {actionsLabel && (
          <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: -4 }}>
            {actionsLabel}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {onPlan && (
            <Button variant="primary" style={{ flex: 1.2 }} iconLeft={<Icon name="calendar-plus" size={15} />} onClick={onPlan}>
              Plan it
            </Button>
          )}
          {onSendToGroceries && (
            <Button variant="secondary" style={{ flex: 1.4 }} iconLeft={<Icon name="shopping-basket" size={15} />} onClick={onSendToGroceries}>
              Ingredients → Groceries
            </Button>
          )}
          {extraActions}
        </div>
      </div>
    </Modal>
  );
}
