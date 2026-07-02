// Kitchen Hub HTTP surface (docs/39): /api/kitchen/* — household prefs, recipe CRUD +
// URL import, week planner (deterministic suggest + AI request box), staples, order
// draft with pack-size consolidation, product search proxy + mapping memory, and the
// admin Mercadona status probe. Mounted behind the global requireAuth in index.ts;
// mutations are any-household-member by design (docs/39) — only the status probe and
// Intelligence settings are admin-gated.

import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../auth/middleware';
import * as mercadona from '../connectors/mercadona';
import * as claude from '../connectors/claude';
import { logEvent } from '../events';
import * as store from '../store';
import * as kitchen from '../kitchen/store';
import {
  addDays,
  emptyPlan,
  formatQty,
  ingredientKey,
  normalizeQty,
  packMath,
  suggestWeek,
  weekStartOf,
} from '../kitchen/engine';
import { importRecipeFromUrl } from '../kitchen/import';
import type {
  Cuisine,
  Household,
  MealPlan,
  OrderDraft,
  OrderLine,
  OrderSuggestion,
  ProductMapEntry,
  Recipe,
  Reminders,
  StaplesItem,
} from '../kitchen/types';

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

const wrap =
  (fn: (req: Request) => Promise<unknown> | unknown) =>
  async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      const err = e as Error & { code?: string };
      const isInput = err.code === 'BAD_INPUT';
      res.status(isInput ? 400 : 502).json({ error: err.message, code: err.code ?? 'UPSTREAM' });
    }
  };

const ts = () => new Date().toISOString();

export const kitchenRouter = Router();

// ---- Household preferences ----------------------------------------------------------

kitchenRouter.get(
  '/household',
  wrap(() => ({ ts: ts(), household: kitchen.get().household })),
);

const CUISINES: Cuisine[] = ['spanish', 'dutch', 'japanese', 'italian', 'global'];

kitchenRouter.put(
  '/household',
  wrap((req) => {
    const b = (req.body ?? {}) as Partial<Household>;
    const household = kitchen.update((d) => {
      const h = d.household;
      if (typeof b.adults === 'number') h.adults = Math.max(1, Math.min(12, Math.round(b.adults)));
      if (typeof b.kids === 'number') h.kids = Math.max(0, Math.min(12, Math.round(b.kids)));
      if (Array.isArray(b.allergies)) h.allergies = b.allergies.filter((x): x is string => typeof x === 'string').slice(0, 30);
      if (Array.isArray(b.dislikes)) h.dislikes = b.dislikes.filter((x): x is string => typeof x === 'string').slice(0, 30);
      if (Array.isArray(b.loves)) h.loves = b.loves.filter((x): x is string => typeof x === 'string').slice(0, 30);
      if (typeof b.weeknightMaxMin === 'number') h.weeknightMaxMin = Math.max(10, Math.min(180, b.weeknightMaxMin));
      if (b.cuisineWeights && typeof b.cuisineWeights === 'object') {
        for (const c of CUISINES) {
          const v = (b.cuisineWeights as Record<string, unknown>)[c];
          if (typeof v === 'number' && Number.isFinite(v)) h.cuisineWeights[c] = Math.max(0, Math.min(100, v));
        }
      }
      if (b.goals && typeof b.goals === 'object') {
        const g = b.goals as Partial<Household['goals']>;
        if (g.mode === 'weight-loss' || g.mode === 'maintain' || g.mode === 'high-protein' || g.mode === null)
          h.goals.mode = g.mode ?? null;
        if (g.kcalPerDinner === null) h.goals.kcalPerDinner = null;
        else if (typeof g.kcalPerDinner === 'number') h.goals.kcalPerDinner = Math.max(200, Math.min(2000, g.kcalPerDinner));
      }
      if (typeof b.showNutritionOnCards === 'boolean') h.showNutritionOnCards = b.showNutritionOnCards;
      return h;
    });
    return { ts: ts(), household };
  }),
);

// ---- Reminders / order rhythm ---------------------------------------------------------

kitchenRouter.get(
  '/reminders',
  wrap(() => ({ ts: ts(), reminders: kitchen.get().reminders })),
);

