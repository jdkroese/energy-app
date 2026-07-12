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

/** Clamp a 1–10 scale defensively — callers may hand in an un-hydrated household in tests. */
function clampScale(v: number | undefined): number {
  return Math.max(1, Math.min(10, v ?? 5));
}

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
  /**
   * Weekly fish/veggie mix (docs/46 §1b) — running counts + targets for THIS week.
   * Optional so hand-built contexts (existing tests, ratingAvg's example) still compile;
   * when omitted the weekly-mix bias in scoreRecipe is simply skipped.
   */
  fishCount?: number;
  vegCount?: number;
  fishTarget?: number;
  vegTarget?: number;
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

function ingredientNames(r: Pick<Recipe, 'title' | 'ingredients'>): string[] {
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

/**
 * The exhaustive keyword list a household forbids: every allergy term verbatim plus each
 * diet restriction expanded via DIET_RESTRICTION_KEYWORDS (free-text restrictions match
 * verbatim). Used both to compose the "never use" instruction for the recipe generator
 * and as the belt-and-braces post-generation hard filter (D8, docs/43).
 */
export function forbiddenKeywords(h: Pick<Household, 'allergies' | 'dietRestrictions'>): string[] {
  const out: string[] = [...(h.allergies ?? [])];
  for (const restriction of h.dietRestrictions ?? []) {
    out.push(...(DIET_RESTRICTION_KEYWORDS[restriction] ?? [restriction]));
  }
  return out;
}

/** True when a recipe uses any allergy / diet-restriction ingredient (a HARD reject). */
export function recipeHasForbidden(r: Pick<Recipe, 'title' | 'ingredients'>, h: Pick<Household, 'allergies' | 'dietRestrictions'>): boolean {
  const forbidden = forbiddenKeywords(h);
  if (!forbidden.length) return false;
  const names = r.ingredients.flatMap((i) => [i.name, i.es]).concat(r.title);
  return textMatchesAny(names, forbidden);
}

/** Expose the token matcher for reuse (allergen/diet post-filters). */
export { textMatchesAny };

// ---- Recipe classification (docs/46 §1b) — fish / veggie / produce-richness -------------
// Keyword-based, same idiom as the diet-restriction lists above: substring matching over
// ES+EN ingredient names is knowingly imperfect but cheap, explainable and easy to extend.

const PRODUCE_KEYWORDS = [
  // Vegetables
  'tomate', 'tomato', 'pimiento', 'pepper', 'berenjena', 'eggplant', 'aubergine',
  'calabacín', 'calabacin', 'zucchini', 'courgette', 'cebolla', 'onion', 'ajo', 'garlic',
  'zanahoria', 'carrot', 'patata', 'potato', 'espinaca', 'spinach', 'lechuga', 'lettuce',
  'brócoli', 'brocoli', 'broccoli', 'coliflor', 'cauliflower', 'calabaza', 'pumpkin', 'squash',
  'puerro', 'leek', 'apio', 'celery', 'guisante', 'pea', 'judía verde', 'judia verde',
  'green bean', 'seta', 'champiñón', 'champinon', 'mushroom', 'col', 'cabbage', 'repollo',
  'acelga', 'chard', 'alcachofa', 'artichoke', 'pepino', 'cucumber', 'rábano', 'rabano',
  'radish', 'remolacha', 'beetroot', 'beet', 'espárrago', 'esparrago', 'asparagus',
  'haba', 'broad bean', 'boniato', 'sweet potato', 'maíz', 'maiz', 'corn',
  // Legumes
  'garbanzo', 'chickpea', 'lenteja', 'lentil', 'judía', 'judia', 'bean', 'alubia',
  // Fruit (savoury/seasonal produce — not just dessert)
  'melocotón', 'melocoton', 'peach', 'sandía', 'sandia', 'watermelon', 'higo', 'fig',
  'naranja', 'orange', 'mandarina', 'mandarin', 'limón', 'limon', 'lemon', 'fresa', 'strawberry',
  'manzana', 'apple', 'pera', 'pear', 'uva', 'grape', 'melón', 'melon', 'ciruela', 'plum',
  'granada', 'pomegranate', 'níspero', 'nispero', 'loquat', 'caqui', 'persimmon', 'membrillo',
  'quince', 'aguacate', 'avocado', 'plátano', 'platano', 'banana', 'cereza', 'cherry',
  'albaricoque', 'apricot', 'castaña', 'castana', 'chestnut',
];

/** True when the recipe names any fish/seafood ingredient (title or ingredients). */
export function isFishRecipe(r: Pick<Recipe, 'title' | 'ingredients'>): boolean {
  return textMatchesAny(ingredientNames(r), FISH_KEYWORDS);
}

/** True when the recipe has NO meat and NO fish/seafood ingredient. */
export function isVeggieRecipe(r: Pick<Recipe, 'title' | 'ingredients'>): boolean {
  const names = ingredientNames(r);
  return !textMatchesAny(names, MEAT_KEYWORDS) && !textMatchesAny(names, FISH_KEYWORDS);
}

/** 0..1 — share of a recipe's ingredients that are produce (vegetables/legumes/fruit). */
export function vegRichness(r: Pick<Recipe, 'ingredients'>): number {
  if (!r.ingredients.length) return 0;
  const matches = r.ingredients.filter((i) => textMatchesAny([i.name, i.es], PRODUCE_KEYWORDS)).length;
  return matches / r.ingredients.length;
}

// ---- Seasonal/local produce (docs/46 §1b) — Costa Blanca (Jávea) month → ES+EN names ----

const IN_SEASON_BY_MONTH: Record<number, string[]> = {
  1: ['alcachofa', 'artichoke', 'coliflor', 'cauliflower', 'brócoli', 'broccoli', 'espinaca', 'spinach', 'acelga', 'chard', 'puerro', 'leek', 'naranja', 'orange', 'mandarina', 'mandarin', 'apio', 'celery', 'col', 'cabbage'],
  2: ['alcachofa', 'artichoke', 'coliflor', 'cauliflower', 'brócoli', 'broccoli', 'espinaca', 'spinach', 'acelga', 'chard', 'puerro', 'leek', 'naranja', 'orange', 'mandarina', 'mandarin', 'apio', 'celery', 'guisante', 'pea'],
  3: ['alcachofa', 'artichoke', 'guisante', 'pea', 'haba', 'broad bean', 'espárrago', 'asparagus', 'espinaca', 'spinach', 'acelga', 'chard', 'fresa', 'strawberry', 'naranja', 'orange', 'rábano', 'radish', 'cebolleta', 'spring onion'],
  4: ['alcachofa', 'artichoke', 'guisante', 'pea', 'haba', 'broad bean', 'espárrago', 'asparagus', 'fresa', 'strawberry', 'níspero', 'loquat', 'rábano', 'radish', 'lechuga', 'lettuce', 'cebolleta', 'spring onion', 'zanahoria', 'carrot'],
  5: ['espárrago', 'asparagus', 'haba', 'broad bean', 'guisante', 'pea', 'fresa', 'strawberry', 'níspero', 'loquat', 'cereza', 'cherry', 'albaricoque', 'apricot', 'lechuga', 'lettuce', 'tomate', 'tomato', 'pepino', 'cucumber'],
  6: ['cereza', 'cherry', 'albaricoque', 'apricot', 'melocotón', 'peach', 'ciruela', 'plum', 'sandía', 'watermelon', 'melón', 'melon', 'tomate', 'tomato', 'pepino', 'cucumber', 'calabacín', 'zucchini', 'judía verde', 'green bean'],
  7: ['tomate', 'tomato', 'pimiento', 'pepper', 'berenjena', 'eggplant', 'calabacín', 'zucchini', 'melocotón', 'peach', 'sandía', 'watermelon', 'higo', 'fig', 'melón', 'melon', 'judía verde', 'green bean', 'maíz', 'corn'],
  8: ['tomate', 'tomato', 'pimiento', 'pepper', 'berenjena', 'eggplant', 'calabacín', 'zucchini', 'melocotón', 'peach', 'sandía', 'watermelon', 'higo', 'fig', 'melón', 'melon', 'uva', 'grape', 'maíz', 'corn'],
  9: ['tomate', 'tomato', 'pimiento', 'pepper', 'berenjena', 'eggplant', 'uva', 'grape', 'higo', 'fig', 'granada', 'pomegranate', 'membrillo', 'quince', 'calabaza', 'pumpkin', 'seta', 'mushroom', 'caqui', 'persimmon'],
  10: ['granada', 'pomegranate', 'membrillo', 'quince', 'calabaza', 'pumpkin', 'seta', 'mushroom', 'caqui', 'persimmon', 'boniato', 'sweet potato', 'uva', 'grape', 'coliflor', 'cauliflower', 'brócoli', 'broccoli', 'castaña', 'chestnut'],
  11: ['calabaza', 'pumpkin', 'boniato', 'sweet potato', 'seta', 'mushroom', 'coliflor', 'cauliflower', 'brócoli', 'broccoli', 'castaña', 'chestnut', 'naranja', 'orange', 'mandarina', 'mandarin', 'espinaca', 'spinach', 'col', 'cabbage'],
  12: ['naranja', 'orange', 'mandarina', 'mandarin', 'col', 'cabbage', 'coliflor', 'cauliflower', 'brócoli', 'broccoli', 'espinaca', 'spinach', 'acelga', 'chard', 'alcachofa', 'artichoke', 'puerro', 'leek', 'granada', 'pomegranate'],
};

/** How many of the household's location's in-season terms (for the given date's month) this recipe's ingredients name. */
function seasonalMatchCount(r: Pick<Recipe, 'ingredients'>, dateStr: string): number {
  const month = Number(dateStr.slice(5, 7));
  const inSeason = IN_SEASON_BY_MONTH[month] ?? [];
  if (!inSeason.length) return 0;
  const names = r.ingredients.flatMap((i) => [i.name, i.es]);
  let matched = 0;
  for (const term of inSeason) {
    if (textMatchesAny(names, [term])) matched++;
  }
  return matched;
}

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** +8 per distinct boosted ingredient present (name/es, substring, diacritic/case-insensitive), cap +20. */
function boostBonus(r: Pick<Recipe, 'ingredients'>, boosts: string[]): number {
  if (!boosts?.length) return 0;
  const names = r.ingredients.flatMap((i) => [i.name, i.es]).map((n) => stripDiacritics(n.toLowerCase()));
  let matched = 0;
  for (const b of boosts) {
    const needle = stripDiacritics(b.trim().toLowerCase());
    if (!needle) continue;
    if (names.some((n) => n.includes(needle))) matched++;
  }
  return Math.min(20, matched * 8);
}

// ---- Per-recipe dietary-guardrail biases (docs/46 §1b) ----------------------------------
// Each contributes roughly ±10 max (fish/veg component capped at ±8) so no single scale
// dominates cuisine/rotation/etc; 5 = neutral (zero contribution). Kept as small pure
// functions so scoreRecipe stays readable and each bias is independently reasoned about.

/** 1→~450 kcal … 5→~650 … 10→~900 (linear, 50 kcal/step). Penalty-only, capped at −10. */
function caloriesBias(nutrition: Recipe['nutrition'], scale: number): number {
  if (!nutrition) return 0;
  const target = 450 + (clampScale(scale) - 1) * 50;
  const diff = Math.abs(nutrition.kcal - target);
  return -Math.min(10, diff / 40);
}

/** scale<5: penalize carbsG>60/serving (harder as the scale drops toward 1). scale>5: mild
 *  boost scaling with both the scale and the actual carbsG. Neutral at 5. Cap ±8. */
function carbsBias(nutrition: Recipe['nutrition'], scale: number): number {
  if (!nutrition) return 0;
  const s = clampScale(scale);
  if (s === 5) return 0;
  if (s < 5) {
    const over = nutrition.carbsG - 60;
    if (over <= 0) return 0;
    const strength = (5 - s) / 4; // 1 at scale 1 → 0 at scale 5
    return -Math.min(8, over * 0.2 * strength);
  }
  const strength = (s - 5) / 5; // 0 at scale 5 → 1 at scale 10
  return Math.min(8, (nutrition.carbsG / 10) * strength);
}

/** scale>5 boosts proteinG≥30 (scaling with both distance-from-5 and the actual protein);
 *  scale<=5 is neutral — protein indifference never penalizes a recipe. Cap ±10. */
function proteinBias(nutrition: Recipe['nutrition'], scale: number): number {
  if (!nutrition) return 0;
  const s = clampScale(scale);
  if (s <= 5 || nutrition.proteinG < 30) return 0;
  const strength = (s - 5) / 5;
  return Math.min(10, (nutrition.proteinG - 30) * 0.3 * strength);
}

/** Fish recipes only: scale 1 ("avoid fish") penalizes, scale 10 ("fish-forward") boosts,
 *  scaling with distance from the neutral midpoint 5. Cap ±8 — the weekly mix (suggestWeek)
 *  does the heavier lifting on how OFTEN fish shows up across the week. */
function fishBias(r: Recipe, scale: number): number {
  if (!isFishRecipe(r)) return 0;
  const dist = (clampScale(scale) - 5) / 5; // -0.8 at scale 1 … +1 at scale 10
  return Math.max(-8, Math.min(8, dist * 8));
}

/** Continuous over vegRichness (0..1, share of produce ingredients): a veg-forward scale
 *  boosts produce-rich recipes and penalizes meat-forward ones, and vice versa for a
 *  meat-forward scale. Cap ±8. */
function vegBias(r: Recipe, scale: number): number {
  const dist = (clampScale(scale) - 5) / 5; // -0.8 at scale 1 … +1 at scale 10
  const richness = vegRichness(r); // 0..1
  return Math.max(-8, Math.min(8, dist * (richness - 0.5) * 16));
}

/** Weekly fish/veggie dinner targets derived from the 1–10 scale (docs/46 §1b bands:
 *  1–2→0 · 3–4→1 · 5–6→1–2 · 7–8→2–3 · 9–10→3–4). Fractional thresholds sit at each band's
 *  upper edge so "boost while under target, penalize once met" (suggestWeek) fills UP TO
 *  (not past) the stated range. */
export function weeklyMixTarget(scale: number): number {
  const s = clampScale(scale);
  if (s <= 2) return 0;
  if (s <= 4) return 1;
  if (s <= 6) return 1.5;
  if (s <= 8) return 2.5;
  return 3.5;
}

/** Fish/veggie dinners already assigned in a plan (any day with a recipe, pinned or not —
 *  docs/46: "track counts incl. pinned days"). */
export function weeklyMixCounts(plan: MealPlan, recipes: Recipe[]): { fish: number; veg: number } {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  let fish = 0;
  let veg = 0;
  for (const d of plan.days) {
    if (!d.recipeId) continue;
    const r = byId.get(d.recipeId);
    if (!r) continue;
    if (isFishRecipe(r)) fish++;
    if (isVeggieRecipe(r)) veg++;
  }
  return { fish, veg };
}

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

  // Season tags: in-season boost, out-of-season penalty; untagged is neutral. seasonalLocal
  // strengthens the match bonus (docs/46 §1b) — the household actively wants this signal.
  if (r.season && r.season.length) {
    score += r.season.includes(seasonOf(ctx.date)) ? (h.seasonalLocal ? 12 : 8) : -12;
  }

  // Kids: a light thumb on the scale for reliable dinners.
  if (h.kids > 0 && r.kidScore != null) score += r.kidScore * 8;

  // Variety: avoid the same cuisine two days running.
  if (ctx.prevCuisine && r.cuisine === ctx.prevCuisine) score -= 18;

  // Cooked feedback (P3): 👍/😐/👎 after cooking nudges the score a LITTLE —
  // ±6 points ≈ ±10% of the usual score band; taste steers, never dictates.
  score += ratingAvg(r) * 6;

  // ---- Dietary guardrails (docs/46 §1b) — nutrition scales · seasonal/local · boost -----
  if (h.nutritionScales) {
    score += caloriesBias(r.nutrition, h.nutritionScales.calories);
    score += carbsBias(r.nutrition, h.nutritionScales.carbs);
    score += proteinBias(r.nutrition, h.nutritionScales.protein);
    score += fishBias(r, h.nutritionScales.fish);
    score += vegBias(r, h.nutritionScales.veg);
  }
  if (h.seasonalLocal) score += Math.min(12, seasonalMatchCount(r, ctx.date) * 2);
  score += boostBonus(r, h.boostIngredients ?? []);

  // Weekly fish/veggie mix (docs/46 §1b): boost the eligible category while the week is
  // under its target, penalize once met — suggestWeek tracks the running counts.
  if (ctx.fishTarget != null && isFishRecipe(r)) score += (ctx.fishCount ?? 0) < ctx.fishTarget ? 18 : -18;
  if (ctx.vegTarget != null && isVeggieRecipe(r)) score += (ctx.vegCount ?? 0) < ctx.vegTarget ? 18 : -18;

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
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const days = plan.days.map((d) => ({ ...d, ...(d.recentSwapIds ? { recentSwapIds: [...d.recentSwapIds] } : {}) }));
  const fullWeek = !onlyDate;
  const usedThisWeek = new Set<string>();
  // Full-week: the current unpinned assignment, softly avoided in the new deal.
  const priorPicks = new Set<string>();
  // Weekly fish/veggie mix (docs/46 §1b): seed the running counts from days that stay put
  // (pins, and — for a single-slot re-suggest — every OTHER day) so "single-day re-suggest
  // uses the week's current counts" and pins count toward the target.
  const fishTarget = weeklyMixTarget(household.nutritionScales.fish);
  const vegTarget = weeklyMixTarget(household.nutritionScales.veg);
  let fishCount = 0;
  let vegCount = 0;
  for (const d of days) {
    // Existing pins (and, when re-suggesting a single slot, every other filled day) count as used.
    if (d.recipeId && (d.pinned || (onlyDate && d.date !== onlyDate))) {
      usedThisWeek.add(d.recipeId);
      const kept = byId.get(d.recipeId);
      if (kept) {
        if (isFishRecipe(kept)) fishCount++;
        if (isVeggieRecipe(kept)) vegCount++;
      }
    }
    if (fullWeek) {
      if (d.recipeId && !d.pinned && !d.skip) priorPicks.add(d.recipeId);
      delete d.recentSwapIds; // a full re-deal resets every day's Swap rotation
    }
  }

  let prevCuisine: Cuisine | null = null;
  for (const d of days) {
    const keep = d.skip || (d.recipeId && d.pinned) || (onlyDate && d.date !== onlyDate);
    if (keep) {
      const kept = d.recipeId ? byId.get(d.recipeId) : null;
      prevCuisine = kept ? kept.cuisine : prevCuisine;
      continue;
    }
    const ctx: ScoreContext = {
      household,
      date: d.date,
      prevCuisine,
      usedThisWeek,
      now,
      fishCount,
      vegCount,
      fishTarget,
      vegTarget,
    };
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
      if (isFishRecipe(pick)) fishCount++;
      if (isVeggieRecipe(pick)) vegCount++;
    } else {
      d.recipeId = null;
    }
  }
  return { ...plan, days };
}

