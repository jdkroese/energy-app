// Kitchen Hub data model (docs/38 §5, docs/39). Server-side source of truth —
// apps/web/src/lib/types.ts mirrors these shapes for the frontend.

export type Cuisine = 'spanish' | 'dutch' | 'japanese' | 'italian' | 'global';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export interface RecipeIngredient {
  /** Display name (English UI copy). */
  name: string;
  /** Canonical Spanish name — drives Mercadona SKU search (D3). */
  es: string;
  /** Quantity per servingsBase servings; null = "to taste". */
  qty: number | null;
  /** 'g' | 'kg' | 'ml' | 'l' | 'count' | free-form ('tbsp', 'bunch', …). */
  unit: string;
  /** Habitually in the pantry — pre-unchecked in the order draft. */
  pantryStaple?: boolean;
}

export interface RecipeStep {
  phase: 'mise' | 'cook';
  text: string;
  timerSec?: number;
}

export interface RecipeNutrition {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** True when Claude-/author-estimated rather than measured. */
  estimated: boolean;
}

export interface Recipe {
  id: string;
  title: string;
  /** Photo URL — seed photos live under /recipes/, imports keep the og:image URL. */
  photo?: string | null;
  source: 'seed' | 'url' | 'manual' | 'ai';
  sourceUrl?: string;
  servingsBase: number;
  prepMin: number;
  cookMin: number;
  tags: string[];
  cuisine: Cuisine;
  /** 0..1 — how reliably the kids eat it. */
  kidScore?: number;
  season?: Season[];
  nutrition?: RecipeNutrition;
  tools: string[];
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  lastCookedAt?: string | null;
  ratings?: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

/** The mapping memory: normalized ingredient key → the Mercadona product you buy. */
export interface ProductMapEntry {
  productId: string;
  name: string;
  photo?: string | null;
  unitPrice?: number | null;
  packSize?: { qty: number; unit: string; display: string } | null;
  confirmedAt: string;
  timesUsed: number;
}

export interface StaplesItem {
  id: string;
  productId?: string | null;
  name: string;
  defaultQty: number;
  cadence: 'weekly' | 'biweekly' | 'monthly';
  lastOrderedAt?: string | null;
  priceEur?: number | null;
}

export interface MealPlanDay {
  /** Local date YYYY-MM-DD. */
  date: string;
  recipeId?: string | null;
  servings: number;
  /** Eating out — excluded from suggestions + the order. */
  skip?: boolean;
  /** Pinned by hand — survives re-suggest. */
  pinned?: boolean;
  note?: string;
  /**
   * Rotation memory for this day's Swap button: recipe ids recently swapped AWAY
   * (FIFO, capped) so repeated Swap cycles onward through candidates instead of
   * ping-ponging A↔B. Cleared by a manual pick or a full-week suggest. Additive —
   * old persisted plans without it parse fine.
   */
  recentSwapIds?: string[];
}

export interface MealPlan {
  /** Monday of the week, YYYY-MM-DD. */
  weekStart: string;
  days: MealPlanDay[];
}

/** What Confirm applies to the draft — shape depends on the suggestion kind (P2). */
export type SuggestionApply =
  | { action: 'switch-product'; lineId: string; productId: string; productName: string; packsNeeded: number }
  | { action: 'merge-lines'; keepLineId: string; dropLineId: string }
  | { action: 'check-line'; lineId: string };

export interface OrderSuggestion {
  id: string;
  kind: 'pack' | 'merge' | 'cadence';
  text: string;
  state: 'open' | 'confirmed' | 'ignored';
  /** Applied automatically by the pack consolidator (P1 renders only these). */
  auto?: boolean;
  /** Stable subject for the (kind, subject) suppression memory — ignored twice → never again (P2). */
  subject?: string;
  /** What Confirm applies (P2 interactive suggestions). */
  apply?: SuggestionApply;
}

export interface OrderLine {
  id: string;
  source: 'recipe' | 'staple' | 'manual' | 'tablet' | 'regular';
  /** Recipes contributing to this (deduped) line. */
  recipeIds?: string[];
  productId?: string | null;
  /** Normalized ingredient key (lower-cased canonical Spanish name). */
  ingredientKey: string;
  label: string;
  qty: number;
  unit: string;
  packsNeeded?: number;
  coverageNote?: string;
  /** No ProductMap entry yet → the UI shows the cyan pick-once search. */
  needsMapping?: boolean;
  /** The "newly needed" checkbox — unchecked lines are not ordered. */
  checked: boolean;
  priceEur?: number | null;
  /** True when priceEur is a PRESERVED last-known estimate (live re-check unavailable),
   *  not a live-confirmed price. The spend cap still judges the real total off it. */
  priceEst?: boolean;
  /** Pantry staple heuristics pre-uncheck these. */
  pantry?: boolean;
  /** Mixed units were aggregated across recipes — the qty needs a human look (P2). */
  incomparable?: boolean;
}

export interface OrderDraft {
  weekStart?: string;
  lines: OrderLine[];
  suggestions: OrderSuggestion[];
  status: 'draft' | 'filled' | 'submitted';
  targetSlot?: { day: string; window: string };
  submitBy?: string;
  pushedAt?: string | null;
  totalEur: number;
  updatedAt: string;
}

export interface OrderHistoryEntry {
  id: string;
  date: string;
  lines: OrderLine[];
  totalEur: number;
  deliveredAt?: string | null;
  /** How the order left the app: checklist (M0), cart fill (M2) or detected on the account (P2). */
  source?: 'checklist' | 'cart' | 'mercadona';
  /** Mercadona order id once the placed order is detected on the account (P2). */
  orderId?: string | null;
  /** Delivery window of the placed order, when the API exposes it (P2). */
  slot?: { start: string; end: string } | null;
}

export interface HouseholdGoals {
  mode: 'weight-loss' | 'maintain' | 'high-protein' | null;
  kcalPerDinner: number | null;
  notes?: string;
}

export interface Household {
  adults: number;
  kids: number;
  allergies: string[];
  /**
   * Diet restrictions — a HARD filter like allergies. Preset slugs ('vegetarian',
   * 'vegan', 'pescatarian', 'no-pork', 'no-beef', 'gluten-free', 'lactose-free')
   * expand to ES+EN ingredient keyword lists in the engine; free-text values match
   * exactly like allergy terms.
   */
  dietRestrictions: string[];
  dislikes: string[];
  loves: string[];
  weeknightMaxMin: number;
  /** 0..100 per cuisine — weights the suggestion engine. */
  cuisineWeights: Record<Cuisine, number>;
  goals: HouseholdGoals;
  showNutritionOnCards: boolean;
}

export interface Reminders {
  /** Plan-week nudge: day-of-week (0=Sun) + hour, default Sun 18:00. */
  planWeekDow: number;
  planWeekHour: number;
  /** Submit deadline: default Sun 22:00 (nudge fires at deadline − 4h). */
  submitByDow: number;
  submitByHour: number;
  /** Human label for the target delivery slot, e.g. "Mon 19:00–20:00". */
  targetSlotLabel: string;
  /** Coordinator dedupe: ISO week keys of the last fired nudges. */
  lastPlanNudgeWeek?: string;
  lastSubmitNudgeWeek?: string;
}

/** Everything persisted in .data/kitchen.json (atomic tmp+rename writes). */
export interface KitchenData {
  recipes: Recipe[];
  productMap: Record<string, ProductMapEntry>;
  staples: StaplesItem[];
  /** weekStart (Monday YYYY-MM-DD) → plan. */
  plans: Record<string, MealPlan>;
  orderDraft: OrderDraft;
  orderHistory: OrderHistoryEntry[];
  household: Household;
  reminders: Reminders;
  /** (kind:subject) → times ignored. At 2 the suggestion is permanently suppressed (P2). */
  suggestionMutes: Record<string, number>;
  /** Seed-library version applied (never re-seeds over user edits). */
  seededAt: string | null;
}