kitchenRouter.put(
  '/reminders',
  wrap((req) => {
    const b = (req.body ?? {}) as Partial<Reminders>;
    const reminders = kitchen.update((d) => {
      const r = d.reminders;
      if (typeof b.planWeekDow === 'number') r.planWeekDow = ((Math.round(b.planWeekDow) % 7) + 7) % 7;
      if (typeof b.planWeekHour === 'number') r.planWeekHour = Math.max(0, Math.min(23, Math.round(b.planWeekHour)));
      if (typeof b.submitByDow === 'number') r.submitByDow = ((Math.round(b.submitByDow) % 7) + 7) % 7;
      if (typeof b.submitByHour === 'number') r.submitByHour = Math.max(0, Math.min(23, Math.round(b.submitByHour)));
      if (typeof b.targetSlotLabel === 'string' && b.targetSlotLabel.trim()) r.targetSlotLabel = b.targetSlotLabel.trim().slice(0, 60);
      return r;
    });
    return { ts: ts(), reminders };
  }),
);

// ---- Recipes ---------------------------------------------------------------------------

kitchenRouter.get(
  '/recipes',
  wrap(() => ({ ts: ts(), recipes: kitchen.get().recipes })),
);

function sanitizeRecipe(body: Partial<Recipe>, existing?: Recipe): Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'> {
  const title = (body.title ?? existing?.title ?? '').toString().trim();
  if (!title) throw badInput('recipe needs a title');
  const cuisine: Cuisine = CUISINES.includes(body.cuisine as Cuisine) ? (body.cuisine as Cuisine) : (existing?.cuisine ?? 'global');
  const ingredients = Array.isArray(body.ingredients)
    ? body.ingredients
        .filter((i) => i && typeof i === 'object' && typeof (i as { es?: unknown }).es === 'string')
        .map((i) => ({
          name: String(i.name ?? i.es),
          es: String(i.es),
          qty: typeof i.qty === 'number' && Number.isFinite(i.qty) ? i.qty : null,
          unit: String(i.unit ?? 'count'),
          ...(i.pantryStaple ? { pantryStaple: true as const } : {}),
        }))
    : existing?.ingredients ?? [];
  const steps = Array.isArray(body.steps)
    ? body.steps
        .filter((s) => s && typeof (s as { text?: unknown }).text === 'string')
        .map((s) => ({
          phase: s.phase === 'mise' ? ('mise' as const) : ('cook' as const),
          text: String(s.text),
          ...(typeof s.timerSec === 'number' ? { timerSec: s.timerSec } : {}),
        }))
    : existing?.steps ?? [];
  return {
    title,
    photo: typeof body.photo === 'string' ? body.photo : existing?.photo ?? null,
    source: body.source === 'url' || body.source === 'seed' ? body.source : existing?.source ?? 'manual',
    ...(typeof body.sourceUrl === 'string' ? { sourceUrl: body.sourceUrl } : existing?.sourceUrl ? { sourceUrl: existing.sourceUrl } : {}),
    servingsBase:
      typeof body.servingsBase === 'number' && body.servingsBase > 0
        ? Math.min(24, Math.round(body.servingsBase))
        : existing?.servingsBase ?? 4,
    prepMin: typeof body.prepMin === 'number' ? Math.max(0, body.prepMin) : existing?.prepMin ?? 15,
    cookMin: typeof body.cookMin === 'number' ? Math.max(0, body.cookMin) : existing?.cookMin ?? 30,
    tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : existing?.tags ?? [],
    cuisine,
    ...(typeof body.kidScore === 'number' ? { kidScore: Math.max(0, Math.min(1, body.kidScore)) } : existing?.kidScore != null ? { kidScore: existing.kidScore } : {}),
    ...(Array.isArray(body.season) ? { season: body.season } : existing?.season ? { season: existing.season } : {}),
    ...(body.nutrition && typeof body.nutrition === 'object'
      ? {
          nutrition: {
            kcal: Number(body.nutrition.kcal) || 0,
            proteinG: Number(body.nutrition.proteinG) || 0,
            carbsG: Number(body.nutrition.carbsG) || 0,
            fatG: Number(body.nutrition.fatG) || 0,
            estimated: body.nutrition.estimated !== false,
          },
        }
      : existing?.nutrition
        ? { nutrition: existing.nutrition }
        : {}),
    tools: Array.isArray(body.tools) ? body.tools.filter((t): t is string => typeof t === 'string') : existing?.tools ?? [],
    ingredients,
    steps,
    lastCookedAt: existing?.lastCookedAt ?? null,
    ...(existing?.ratings ? { ratings: existing.ratings } : {}),
  };
}

