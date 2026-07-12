// Kitchen Hub content store — a SEPARATE JSON file (.data/kitchen.json) from state.json,
// because recipes are sizeable (docs/39 "Storage"). Same atomic write pattern as
// store.ts (write tmp + rename). The small connector config (Mercadona warehouse,
// Intelligence key) lives in state.json under `kitchen` — see store.ts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from '../store';
import { SEED_RECIPES } from './seed-recipes';
import type {
  Cuisine,
  Household,
  KitchenData,
  MealPlan,
  NutritionScales,
  OrderDraft,
  Recipe,
  Reminders,
} from './types';

export * from './types';

// ---- Defaults ---------------------------------------------------------------

export function defaultNutritionScales(): NutritionScales {
  return { calories: 5, carbs: 5, fish: 5, veg: 5, protein: 5 };
}

export function defaultHousehold(): Household {
  return {
    adults: 2,
    kids: 2,
    allergies: [],
    dietRestrictions: [],
    dislikes: [],
    loves: [],
    weeknightMaxMin: 30,
    cuisineWeights: { spanish: 80, japanese: 65, italian: 60, dutch: 45, global: 50 },
    goals: { mode: null, kcalPerDinner: null },
    showNutritionOnCards: true,
    nutritionScales: defaultNutritionScales(),
    seasonalLocal: true,
    boostIngredients: [],
  };
}

export function defaultReminders(): Reminders {
  return {
    planWeekDow: 0, // Sunday
    planWeekHour: 18,
    submitByDow: 0, // Sunday
    submitByHour: 22,
    targetSlotLabel: 'Mon 19:00–20:00',
  };
}

export function emptyDraft(): OrderDraft {
  return {
    lines: [],
    suggestions: [],
    status: 'draft',
    totalEur: 0,
    updatedAt: new Date().toISOString(),
  };
}

function defaults(): KitchenData {
  return {
    recipes: [],
    productMap: {},
    staples: [],
    plans: {},
    orderDraft: emptyDraft(),
    orderHistory: [],
    household: defaultHousehold(),
    reminders: defaultReminders(),
    suggestionMutes: {},
    seededAt: null,
  };
}

// ---- Hydration (defensive — a malformed file can never break boot) -----------

const CUISINES: Cuisine[] = ['spanish', 'dutch', 'japanese', 'italian', 'global'];

function hydrate(p: unknown): KitchenData {
  const base = defaults();
  if (!p || typeof p !== 'object') return base;
  const k = p as Partial<KitchenData>;
  const hh = (k.household ?? {}) as Partial<Household>;
  const weights = { ...base.household.cuisineWeights };
  if (hh.cuisineWeights && typeof hh.cuisineWeights === 'object') {
    for (const c of CUISINES) {
      const v = (hh.cuisineWeights as Record<string, unknown>)[c];
      if (typeof v === 'number' && Number.isFinite(v)) weights[c] = Math.max(0, Math.min(100, v));
    }
  }
  const goals = (hh.goals ?? {}) as Partial<Household['goals']>;
  const rem = (k.reminders ?? {}) as Partial<Reminders>;
  const draft = (k.orderDraft ?? {}) as Partial<OrderDraft>;
  return {
    recipes: Array.isArray(k.recipes) ? (k.recipes as Recipe[]) : base.recipes,
    productMap: k.productMap && typeof k.productMap === 'object' ? k.productMap : base.productMap,
    staples: Array.isArray(k.staples) ? k.staples : base.staples,
    plans: k.plans && typeof k.plans === 'object' ? (k.plans as Record<string, MealPlan>) : base.plans,
    orderDraft: {
      ...base.orderDraft,
      ...draft,
      lines: Array.isArray(draft.lines) ? draft.lines : [],
      suggestions: Array.isArray(draft.suggestions) ? draft.suggestions : [],
      status: draft.status === 'filled' || draft.status === 'submitted' ? draft.status : 'draft',
      totalEur: typeof draft.totalEur === 'number' ? draft.totalEur : 0,
      updatedAt: typeof draft.updatedAt === 'string' ? draft.updatedAt : base.orderDraft.updatedAt,
    },
    orderHistory: Array.isArray(k.orderHistory) ? k.orderHistory : base.orderHistory,
    household: {
      adults: typeof hh.adults === 'number' ? Math.max(1, Math.min(12, hh.adults)) : base.household.adults,
      kids: typeof hh.kids === 'number' ? Math.max(0, Math.min(12, hh.kids)) : base.household.kids,
      allergies: Array.isArray(hh.allergies) ? hh.allergies.filter((x): x is string => typeof x === 'string') : [],
      // Additive (2026-07): older stored households have no dietRestrictions — default [].
      dietRestrictions: Array.isArray(hh.dietRestrictions)
        ? hh.dietRestrictions.filter((x): x is string => typeof x === 'string')
        : [],
      dislikes: Array.isArray(hh.dislikes) ? hh.dislikes.filter((x): x is string => typeof x === 'string') : [],
      loves: Array.isArray(hh.loves) ? hh.loves.filter((x): x is string => typeof x === 'string') : [],
      weeknightMaxMin:
        typeof hh.weeknightMaxMin === 'number'
          ? Math.max(10, Math.min(180, hh.weeknightMaxMin))
          : base.household.weeknightMaxMin,
      cuisineWeights: weights,
      goals: {
        mode:
          goals.mode === 'weight-loss' || goals.mode === 'maintain' || goals.mode === 'high-protein'
            ? goals.mode
            : null,
        kcalPerDinner:
          typeof goals.kcalPerDinner === 'number' && Number.isFinite(goals.kcalPerDinner)
            ? Math.max(200, Math.min(2000, goals.kcalPerDinner))
            : null,
        ...(typeof goals.notes === 'string' ? { notes: goals.notes } : {}),
      },
      showNutritionOnCards:
        typeof hh.showNutritionOnCards === 'boolean' ? hh.showNutritionOnCards : base.household.showNutritionOnCards,
      // Additive (docs/46): older stored households have no nutritionScales/seasonalLocal/
      // boostIngredients — hydrate defensively, same pattern as dietRestrictions above.
      nutritionScales: hydrateNutritionScales(hh.nutritionScales),
      seasonalLocal: typeof hh.seasonalLocal === 'boolean' ? hh.seasonalLocal : base.household.seasonalLocal,
      boostIngredients: Array.isArray(hh.boostIngredients)
        ? hh.boostIngredients.filter((x): x is string => typeof x === 'string').slice(0, 30)
        : [],
    },
    reminders: {
      planWeekDow: typeof rem.planWeekDow === 'number' ? ((rem.planWeekDow % 7) + 7) % 7 : base.reminders.planWeekDow,
      planWeekHour:
        typeof rem.planWeekHour === 'number' ? Math.max(0, Math.min(23, rem.planWeekHour)) : base.reminders.planWeekHour,
      submitByDow: typeof rem.submitByDow === 'number' ? ((rem.submitByDow % 7) + 7) % 7 : base.reminders.submitByDow,
      submitByHour:
        typeof rem.submitByHour === 'number' ? Math.max(0, Math.min(23, rem.submitByHour)) : base.reminders.submitByHour,
      targetSlotLabel:
        typeof rem.targetSlotLabel === 'string' && rem.targetSlotLabel
          ? rem.targetSlotLabel
          : base.reminders.targetSlotLabel,
      ...(typeof rem.lastPlanNudgeWeek === 'string' ? { lastPlanNudgeWeek: rem.lastPlanNudgeWeek } : {}),
      ...(typeof rem.lastSubmitNudgeWeek === 'string' ? { lastSubmitNudgeWeek: rem.lastSubmitNudgeWeek } : {}),
    },
    suggestionMutes: hydrateMutes(k.suggestionMutes),
    seededAt: typeof k.seededAt === 'string' ? k.seededAt : null,
  };
}