// ---- Per-day request/pick (docs/46 §1c) -----------------------------------------------

export interface PlanRequestCandidate {
  recipe: Recipe;
  /** Short human reason, e.g. "fish · in season · 24 min". */
  why: string;
}

/** Same >3-char word-overlap heuristic as /plan/ask's deterministic fallback (title/tags/
 *  cuisine/ingredient names), reused here for the per-day request's text path. */
function keywordHits(r: Recipe, words: string[]): number {
  if (!words.length) return 0;
  const hay = `${r.title} ${r.tags.join(' ')} ${r.cuisine} ${r.ingredients.map((i) => `${i.name} ${i.es}`).join(' ')}`.toLowerCase();
  return words.filter((w) => hay.includes(w)).length;
}

function planRequestWhy(r: Recipe, date: string, household: Household): string {
  const parts: string[] = [];
  if (isFishRecipe(r)) parts.push('fish');
  else if (isVeggieRecipe(r)) parts.push('veggie');
  if (household.seasonalLocal && seasonalMatchCount(r, date) > 0) parts.push('in season');
  else if ((r.kidScore ?? 0) >= 0.85) parts.push('kid favourite');
  parts.push(`${r.prepMin + r.cookMin} min`);
  return parts.slice(0, 3).join(' · ');
}