kitchenRouter.post(
  '/recipes',
  wrap((req) => {
    const clean = sanitizeRecipe((req.body ?? {}) as Partial<Recipe>);
    const now = ts();
    const recipe: Recipe = { ...clean, id: kitchen.newId('recipe'), createdAt: now, updatedAt: now };
    kitchen.update((d) => {
      d.recipes.push(recipe);
    });
    return { ts: now, recipe };
  }),
);

// URL import — JSON-LD first, Claude when Intelligence is on, manual prefill otherwise.
kitchenRouter.post(
  '/recipes/import',
  wrap(async (req) => {
    const url = String((req.body as { url?: unknown })?.url ?? '').trim();
    if (!url) throw badInput('body.url required');
    const result = await importRecipeFromUrl(url);
    if (!result.ok || !result.recipe) {
      return { ts: ts(), ok: false, prefill: result.prefill, detail: result.detail };
    }
    const now = ts();
    const recipe: Recipe = { ...result.recipe, id: kitchen.newId('recipe'), createdAt: now, updatedAt: now };
    kitchen.update((d) => {
      d.recipes.push(recipe);
    });
    logEvent({
      class: 'system',
      category: 'kitchen',
      severity: 'low',
      summary: `Recipe imported: ${recipe.title}`,
      trigger: { source: 'user', detail: url },
      data: { recipeId: recipe.id, url },
    });
    return { ts: now, ok: true, recipe };
  }),
);

kitchenRouter.put(
  '/recipes/:id',
  wrap((req) => {
    const id = String(req.params.id);
    const updated = kitchen.update((d) => {
      const idx = d.recipes.findIndex((r) => r.id === id);
      if (idx < 0) return null;
      const merged: Recipe = {
        ...sanitizeRecipe((req.body ?? {}) as Partial<Recipe>, d.recipes[idx]),
        id,
        createdAt: d.recipes[idx].createdAt,
        updatedAt: ts(),
      };
      d.recipes[idx] = merged;
      return merged;
    });
    if (!updated) throw badInput(`recipe ${id} not found`);
    return { ts: ts(), recipe: updated };
  }),
);

kitchenRouter.delete(
  '/recipes/:id',
  wrap((req) => {
    const id = String(req.params.id);
    kitchen.update((d) => {
      d.recipes = d.recipes.filter((r) => r.id !== id);
    });
    return { ts: ts(), ok: true };
  }),
);

// ---- Week planner -----------------------------------------------------------------------

function planFor(weekStart: string): MealPlan {
  const d = kitchen.get();
  const existing = d.plans[weekStart];
  if (existing) return existing;
  const fresh = emptyPlan(weekStart, d.household.adults + d.household.kids);
  kitchen.update((k) => {
    k.plans[weekStart] = fresh;
  });
  return fresh;
}

function weekParam(req: Request): string {
  const raw = String(req.query.week ?? '').trim();
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return weekStartOf(new Date(`${raw}T12:00:00`));
  return weekStartOf(new Date());
}

kitchenRouter.get(
  '/plan',
  wrap((req) => {
    const weekStart = weekParam(req);
    return { ts: ts(), plan: planFor(weekStart) };
  }),
);

