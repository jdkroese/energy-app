// Kitchen Hub deterministic engine (docs/39): the week-suggestion scorer/filler and
// the pack-size consolidation math. Pure functions — no I/O — so both are unit-testable
// (see engine.test.ts) and the AI request box can fail soft onto them.

import type {
  Cuisine,
  Household,
  MealPlan,
  MealPlanDay,
  ProductMapEntry,
  Recipe,
  RecipeIngredient,
  Season,
} from './types';

// ---- Week helpers -------------------------------------------------------------

/** Monday (local) of the week containing `d`, as YYYY-MM-DD. */
export function weekStartOf(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Mon=0
  x.setDate(x.getDate() - dow);
  return localDateStr(x);
}

export function localDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const x = new Date(y, m - 1, d);
  x.setDate(x.getDate() + days);
  return localDateStr(x);
}

/** A fresh 7-day plan (Mon–Sun) for the given week start. */
export function emptyPlan(weekStart: string, defaultServings: number): MealPlan {
  const days: MealPlanDay[] = [];
  for (let i = 0; i < 7; i++) days.push({ date: addDays(weekStart, i), recipeId: null, servings: defaultServings });
  return { weekStart, days };
}

function seasonOf(dateStr: string): Season {
  const month = Number(dateStr.slice(5, 7));
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

// ---- Suggestion engine ----------------------------------------------------------

export interface ScoreContext {
  household: Household;
  /** The day being filled (drives weekday time budget + season). */
  date: string;
  /** Cuisine of the previous day's pick (variety rule: avoid 2 in a row). */
  prevCuisine?: Cuisine | null;
  /** Recipe ids already used this week (hard-avoid duplicates). */
  usedThisWeek: Set<string>;
  now: Date;
}

const ROTATION_DAYS = 21; // "not cooked within 3 weeks"

/** Mean of the cooked-feedback ratings (each −1 | 0 | +1); 0 when never rated. */
export function ratingAvg(r: Pick<Recipe, 'ratings'>): number {
  const vals = Object.values(r.ratings ?? {}).filter((v) => Number.isFinite(v));
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function textMatchesAny(haystack: string[], needles: string[]): boolean {
  const h = haystack.map((x) => x.toLowerCase());
  return needles.some((n) => {
    const needle = n.trim().toLowerCase();
    return needle.length > 0 && h.some((x) => x.includes(needle));
  });
}

function ingredientNames(r: Recipe): string[] {
  return r.ingredients.flatMap((i) => [i.name, i.es]).concat(r.title);
}

// ---- Diet restrictions (hard filter, like allergies) -----------------------------
// Preset slugs expand to ES+EN ingredient keyword lists; anything else in
// household.dietRestrictions is matched verbatim (free text behaves like an
// allergy term). Substring keyword matching is knowingly imperfect (e.g. "pan"
// also hits "panceta") — the lists are module-level constants so they're easy
// to extend when a false hit/miss shows up in practice.

const PORK_KEYWORDS = [
  'cerdo', 'pork', 'bacon', 'jamón', 'jamon', 'panceta', 'chorizo', 'lomo', 'salchicha',
  'sausage', 'ham', 'morcilla', 'lardo', 'tocino',
];
const BEEF_KEYWORDS = ['ternera', 'beef', 'buey', 'vacuno', 'steak', 'entrecot', 'rabo de toro'];
const MEAT_KEYWORDS = [
  ...PORK_KEYWORDS, ...BEEF_KEYWORDS,
  'carne', 'pollo', 'chicken', 'pavo', 'turkey', 'cordero', 'lamb', 'conejo', 'rabbit', 'pato', 'duck', 'codorniz',
];
const FISH_KEYWORDS = [
  'pescado', 'fish', 'salmón', 'salmon', 'atún', 'atun', 'tuna', 'merluza', 'bacalao', 'cod',
  'gamba', 'prawn', 'shrimp', 'langostino', 'marisco', 'seafood', 'anchoa', 'anchovy', 'boquerón', 'boqueron',
  'calamar', 'squid', 'sepia', 'pulpo', 'octopus', 'mejillón', 'mejillon', 'mussel', 'almeja', 'clam',
  'sardina', 'dorada', 'lubina', 'rape', 'trucha', 'trout',
];
const DAIRY_KEYWORDS = [
  'leche', 'milk', 'nata', 'cream', 'queso', 'cheese', 'mantequilla', 'butter', 'yogur', 'yogurt', 'yoghurt',
  'lácteo', 'lacteo', 'requesón', 'requeson', 'mascarpone', 'parmesano', 'parmesan', 'mozzarella',
];
const EGG_KEYWORDS = ['huevo', 'egg'];
const GLUTEN_KEYWORDS = [
  'harina', 'trigo', 'wheat', 'flour', 'pan', 'bread', 'pasta', 'espagueti', 'spaghetti', 'macarrones', 'macaroni',
  'fideo', 'noodle', 'cuscús', 'cuscus', 'couscous', 'cebada', 'barley', 'centeno', 'rye', 'hojaldre', 'empanada', 'rebozado',
];

/** Preset diet-restriction slug → ES+EN ingredient keywords it forbids. */
export const DIET_RESTRICTION_KEYWORDS: Record<string, string[]> = {
  vegetarian: [...MEAT_KEYWORDS, ...FISH_KEYWORDS],
  vegan: [...MEAT_KEYWORDS, ...FISH_KEYWORDS, ...DAIRY_KEYWORDS, ...EGG_KEYWORDS, 'miel', 'honey'],
  pescatarian: MEAT_KEYWORDS,
  'no-pork': PORK_KEYWORDS,
  'no-beef': BEEF_KEYWORDS,
  'gluten-free': GLUTEN_KEYWORDS,
  'lactose-free': DAIRY_KEYWORDS,
};

/** Hard filters: allergies + diet restrictions (never suggested) + same-recipe-twice-in-a-week. */
export function isEligible(r: Recipe, ctx: ScoreContext): boolean {
  if (ctx.usedThisWeek.has(r.id)) return false;
  const h = ctx.household;
  const names = ingredientNames(r);
  if (h.allergies.length && textMatchesAny(names, h.allergies)) return false;
  for (const restriction of h.dietRestrictions ?? []) {
    const keywords = DIET_RESTRICTION_KEYWORDS[restriction] ?? [restriction];
    if (textMatchesAny(names, keywords)) return false;
  }
  return true;
}

/**
 * Deterministic recipe score (higher = better) for one slot. Factors (docs/39):
 * rotation (3 weeks) · cuisine weight · weekday time budget (Mon–Thu) · goal fit ·
 * loves boost / dislikes penalty · season tags. Allergies are a hard filter (isEligible).
 */
export function scoreRecipe(r: Recipe, ctx: ScoreContext): number {
  const h = ctx.household;
  let score = 0;

  // Rotation: cooked within the last 3 weeks → strong penalty scaled by recency.
  if (r.lastCookedAt) {
    const days = (ctx.now.getTime() - new Date(r.lastCookedAt).getTime()) / 86_400_000;
    if (days < ROTATION_DAYS) score -= (ROTATION_DAYS - days) * 4;
    else score += Math.min(20, (days - ROTATION_DAYS) * 0.3); // gently resurface old favourites
  } else {
    score += 12; // never cooked → try it
  }

  // Cuisine preference weight (0..100 → 0..30).
  score += (h.cuisineWeights[r.cuisine] ?? 50) * 0.3;

  // Weekday time budget: Mon–Thu totals must fit; weekends are free.
  const dow = new Date(`${ctx.date}T12:00:00`).getDay();
  const isWeeknight = dow >= 1 && dow <= 4;
  const total = r.prepMin + r.cookMin;
  if (isWeeknight) {
    if (total > h.weeknightMaxMin) score -= (total - h.weeknightMaxMin) * 2;
    else score += 6;
  } else if (total > 35) {
    score += 4; // project cooking belongs on the weekend
  }

  // Goal fit: kcal per serving vs target when goals are set.
  if (h.goals.mode && h.goals.kcalPerDinner && r.nutrition) {
    if (r.nutrition.kcal <= h.goals.kcalPerDinner) score += 10;
    else score -= Math.min(25, (r.nutrition.kcal - h.goals.kcalPerDinner) * 0.08);
  }
  if (h.goals.mode === 'high-protein' && r.nutrition) score += Math.min(15, r.nutrition.proteinG * 0.3);

  // Loves / dislikes (soft).
  if (h.loves.length && textMatchesAny(ingredientNames(r), h.loves)) score += 14;
  if (h.dislikes.length && textMatchesAny(ingredientNames(r), h.dislikes)) score -= 30;

  // Season tags: in-season boost, out-of-season penalty; untagged is neutral.
  if (r.season && r.season.length) {
    score += r.season.includes(seasonOf(ctx.date)) ? 8 : -12;
  }

  // Kids: a light thumb on the scale for reliable dinners.
  if (h.kids > 0 && r.kidScore != null) score += r.kidScore * 8;

  // Variety: avoid the same cuisine two days running.
  if (ctx.prevCuisine && r.cuisine === ctx.prevCuisine) score -= 18;

  // Cooked feedback (P3): 👍/😐/👎 after cooking nudges the score a LITTLE —
  // ±6 points ≈ ±10% of the usual score band; taste steers, never dictates.
  score += ratingAvg(r) * 6;

  return score;
}

/** FIFO cap on a day's Swap rotation memory (recentSwapIds). */
const SWAP_MEMORY_CAP = 12;

/**
 * Fill a week's plan. Pins survive (day.pinned), skips stay skipped, and when
 * `onlyDate` is given only that slot is (re)suggested. Deterministic: stable
 * sort by score, ties broken by id.
 *
 * Swap rotation (onlyDate): the day's recentSwapIds (recipes already swapped
 * away) are excluded alongside the current pick, so repeated Swap cycles onward
 * through the candidates instead of ping-ponging A↔B; when the exclusions empty
 * the pool the memory clears and the cycle restarts — never a dead Swap button.
 *
 * Full-week regenerate: each unpinned day's current pick — and, softly, every
 * unpinned pick of the current week — is avoided so "Suggest week" visibly
 * re-deals; when the library is too small the avoidance degrades gracefully
 * (reuse allowed rather than leaving days empty). A full re-deal also clears
 * every day's swap memory. Pure: exclusions come in on the plan, the updated
 * plan goes out; persistence stays in routes/store.
 */
export function suggestWeek(
  plan: MealPlan,
  recipes: Recipe[],
  household: Household,
  now: Date,
  onlyDate?: string,
): MealPlan {
  const days = plan.days.map((d) => ({ ...d, ...(d.recentSwapIds ? { recentSwapIds: [...d.recentSwapIds] } : {}) }));
  const fullWeek = !onlyDate;
  const usedThisWeek = new Set<string>();
  // Full-week: the current unpinned assignment, softly avoided in the new deal.
  const priorPicks = new Set<string>();
  for (const d of days) {
    // Existing pins (and, when re-suggesting a single slot, every other filled day) count as used.
    if (d.recipeId && (d.pinned || (onlyDate && d.date !== onlyDate))) usedThisWeek.add(d.recipeId);
    if (fullWeek) {
      if (d.recipeId && !d.pinned && !d.skip) priorPicks.add(d.recipeId);
      delete d.recentSwapIds; // a full re-deal resets every day's Swap rotation
    }
  }

  let prevCuisine: Cuisine | null = null;
  for (const d of days) {
    const keep = d.skip || (d.recipeId && d.pinned) || (onlyDate && d.date !== onlyDate);
    if (keep) {
      const kept = d.recipeId ? recipes.find((r) => r.id === d.recipeId) : null;
      prevCuisine = kept ? kept.cuisine : prevCuisine;
      continue;
    }
    const ctx: ScoreContext = { household, date: d.date, prevCuisine, usedThisWeek, now };
    const replacedId = d.recipeId ?? null;
    const eligible = recipes.filter((r) => isEligible(r, ctx));
    const best = (pool: Recipe[]): Recipe | undefined =>
      pool
        .map((r) => ({ r, s: scoreRecipe(r, ctx) }))
        .sort((a, b) => b.s - a.s || a.r.id.localeCompare(b.r.id))[0]?.r;

    let pick: Recipe | undefined;
    if (!fullWeek) {
      // Single-slot Swap: exclude the current pick AND the rotation memory.
      let memory = d.recentSwapIds ?? [];
      let pool = eligible.filter((r) => r.id !== replacedId && !memory.includes(r.id));
      if (!pool.length) {
        // Exhausted the rotation — clear the memory and cycle from the top again.
        memory = [];
        pool = eligible.filter((r) => r.id !== replacedId);
      }
      if (!pool.length) pool = eligible; // single-recipe library: keep the button alive
      pick = best(pool);
      if (pick && replacedId) d.recentSwapIds = [...memory, replacedId].slice(-SWAP_MEMORY_CAP);
      else if (!memory.length) delete d.recentSwapIds;
    } else {
      // Full-week re-deal: prefer recipes outside the current assignment, then
      // merely not this day's own pick, then anything eligible (graceful degrade).
      const tiers = [
        eligible.filter((r) => !priorPicks.has(r.id)),
        eligible.filter((r) => r.id !== replacedId),
        eligible,
      ];
      pick = best(tiers.find((t) => t.length) ?? []);
    }

    if (pick) {
      d.recipeId = pick.id;
      usedThisWeek.add(pick.id);
      prevCuisine = pick.cuisine;
    } else {
      d.recipeId = null;
    }
  }
  return { ...plan, days };
}

// ---- Unit normalization + pack-size math ---------------------------------------

export interface NormalizedQty {
  qty: number;
  /** Base unit after normalization: 'g' | 'ml' | 'count' | original free-form. */
  unit: string;
}

/** Normalize g/kg → g, ml/l → ml, count-ish units → count. Free-form units pass through. */
export function normalizeQty(qty: number, unit: string): NormalizedQty {
  const u = unit.trim().toLowerCase();
  if (u === 'kg') return { qty: qty * 1000, unit: 'g' };
  if (u === 'g') return { qty, unit: 'g' };
  if (u === 'l') return { qty: qty * 1000, unit: 'ml' };
  if (u === 'ml') return { qty, unit: 'ml' };
  if (u === 'count' || u === 'unit' || u === 'units' || u === 'ud' || u === 'uds' || u === 'piece' || u === 'pieces')
    return { qty, unit: 'count' };
  return { qty, unit: u };
}

/** Human display for a normalized amount ("900 g", "1.5 l", "3"). */
export function formatQty(qty: number, unit: string): string {
  if (unit === 'g') return qty >= 1000 ? `${trimNum(qty / 1000)} kg` : `${trimNum(qty)} g`;
  if (unit === 'ml') return qty >= 1000 ? `${trimNum(qty / 1000)} L` : `${trimNum(qty)} ml`;
  if (unit === 'count') return `${trimNum(qty)}`;
  return `${trimNum(qty)} ${unit}`;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** Normalized key used for dedup + the ProductMap ("mapping memory"). */
export function ingredientKey(ing: Pick<RecipeIngredient, 'es'>): string {
  return ing.es
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export interface PackMathResult {
  packsNeeded: number;
  coverageNote: string;
}

/**
 * Pack-size consolidation (docs/39): total needed vs the mapped product's pack size →
 * packs needed + a human note ("900 g across 3 recipes → 1× 1 kg ✓").
 * Returns null when units are incomparable or the pack size is unknown.
 */
export function packMath(
  totalQty: number,
  totalUnit: string,
  recipeCount: number,
  pack: ProductMapEntry['packSize'],
): PackMathResult | null {
  if (!pack || !Number.isFinite(pack.qty) || pack.qty <= 0) return null;
  const need = normalizeQty(totalQty, totalUnit);
  const packN = normalizeQty(pack.qty, pack.unit);
  if (need.unit !== packN.unit) return null;
  const packs = Math.max(1, Math.ceil(need.qty / packN.qty));
  const across = recipeCount > 1 ? ` across ${recipeCount} recipes` : '';
  const covered = packs * packN.qty >= need.qty;
  const spare = packs * packN.qty - need.qty;
  const spareNote =
    covered && spare > 0 && need.unit !== 'count' ? ` (${formatQty(spare, need.unit)} spare)` : '';
  return {
    packsNeeded: packs,
    coverageNote: `${formatQty(need.qty, need.unit)}${across} → ${packs}× ${pack.display}${covered ? ' ✓' : ''}${spareNote}`,
  };
}