/**
 * Deterministic ranking for the per-day "Pick" request (docs/46 §1c): eligibility filter →
 * guardrail scoring (scoreRecipe, same weekly-mix-aware context as suggestWeek) → an
 * optional keyword bonus when `text` is given (reusing /plan/ask's keyword fallback idiom)
 * → excludes recipes already elsewhere in this week's plan + explicit `excludeIds`
 * (Refresh). Returns the FULL ranked pool — callers slice top-N (6 for the sheet, ~30 for
 * the optional AI re-rank prompt). Pure — no I/O, so the AI path in routes/kitchen.ts can
 * fail soft straight onto this order.
 */
export function rankPlanRequestCandidates(
  recipes: Recipe[],
  household: Household,
  plan: MealPlan,
  opts: { date: string; now: Date; text?: string; excludeIds?: string[] },
): PlanRequestCandidate[] {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  // Everything already in the week's plan is excluded — including the request day's own
  // current pick (re-offering what's already on the card is a no-op candidate).
  const usedThisWeek = new Set(plan.days.filter((d) => d.recipeId).map((d) => d.recipeId as string));
  const exclude = new Set(opts.excludeIds ?? []);
  const { fish: fishCount, veg: vegCount } = weeklyMixCounts(plan, recipes);
  const dayIdx = plan.days.findIndex((d) => d.date === opts.date);
  const prevDay = dayIdx > 0 ? plan.days[dayIdx - 1] : null;
  const prevCuisine = prevDay?.recipeId ? (byId.get(prevDay.recipeId)?.cuisine ?? null) : null;
  const ctx: ScoreContext = {
    household,
    date: opts.date,
    prevCuisine,
    usedThisWeek,
    now: opts.now,
    fishCount,
    vegCount,
    fishTarget: weeklyMixTarget(household.nutritionScales.fish),
    vegTarget: weeklyMixTarget(household.nutritionScales.veg),
  };
  const words = (opts.text ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return recipes
    .filter((r) => !exclude.has(r.id) && !usedThisWeek.has(r.id) && isEligible(r, ctx))
    .map((r) => ({ r, s: scoreRecipe(r, ctx) + keywordHits(r, words) * 25 }))
    .sort((a, b) => b.s - a.s || a.r.id.localeCompare(b.r.id))
    .map(({ r }) => ({ recipe: r, why: planRequestWhy(r, opts.date, household) }));
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