kitchenRouter.put(
  '/plan',
  wrap((req) => {
    const weekStart = weekParam(req);
    const b = (req.body ?? {}) as {
      date?: string;
      recipeId?: string | null;
      skip?: boolean;
      clear?: boolean;
      servings?: number;
      pinned?: boolean;
    };
    if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) throw badInput('body.date (YYYY-MM-DD) required');
    planFor(weekStart);
    const plan = kitchen.update((d) => {
      const p = d.plans[weekStart];
      const day = p.days.find((x) => x.date === b.date);
      if (!day) throw badInput(`date ${b.date} not in week ${weekStart}`);
      if (b.clear) {
        day.recipeId = null;
        delete day.skip;
        delete day.pinned;
      }
      if (typeof b.skip === 'boolean') {
        if (b.skip) {
          day.skip = true;
          day.recipeId = null;
          delete day.pinned;
        } else {
          delete day.skip;
        }
      }
      if (b.recipeId !== undefined && b.recipeId !== null) {
        if (!d.recipes.some((r) => r.id === b.recipeId)) throw badInput(`recipe ${b.recipeId} not found`);
        day.recipeId = b.recipeId;
        day.pinned = true; // a hand-pick is a pin — it survives re-suggest
        delete day.skip;
      }
      if (typeof b.pinned === 'boolean') {
        if (b.pinned) day.pinned = true;
        else delete day.pinned;
      }
      if (typeof b.servings === 'number' && Number.isFinite(b.servings)) day.servings = Math.max(1, Math.min(24, Math.round(b.servings)));
      return p;
    });
    return { ts: ts(), plan };
  }),
);

// Deterministic engine — no LLM. body {day?} re-suggests a single slot.
kitchenRouter.post(
  '/plan/suggest',
  wrap((req) => {
    const weekStart = weekParam(req);
    const b = (req.body ?? {}) as { day?: string };
    planFor(weekStart);
    const d = kitchen.get();
    const suggested = suggestWeek(d.plans[weekStart], d.recipes, d.household, new Date(), b.day);
    kitchen.update((k) => {
      k.plans[weekStart] = suggested;
    });
    return { ts: ts(), plan: suggested };
  }),
);

// AI request box → candidate recipes. Soft 'intelligence-off' answer + a deterministic
// library keyword fallback when the feature is off/unavailable (docs/39).
kitchenRouter.post(
  '/plan/ask',
  wrap(async (req) => {
    const text = String((req.body as { text?: unknown })?.text ?? '').trim();
    if (!text) throw badInput('body.text required');
    const d = kitchen.get();
    const fallback = () => {
      const words = text
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);
      const scored = d.recipes
        .map((r) => {
          const hay = `${r.title} ${r.tags.join(' ')} ${r.cuisine} ${r.ingredients.map((i) => `${i.name} ${i.es}`).join(' ')}`.toLowerCase();
          return { r, s: words.filter((w) => hay.includes(w)).length };
        })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 5);
      return scored.map((x) => x.r.id);
    };
    if (!claude.isFeatureEnabled('plannerRequestBox')) {
      return { ts: ts(), ok: false, reason: 'intelligence-off', candidateIds: fallback() };
    }
    const library = d.recipes
      .map((r) => `${r.id} | ${r.title} | ${r.cuisine} | ${r.prepMin + r.cookMin} min | ${r.nutrition?.kcal ?? '?'} kcal | ${r.tags.join(',')}`)
      .join('\n');
    const parsed = await claude.completeJSON<{ candidateIds?: string[]; note?: string }>({
      system:
        'You help plan family dinners. Given a recipe library (one per line: id | title | cuisine | total min | kcal | tags) ' +
        'and a free-text request, output ONLY JSON: {"candidateIds": [up to 5 library ids best matching the request], "note": "one short sentence"}.',
      prompt: `Library:\n${library}\n\nRequest: ${text}`,
      maxTokens: 400,
    });
    const valid = (parsed?.candidateIds ?? []).filter((id) => d.recipes.some((r) => r.id === id));
    if (!valid.length) return { ts: ts(), ok: false, reason: 'no-match', candidateIds: fallback() };
    return { ts: ts(), ok: true, candidateIds: valid.slice(0, 5), note: parsed?.note };
  }),
);

// ---- Staples ------------------------------------------------------------------------------

kitchenRouter.get(
  '/staples',
  wrap(() => ({ ts: ts(), staples: kitchen.get().staples })),
);