/** Clamp each 1–10 scale defensively; a missing/malformed object falls back to all-5 (neutral). */
function hydrateNutritionScales(p: unknown): NutritionScales {
  const base = defaultNutritionScales();
  if (!p || typeof p !== 'object') return base;
  const s = p as Partial<NutritionScales>;
  const clamp = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(10, Math.round(v))) : fallback;
  return {
    calories: clamp(s.calories, base.calories),
    carbs: clamp(s.carbs, base.carbs),
    fish: clamp(s.fish, base.fish),
    veg: clamp(s.veg, base.veg),
    protein: clamp(s.protein, base.protein),
  };
}

function hydrateMutes(p: unknown): Record<string, number> {
  if (!p || typeof p !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(p as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[key] = Math.round(v);
  }
  return out;
}

// ---- Seed (first boot only — never overwrites user edits) --------------------

function applySeed(data: KitchenData): boolean {
  if (data.seededAt) return false;
  const now = new Date().toISOString();
  const existing = new Set(data.recipes.map((r) => r.id));
  for (const s of SEED_RECIPES) {
    if (existing.has(s.id)) continue;
    data.recipes.push({ ...s, source: 'seed', createdAt: now, updatedAt: now });
  }
  data.seededAt = now;
  return true;
}

// ---- Persistence (atomic tmp + rename, mirroring store.ts) -------------------

function filePath(): string {
  if (process.env.KITCHEN_FILE) return process.env.KITCHEN_FILE;
  return resolve(dataDir(), 'kitchen.json');
}

let cache: KitchenData | null = null;

function load(): KitchenData {
  if (cache) return cache;
  const f = filePath();
  let parsed: unknown = null;
  if (existsSync(f)) {
    try {
      parsed = JSON.parse(readFileSync(f, 'utf8'));
    } catch (e) {
      console.error('[kitchen] failed to parse kitchen.json — starting from defaults:', (e as Error).message);
    }
  }
  const data = hydrate(parsed);
  const seeded = applySeed(data);
  cache = data;
  if (seeded) persist(data);
  return data;
}

function persist(data: KitchenData): void {
  const f = filePath();
  try {
    mkdirSync(resolve(f, '..'), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, f); // atomic on the same filesystem
  } catch (e) {
    // Never throw into a request path over a persistence hiccup — the in-memory
    // state stays authoritative and the next successful write catches up.
    console.error('[kitchen] persist failed:', (e as Error).message);
  }
}

export function get(): KitchenData {
  return load();
}

/** Mutate the kitchen data in place and persist atomically (store.ts pattern). */
export function update<T = void>(mutator: (data: KitchenData) => T): T {
  const data = load();
  const result = mutator(data);
  persist(data);
  return result;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