kitchenRouter.put(
  '/staples',
  wrap((req) => {
    const b = (req.body ?? {}) as { staples?: unknown };
    if (!Array.isArray(b.staples)) throw badInput('body.staples array required');
    const staples = kitchen.update((d) => {
      d.staples = (b.staples as Partial<StaplesItem>[])
        .filter((s) => s && typeof s.name === 'string' && s.name.trim())
        .map((s) => ({
          id: typeof s.id === 'string' && s.id ? s.id : kitchen.newId('staple'),
          ...(typeof s.productId === 'string' ? { productId: s.productId } : {}),
          name: String(s.name).trim().slice(0, 80),
          defaultQty: typeof s.defaultQty === 'number' && s.defaultQty > 0 ? Math.min(99, Math.round(s.defaultQty)) : 1,
          cadence: s.cadence === 'biweekly' || s.cadence === 'monthly' ? s.cadence : 'weekly',
          lastOrderedAt: typeof s.lastOrderedAt === 'string' ? s.lastOrderedAt : null,
          priceEur: typeof s.priceEur === 'number' ? s.priceEur : null,
        }));
      return d.staples;
    });
    return { ts: ts(), staples };
  }),
);

// ---- Order draft ---------------------------------------------------------------------------

const CADENCE_DAYS: Record<StaplesItem['cadence'], number> = { weekly: 7, biweekly: 14, monthly: 30 };

function stapleDue(s: StaplesItem, now: Date): boolean {
  if (!s.lastOrderedAt) return true;
  const days = (now.getTime() - new Date(s.lastOrderedAt).getTime()) / 86_400_000;
  return days >= CADENCE_DAYS[s.cadence] - 1;
}

/** Server-side price + pack-math recompute for every line (docs/39: the server owns the math). */
async function enrichLines(lines: OrderLine[], productMap: Record<string, ProductMapEntry>): Promise<OrderSuggestion[]> {
  const autoSuggestions: OrderSuggestion[] = [];
  for (const line of lines) {
    const map = line.ingredientKey ? productMap[line.ingredientKey] : undefined;
    if (map && !line.productId) line.productId = map.productId;
    if (line.productId) {
      line.needsMapping = false;
      // Price via the connector (30-min cached). Degrades to null → "price unavailable".
      const product = await mercadona.getProduct(line.productId);
      const unitPrice = product?.unitPrice ?? map?.unitPrice ?? null;
      const pack = product?.packSize
        ? { qty: product.packSize.qty, unit: product.packSize.unit, display: product.packSizeDisplay ?? `${product.packSize.qty} ${product.packSize.unit}` }
        : map?.packSize ?? null;
      if (line.source === 'recipe') {
        const math = packMath(line.qty, line.unit, line.recipeIds?.length ?? 1, pack);
        if (math) {
          line.packsNeeded = math.packsNeeded;
          line.coverageNote = math.coverageNote;
          line.priceEur = unitPrice != null ? Math.round(unitPrice * math.packsNeeded * 100) / 100 : null;
          if ((line.recipeIds?.length ?? 0) > 1) {
            autoSuggestions.push({
              id: `auto-${line.id}`,
              kind: 'pack',
              text: `${line.label} merged: ${math.coverageNote}`,
              state: 'confirmed',
              auto: true,
            });
          }
        } else {
          // Units incomparable (or pack size unknown) → assume one unit of the product.
          delete line.packsNeeded;
          delete line.coverageNote;
          line.priceEur = unitPrice;
        }
      } else {
        line.priceEur = unitPrice != null ? Math.round(unitPrice * Math.max(1, line.qty) * 100) / 100 : null;
      }
    } else if (line.source === 'recipe' || line.source === 'manual' || line.source === 'tablet') {
      line.needsMapping = true;
      line.priceEur = null;
    }
  }
  return autoSuggestions;
}

function draftTotals(draft: OrderDraft): void {
  draft.totalEur = Math.round(draft.lines.reduce((sum, l) => sum + (l.checked && l.priceEur != null ? l.priceEur : 0), 0) * 100) / 100;
}

function rhythmFor(draft: OrderDraft, reminders: Reminders): void {
  const weekStart = draft.weekStart ?? weekStartOf(new Date());
  // Delivery targets the plan week's Monday evening; submit by the evening before.
  const submitDate = addDays(weekStart, -1);
  draft.targetSlot = { day: weekStart, window: reminders.targetSlotLabel };
  draft.submitBy = `${submitDate}T${String(reminders.submitByHour).padStart(2, '0')}:00:00`;
}

kitchenRouter.get(
  '/order/draft',
  wrap(() => ({ ts: ts(), draft: kitchen.get().orderDraft })),
);

kitchenRouter.put(
  '/order/draft',
  wrap(async (req) => {
    const b = (req.body ?? {}) as { lines?: unknown; status?: OrderDraft['status'] };
    const d = kitchen.get();
    const current = d.orderDraft;
    if (Array.isArray(b.lines)) {
      const incoming = b.lines as Partial<OrderLine>[];
      current.lines = incoming
        .filter((l) => l && typeof l === 'object' && typeof l.label === 'string')
        .map((l) => ({
          id: typeof l.id === 'string' && l.id ? l.id : kitchen.newId('line'),
          source: l.source === 'staple' || l.source === 'manual' || l.source === 'tablet' ? l.source : 'recipe',
          ...(Array.isArray(l.recipeIds) ? { recipeIds: l.recipeIds.filter((x): x is string => typeof x === 'string') } : {}),
          productId: typeof l.productId === 'string' ? l.productId : null,
          ingredientKey: typeof l.ingredientKey === 'string' ? l.ingredientKey : '',
          label: String(l.label).slice(0, 120),
          qty: typeof l.qty === 'number' && Number.isFinite(l.qty) ? Math.max(0, l.qty) : 1,
          unit: typeof l.unit === 'string' ? l.unit : 'count',
          checked: l.checked !== false,
          ...(l.pantry ? { pantry: true } : {}),
          // Client-carried price survives only for unmapped lines (mapped ones are
          // recomputed server-side in enrichLines below).
          ...(typeof l.priceEur === 'number' ? { priceEur: l.priceEur } : {}),
        }));
    }
    if (b.status === 'draft' || b.status === 'submitted') current.status = b.status;
    const auto = await enrichLines(current.lines, d.productMap);
    current.suggestions = [...auto, ...current.suggestions.filter((s) => !s.auto)];
    draftTotals(current);
    rhythmFor(current, d.reminders);
    current.updatedAt = ts();
    kitchen.update((k) => {
      k.orderDraft = current;
    });
    return { ts: ts(), draft: current };
  }),
);

// Explode the week's plan into the draft: scale to servings, dedup across recipes,
// pack-size consolidation, staples-due merge (docs/39 acceptance #3).
kitchenRouter.post(
  '/order/draft/from-plan',
  wrap(async (req) => {
    const weekStart = weekParam(req);
    const d = kitchen.get();
    const plan = d.plans[weekStart] ?? emptyPlan(weekStart, d.household.adults + d.household.kids);

    interface Agg {
      qty: number;
      unit: string;
      label: string;
      recipeIds: string[];
      pantry: boolean;
      incomparable?: boolean;
    }
    const totals = new Map<string, Agg>();
    for (const day of plan.days) {
      if (day.skip || !day.recipeId) continue;
      const recipe = d.recipes.find((r) => r.id === day.recipeId);
      if (!recipe) continue;
      const scale = day.servings / recipe.servingsBase;
      for (const ing of recipe.ingredients) {
        const key = ingredientKey(ing);
        const label = ing.es.charAt(0).toUpperCase() + ing.es.slice(1);
        const prev = totals.get(key);
        if (ing.qty == null) {
          // "to taste" — keep a count-less line once (usually pantry).
          if (!prev) totals.set(key, { qty: 0, unit: 'to taste', label, recipeIds: [recipe.id], pantry: Boolean(ing.pantryStaple) });
          else if (!prev.recipeIds.includes(recipe.id)) prev.recipeIds.push(recipe.id);
          continue;
        }
        const norm = normalizeQty(ing.qty * scale, ing.unit);
        if (!prev) {
          totals.set(key, { qty: norm.qty, unit: norm.unit, label, recipeIds: [recipe.id], pantry: Boolean(ing.pantryStaple) });
        } else {
          if (prev.unit === norm.unit) prev.qty += norm.qty;
          else prev.incomparable = true; // mixed units — keep the first, flag for a human look
          if (!prev.recipeIds.includes(recipe.id)) prev.recipeIds.push(recipe.id);
          prev.pantry = prev.pantry && Boolean(ing.pantryStaple);
        }
      }
    }

    const lines: OrderLine[] = [];
    for (const [key, agg] of totals) {
      lines.push({
        id: kitchen.newId('line'),
        source: 'recipe',
        recipeIds: agg.recipeIds,
        productId: d.productMap[key]?.productId ?? null,
        ingredientKey: key,
        label: agg.label,
        qty: Math.round(agg.qty * 100) / 100,
        unit: agg.unit,
        checked: !agg.pantry, // pantry staples pre-unchecked (owner requirement)
        ...(agg.pantry ? { pantry: true } : {}),
      });
    }

    // Staples due by cadence — one line each, default quantities.
    const now = new Date();
    for (const s of d.staples) {
      const due = stapleDue(s, now);
      lines.push({
        id: kitchen.newId('line'),
        source: 'staple',
        productId: s.productId ?? null,
        ingredientKey: `staple:${s.id}`,
        label: s.name,
        qty: s.defaultQty,
        unit: 'count',
        checked: due,
        ...(due ? {} : { pantry: true }),
        priceEur: s.priceEur != null ? Math.round(s.priceEur * s.defaultQty * 100) / 100 : null,
      });
    }

    // Keep hand-added lines from the current draft (they're not derived from the plan).
    const manual = d.orderDraft.lines.filter((l) => l.source === 'manual' || l.source === 'tablet');

    const draft: OrderDraft = {
      weekStart,
      lines: [...lines, ...manual],
      suggestions: [],
      status: 'draft',
      totalEur: 0,
      updatedAt: ts(),
    };
    const auto = await enrichLines(draft.lines, d.productMap);
    draft.suggestions = auto;
    draftTotals(draft);
    rhythmFor(draft, d.reminders);
    kitchen.update((k) => {
      k.orderDraft = draft;
    });
    logEvent({
      class: 'action',
      category: 'kitchen',
      severity: 'low',
      summary: `Order draft built from week of ${weekStart} — ${draft.lines.length} lines`,
      trigger: { source: 'user' },
      ok: true,
      data: { weekStart, lines: draft.lines.length, totalEur: draft.totalEur },
    });
    return { ts: ts(), draft };
  }),
);

kitchenRouter.get(
  '/order/history',
  wrap(() => ({ ts: ts(), history: kitchen.get().orderHistory })),
);

// M0 "Send as checklist": snapshot the checked lines into history + a plain-text list
// the client shares/copies. No Mercadona write of any kind (cart fill is P2).
kitchenRouter.post(
  '/order/checklist',
  wrap(() => {
    const d = kitchen.get();
    const checked = d.orderDraft.lines.filter((l) => l.checked);
    if (!checked.length) throw badInput('no checked lines in the draft');
    const text = checked
      .map((l) => {
        const amount = l.packsNeeded != null ? `${l.packsNeeded}×` : l.unit === 'to taste' ? '' : formatQty(l.qty, l.unit);
        const price = l.priceEur != null ? ` — ${l.priceEur.toFixed(2)} €` : '';
        return `• ${l.label}${amount ? ` · ${amount}` : ''}${price}`;
      })
      .join('\n');
    const entry = kitchen.update((k) => {
      const e = {
        id: kitchen.newId('order'),
        date: ts(),
        lines: checked,
        totalEur: k.orderDraft.totalEur,
      };
      k.orderHistory.unshift(e);
      k.orderHistory = k.orderHistory.slice(0, 60);
      // Checklist sent = staples in it count as ordered (drives the cadence hints).
      for (const l of checked) {
        if (l.source !== 'staple') continue;
        const staple = k.staples.find((s) => `staple:${s.id}` === l.ingredientKey);
        if (staple) staple.lastOrderedAt = e.date;
      }
      k.orderDraft.status = 'submitted';
      k.orderDraft.updatedAt = e.date;
      return e;
    });
    logEvent({
      class: 'action',
      category: 'kitchen',
      severity: 'low',
      summary: `Grocery checklist sent — ${checked.length} items, ${entry.totalEur.toFixed(2)} €`,
      trigger: { source: 'user' },
      ok: true,
      data: { items: checked.length, totalEur: entry.totalEur },
    });
    return { ts: ts(), ok: true, text, entry };
  }),
);

// ---- Product search proxy + mapping memory ---------------------------------------------------

kitchenRouter.get(
  '/products/search',
  wrap(async (req) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) throw badInput('query param q required');
    const results = await mercadona.searchProducts(q);
    return {
      ts: ts(),
      available: results !== null,
      products: (results ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        photo: p.photo,
        unitPrice: p.unitPrice,
        packSizeDisplay: p.packSizeDisplay,
        packSize: p.packSize,
        referencePrice: p.referencePrice,
      })),
    };
  }),
);

// Pick-once mapping: writes the ProductMap so every future order remembers the SKU.
kitchenRouter.post(
  '/products/pick',
  wrap(async (req) => {
    const b = (req.body ?? {}) as { ingredientKey?: unknown; productId?: unknown };
    const key = String(b.ingredientKey ?? '').trim();
    const productId = String(b.productId ?? '').trim();
    if (!key || !productId) throw badInput('ingredientKey and productId required');
    const product = await mercadona.getProduct(productId);
    const entry: ProductMapEntry = {
      productId,
      name: product?.name ?? productId,
      photo: product?.photo ?? null,
      unitPrice: product?.unitPrice ?? null,
      packSize: product?.packSize
        ? { qty: product.packSize.qty, unit: product.packSize.unit, display: product.packSizeDisplay ?? `${product.packSize.qty} ${product.packSize.unit}` }
        : null,
      confirmedAt: ts(),
      timesUsed: (kitchen.get().productMap[key]?.timesUsed ?? 0) + 1,
    };
    const d = kitchen.update((k) => {
      k.productMap[key] = entry;
      return k;
    });
    // Re-enrich the current draft so the mapped line prices immediately.
    const auto = await enrichLines(d.orderDraft.lines, d.productMap);
    d.orderDraft.suggestions = [...auto, ...d.orderDraft.suggestions.filter((s) => !s.auto)];
    draftTotals(d.orderDraft);
    d.orderDraft.updatedAt = ts();
    kitchen.update((k) => {
      k.orderDraft = d.orderDraft;
    });
    return { ts: ts(), entry, draft: d.orderDraft };
  }),
);

// ---- Mercadona status probe (admin — the P0 go/no-go check) -----------------------------------

kitchenRouter.get('/mercadona/status', requireAdmin, wrap(() => mercadona.getStatus()));

// ---- Intelligence settings (Settings ▸ Intelligence, admin) -----------------------------------

function maskedKey(key: string | null): string | null {
  if (!key) return null;
  return key.length > 10 ? `${key.slice(0, 7)}••••••••${key.slice(-4)}` : '••••••••';
}

kitchenRouter.get(
  '/intelligence',
  wrap(() => {
    const cfg = store.get().kitchen.intelligence;
    return {
      ts: ts(),
      intelligence: {
        enabled: cfg.enabled,
        features: cfg.features,
        usage: cfg.usage,
        keyMasked: maskedKey(cfg.apiKey),
        envKey: Boolean(process.env.ANTHROPIC_API_KEY),
        configured: claude.isConfigured(),
      },
    };
  }),
);

kitchenRouter.put(
  '/intelligence',
  requireAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as {
      enabled?: unknown;
      apiKey?: unknown;
      features?: Partial<store.KitchenIntelligenceConfig['features']>;
    };
    const cfg = store.update((s) => {
      const i = s.kitchen.intelligence;
      if (typeof b.enabled === 'boolean') i.enabled = b.enabled;
      if (typeof b.apiKey === 'string') i.apiKey = b.apiKey.trim() || null;
      if (b.features && typeof b.features === 'object') {
        for (const f of ['importParsing', 'cookingSuggestions', 'plannerRequestBox', 'weeklyPlanAssist'] as const) {
          if (typeof b.features[f] === 'boolean') i.features[f] = b.features[f];
        }
      }
      return i;
    });
    return {
      ts: ts(),
      intelligence: {
        enabled: cfg.enabled,
        features: cfg.features,
        usage: cfg.usage,
        keyMasked: maskedKey(cfg.apiKey),
        envKey: Boolean(process.env.ANTHROPIC_API_KEY),
        configured: claude.isConfigured(),
      },
    };
  }),
);
