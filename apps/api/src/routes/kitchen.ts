// Kitchen Hub HTTP surface (docs/39 + docs/41 P2): /api/kitchen/* — household prefs,
// recipe CRUD + URL import, week planner (deterministic suggest + AI request box),
// staples (+ myregulars seeding), order draft with pack-size consolidation and
// interactive smart suggestions, CART FILL (spend cap · dry-run · human checkout),
// delivery-slot + order-status reads, product search proxy + mapping memory, the
// Mercadona account link (token bootstrap) and the admin status probe. Mounted behind
// the global requireAuth in index.ts; mutations are any-household-member by design
// (docs/39) — the status probe, Intelligence settings and account link/unlink/
// guardrail settings are admin-gated.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAdmin } from '../auth/middleware';
import * as mercadona from '../connectors/mercadona';
import * as mercadonaAuth from '../connectors/mercadona-auth';
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
  rankPlanRequestCandidates,
  suggestWeek,
  weekStartOf,
} from '../kitchen/engine';
import { enrichLines } from '../kitchen/enrich';
import { assertRealFillAllowed, assertUnderSpendCap, buildCartPlan, SpendCapError, wireLines } from '../kitchen/cart';
import { applySuggestion, buildSuggestions, isMuted, muteKey } from '../kitchen/suggestions';
import { cleanAnswer, rankRecipesByCoverage } from '../kitchen/whatcanimake';
import {
  buildGeneratePrompt,
  clampCount,
  GENERATE_SYSTEM,
  householdSignature,
  sanitizeGeneratedBatch,
  type GeneratedRecipe,
} from '../kitchen/generate';
import { syncOrderStatus } from '../kitchen/order-status';
import { importRecipeFromUrl } from '../kitchen/import';
import { mapRegulars } from '../kitchen/regulars';
import * as recipesRepo from '../kitchen/recipes-repo';
import * as libraryGen from '../kitchen/library-generate';
import type {
  Cuisine,
  Household,
  MealPlan,
  OrderDraft,
  OrderLine,
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

/**
 * Kiosk authority (P3, docs/32/38): the wall tablet may quick-add, log "cooked!" and run
 * timers, but must NEVER reach money-adjacent surfaces. The mounted router runs behind
 * the global requireAuth (a kiosk session passes), so the cart fill gets this explicit
 * block; account link/unlink + guardrail/Intelligence settings are requireAdmin already.
 */
function blockKiosk(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role === 'kiosk') {
    res.status(403).json({ error: 'not available on the wall tablet' });
    return;
  }
  next();
}

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
      if (Array.isArray(b.dietRestrictions))
        h.dietRestrictions = b.dietRestrictions.filter((x): x is string => typeof x === 'string').slice(0, 30);
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
      if (b.nutritionScales && typeof b.nutritionScales === 'object') {
        const ns = b.nutritionScales as unknown as Record<string, unknown>;
        for (const k of ['calories', 'carbs', 'fish', 'veg', 'protein'] as const) {
          const v = ns[k];
          if (typeof v === 'number' && Number.isFinite(v)) h.nutritionScales[k] = Math.max(1, Math.min(10, Math.round(v)));
        }
      }
      if (typeof b.seasonalLocal === 'boolean') h.seasonalLocal = b.seasonalLocal;
      if (Array.isArray(b.boostIngredients))
        h.boostIngredients = b.boostIngredients.filter((x): x is string => typeof x === 'string').slice(0, 30);
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

// GET /recipes — search/pagination at scale (docs/46 §2b). `all=slim` returns the FULL slim
// index unpaginated (the planner/engine's source; also handy for small libraries). Otherwise
// paginated (default pageSize 50) + filtered, FTS-backed when `q` is given. Response always
// includes `total` (and `page`/`pageSize` for the paginated shape) alongside `recipes`.
kitchenRouter.get(
  '/recipes',
  wrap((req) => {
    const q = req.query;
    if (String(q.all ?? '') === 'slim') {
      const recipes = recipesRepo.listAllSlim();
      return { ts: ts(), recipes, total: recipes.length };
    }
    const cuisine = typeof q.cuisine === 'string' && CUISINES.includes(q.cuisine as Cuisine) ? (q.cuisine as Cuisine) : undefined;
    const result = recipesRepo.search({
      ...(typeof q.q === 'string' && q.q.trim() ? { q: q.q.trim() } : {}),
      ...(cuisine ? { cuisine } : {}),
      ...(typeof q.tag === 'string' && q.tag.trim() ? { tag: q.tag.trim() } : {}),
      ...(typeof q.maxMin === 'string' && Number.isFinite(Number(q.maxMin)) ? { maxMin: Number(q.maxMin) } : {}),
      ...(String(q.fish ?? '') === 'true' ? { fish: true } : {}),
      ...(String(q.veggie ?? '') === 'true' ? { veggie: true } : {}),
      ...(typeof q.page === 'string' ? { page: Number(q.page) } : {}),
      ...(typeof q.pageSize === 'string' ? { pageSize: Number(q.pageSize) } : {}),
    });
    return { ts: ts(), recipes: result.items, total: result.total, page: result.page, pageSize: result.pageSize };
  }),
);

// Full recipe (with steps) by id — cook mode / quick-view fetch this on demand since the
// list/search paths above only carry the slim shape (docs/46 §2a).
kitchenRouter.get(
  '/recipes/:id',
  wrap((req) => {
    const recipe = recipesRepo.getFull(String(req.params.id));
    if (!recipe) throw badInput(`recipe ${req.params.id} not found`);
    return { ts: ts(), recipe };
  }),
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
    source: body.source === 'url' || body.source === 'seed' || body.source === 'ai' ? body.source : existing?.source ?? 'manual',
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
    recipesRepo.insertRecipe(recipe);
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
    recipesRepo.insertRecipe(recipe);
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
    const existing = recipesRepo.getFull(id);
    if (!existing) throw badInput(`recipe ${id} not found`);
    const merged: Recipe = {
      ...sanitizeRecipe((req.body ?? {}) as Partial<Recipe>, existing),
      id,
      createdAt: existing.createdAt,
      updatedAt: ts(),
    };
    recipesRepo.updateRecipe(merged);
    return { ts: ts(), recipe: merged };
  }),
);

kitchenRouter.delete(
  '/recipes/:id',
  wrap((req) => {
    recipesRepo.deleteRecipe(String(req.params.id));
    return { ts: ts(), ok: true };
  }),
);

// Cooked! (P3, docs/38 Loop C): one tap at the end of cooking mode logs lastCookedAt
// (feeds the 3-week rotation) + an optional 👍/😐/👎 rating that nudges the suggestion
// engine (engine.ratingAvg). Kiosk-allowed by design — any household member may cook.
kitchenRouter.post(
  '/recipes/:id/cooked',
  wrap((req) => {
    const id = String(req.params.id);
    const raw = String((req.body as { rating?: unknown })?.rating ?? '');
    const rating = raw === 'up' || raw === 'meh' || raw === 'down' ? raw : null;
    const value = rating === 'up' ? 1 : rating === 'down' ? -1 : rating === 'meh' ? 0 : null;
    const now = ts();
    const existing = recipesRepo.getFull(id);
    const updated = existing
      ? (() => {
          const r: Recipe = {
            ...existing,
            lastCookedAt: now,
            updatedAt: now,
            ...(value != null ? { ratings: { ...(existing.ratings ?? {}), [now]: value } } : {}),
          };
          recipesRepo.updateRecipe(r);
          return r;
        })()
      : null;
    if (!updated) throw badInput(`recipe ${id} not found`);
    logEvent({
      class: 'action',
      category: 'kitchen',
      severity: 'low',
      summary: `Cooked: ${updated.title}${rating ? ` — rated ${rating === 'up' ? '👍' : rating === 'meh' ? '😐' : '👎'}` : ''}`,
      trigger: { source: 'user' },
      ok: true,
      data: { recipeId: id, rating },
    });
    return { ts: now, recipe: updated };
  }),
);

// ---- "What can I make with…" (P3, docs/38 Loop C) ---------------------------------------

function onHandParam(req: Request): string[] {
  const raw = (req.body as { ingredients?: unknown })?.ingredients;
  if (!Array.isArray(raw)) throw badInput('body.ingredients array required');
  const terms = raw
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!terms.length) throw badInput('body.ingredients array required');
  return terms;
}

// Deterministic coverage ranking — no LLM (kitchen/whatcanimake.ts, unit-tested).
kitchenRouter.post(
  '/what-can-i-make',
  wrap((req) => {
    const terms = onHandParam(req);
    return { ts: ts(), results: rankRecipesByCoverage(recipesRepo.listAllSlim(), terms) };
  }),
);

// "More ideas" — free-form Claude suggestions behind the Intelligence master switch +
// the cooking-suggestions feature toggle; fails SOFT (ok:false) to the deterministic list.
kitchenRouter.post(
  '/what-can-i-make/ideas',
  wrap(async (req) => {
    const terms = onHandParam(req);
    if (!claude.isFeatureEnabled('cookingSuggestions')) {
      return { ts: ts(), ok: false, reason: 'intelligence-off', ideas: [] };
    }
    const h = kitchen.get().household;
    const parsed = await claude.completeJSON<{ ideas?: Array<{ title?: string; note?: string }> }>({
      system:
        'You suggest quick family dinner ideas from ingredients on hand. Output ONLY JSON: ' +
        '{"ideas": [{"title": "dish name", "note": "one short sentence: how, roughly, and what pantry basics it assumes"}]} ' +
        'with up to 4 ideas. Simple weeknight food; assume common pantry staples (oil, salt, rice, pasta, onion, garlic).',
      prompt:
        `Ingredients on hand: ${terms.join(', ')}.` +
        (h.allergies.length ? ` NEVER use: ${h.allergies.join(', ')} (allergies).` : '') +
        (h.dietRestrictions.length ? ` Diet restrictions (hard): ${h.dietRestrictions.join(', ')}.` : '') +
        (h.dislikes.length ? ` Avoid if possible: ${h.dislikes.join(', ')}.` : '') +
        (h.kids > 0 ? ` Cooking for ${h.adults} adults + ${h.kids} kids.` : ''),
      maxTokens: 500,
    });
    const ideas = (parsed?.ideas ?? [])
      .filter((i) => i && typeof i.title === 'string' && i.title.trim())
      .map((i) => ({ title: String(i.title).trim().slice(0, 80), note: typeof i.note === 'string' ? i.note.slice(0, 200) : '' }))
      .slice(0, 4);
    if (!ideas.length) return { ts: ts(), ok: false, reason: 'no-ideas', ideas: [] };
    return { ts: ts(), ok: true, ideas };
  }),
);

// AI question box — a free-form cooking question ("a nice recipe for healthy pizzas with
// veggie dough"). Same Intelligence gate as /ideas; cites REAL library recipes (validated
// against the library) AND up to 4 fresh off-library ideas with a one-line how-to. Fails
// SOFT (ok:false) on off/parse/upstream errors — the deterministic finder still carries.
kitchenRouter.post(
  '/what-can-i-make/answer',
  wrap(async (req) => {
    const question = String((req.body as { question?: unknown })?.question ?? '').trim();
    if (!question) throw badInput('body.question required');
    const onHandRaw = (req.body as { onHand?: unknown })?.onHand;
    const onHand = Array.isArray(onHandRaw)
      ? onHandRaw.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean).slice(0, 20)
      : [];
    if (!claude.isFeatureEnabled('cookingSuggestions')) {
      return { ts: ts(), ok: false, reason: 'intelligence-off', libraryIds: [], ideas: [] };
    }
    const h = kitchen.get().household;
    // AI prompts NEVER embed the full library (docs/46 §2b) — retrieval-cap to the top ≤120
    // slim entries most relevant to the question (FTS/keyword-scored), same idiom /plan/ask
    // uses below.
    const pool = recipesRepo.promptPool(question, 120);
    const library = pool
      .map((r) => `${r.id} | ${r.title} | ${r.cuisine} | ${r.prepMin + r.cookMin} min | ${r.nutrition?.kcal ?? '?'} kcal | ${r.tags.join(',')}`)
      .join('\n');
    try {
      const parsed = await claude.completeJSON<{ libraryIds?: string[]; ideas?: Array<{ title?: string; note?: string }> }>({
        system:
          'You answer a free-form home-cooking question for a family. You are given a recipe LIBRARY (one per line: ' +
          'id | title | cuisine | total min | kcal | tags). Output ONLY JSON: ' +
          '{"libraryIds": [up to 5 library ids that genuinely fit the question, may be empty], ' +
          '"ideas": [{"title": "dish name", "note": "one sentence: how to make it, roughly"}] up to 4 FRESH ideas NOT in the library}. ' +
          'If nothing in the library fits (e.g. an unusual request), return an empty libraryIds and carry the answer in ideas. ' +
          'Simple, doable home food; assume common pantry staples (oil, salt, flour, rice, pasta, onion, garlic).',
        prompt:
          `Library:\n${library || '(empty)'}\n\nQuestion: ${question}` +
          (onHand.length ? `\nOn hand: ${onHand.join(', ')}.` : '') +
          (h.allergies.length ? `\nNEVER use: ${h.allergies.join(', ')} (allergies).` : '') +
          (h.dislikes.length ? `\nAvoid if possible: ${h.dislikes.join(', ')}.` : '') +
          (h.kids > 0 ? `\nCooking for ${h.adults} adults + ${h.kids} kids — keep it kid-friendly.` : ''),
        maxTokens: 700,
      });
      const clean = cleanAnswer(parsed, pool);
      if (!clean.libraryIds.length && !clean.ideas.length) {
        return { ts: ts(), ok: false, reason: 'no-answer', libraryIds: [], ideas: [] };
      }
      return { ts: ts(), ok: true, libraryIds: clean.libraryIds, ideas: clean.ideas };
    } catch {
      return { ts: ts(), ok: false, reason: 'no-answer', libraryIds: [], ideas: [] }; // fail soft
    }
  }),
);

// ---- AI recipe generation — the discovery front door (docs/43) --------------------------
// POST /recipes/generate → a few COMPLETE, structured candidate recipes that already fit
// the household. Gated on the recipeGeneration feature; fails SOFT to the deterministic
// finder (which the UI always renders alongside). NOTHING is persisted here — candidates
// come back with temporary gen_<n> ids; the owner saves the ones they like via POST
// /recipes (source:'ai' now allowed). Belt-and-braces: any candidate still naming an
// allergen / diet-restriction ingredient is dropped in sanitizeGeneratedBatch.

// Tiny in-process cache: re-asking the same thing (same household) doesn't re-bill Claude.
// Process-local (single-instance household app) and cleared on restart — see docs/43.
const genCache = new Map<string, { at: number; recipes: GeneratedRecipe[] }>();
const GEN_CACHE_TTL_MS = 10 * 60_000;
const GEN_CACHE_MAX = 40;

kitchenRouter.post(
  '/recipes/generate',
  wrap(async (req) => {
    const b = (req.body ?? {}) as { question?: unknown; ingredients?: unknown; count?: unknown };
    const question = typeof b.question === 'string' ? b.question.trim() : '';
    const ingredients = Array.isArray(b.ingredients)
      ? b.ingredients
          .filter((x): x is string => typeof x === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 20)
      : [];
    if (!question && !ingredients.length) throw badInput('body.question or body.ingredients required');
    const count = clampCount(b.count);

    if (!claude.isFeatureEnabled('recipeGeneration')) {
      return { ts: ts(), ok: false, reason: 'intelligence-off', recipes: [] as GeneratedRecipe[] };
    }

    const household = kitchen.get().household;
    const cacheKey = [
      question.toLowerCase(),
      [...ingredients].map((s) => s.toLowerCase()).sort().join(','),
      String(count),
      householdSignature(household),
    ].join('||');
    const cached = genCache.get(cacheKey);
    if (cached && Date.now() - cached.at < GEN_CACHE_TTL_MS) {
      return { ts: ts(), ok: true, cached: true, recipes: cached.recipes };
    }

    try {
      const parsed = await claude.completeJSON<{ recipes?: unknown }>({
        system: GENERATE_SYSTEM,
        prompt: buildGeneratePrompt({ question, ingredients, count, household }),
        // A COMPLETE recipe (ingredients + steps + nutrition) runs ~900–1100 tokens, so a
        // flat 2600 truncated the JSON at the default count of 3 → unparseable → soft
        // 'no-recipes'. Scale with count (+ headroom) so 2–4 recipes always fit.
        maxTokens: Math.min(8000, 1200 * count + 800),
      });
      const recipes = sanitizeGeneratedBatch(parsed, household).slice(0, count);
      if (!recipes.length) return { ts: ts(), ok: false, reason: 'no-recipes', recipes: [] as GeneratedRecipe[] };
      genCache.set(cacheKey, { at: Date.now(), recipes });
      if (genCache.size > GEN_CACHE_MAX) {
        // Drop the oldest entry (Map preserves insertion order).
        const oldest = genCache.keys().next().value;
        if (oldest !== undefined) genCache.delete(oldest);
      }
      logEvent({
        class: 'system',
        category: 'kitchen',
        severity: 'low',
        summary: `AI recipes generated — ${recipes.length} candidate${recipes.length === 1 ? '' : 's'}`,
        trigger: { source: 'user', detail: question || ingredients.join(', ') },
        data: { count: recipes.length, hasQuestion: Boolean(question), ingredients: ingredients.length },
      });
      return { ts: ts(), ok: true, recipes };
    } catch {
      return { ts: ts(), ok: false, reason: 'no-recipes', recipes: [] as GeneratedRecipe[] }; // fail soft
    }
  }),
);

// ---- Bulk library generation (docs/46 §2c — admin only, Message Batches API) --------------
// A long-running background job (kitchen/library-generate.ts): start/status/cancel here are
// thin wrappers — all the coverage-plan/dispatch/poll/dedupe logic lives in that module so it
// stays independently unit-testable with fixture batch results (no live network in tests).

function libraryStatusPayload() {
  const job = libraryGen.jobStatus();
  return {
    ts: ts(),
    job,
    libraryCount: recipesRepo.count(),
    configured: claude.isConfigured(),
  };
}

kitchenRouter.get('/library/generate/status', requireAdmin, wrap(() => libraryStatusPayload()));

kitchenRouter.post(
  '/library/generate',
  requireAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as { target?: unknown; capEur?: unknown };
    const target = typeof b.target === 'number' && Number.isFinite(b.target) ? b.target : 2000;
    const capEur = typeof b.capEur === 'number' && Number.isFinite(b.capEur) ? b.capEur : undefined;
    const result = libraryGen.startGeneration(target, capEur);
    if (!result.ok) {
      return { ok: false, reason: result.reason, ...libraryStatusPayload() };
    }
    logEvent({
      class: 'action',
      category: 'kitchen',
      severity: 'low',
      summary: `Recipe library generation started — target ${Math.round(target)}`,
      trigger: { source: 'user' },
      ok: true,
      data: { target: Math.round(target) },
    });
    return { ok: true, ...libraryStatusPayload() };
  }),
);

kitchenRouter.post(
  '/library/generate/cancel',
  requireAdmin,
  wrap(() => {
    const result = libraryGen.cancelGeneration();
    if (result.ok) {
      logEvent({
        class: 'action',
        category: 'kitchen',
        severity: 'low',
        summary: 'Recipe library generation cancelled',
        trigger: { source: 'user' },
        ok: true,
      });
    }
    return { ...result, ...libraryStatusPayload() };
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
        delete day.recentSwapIds;
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
        if (!recipesRepo.exists(String(b.recipeId))) throw badInput(`recipe ${b.recipeId} not found`);
        day.recipeId = b.recipeId;
        day.pinned = true; // a hand-pick is a pin — it survives re-suggest
        delete day.skip;
        delete day.recentSwapIds; // a manual pick restarts the day's Swap rotation
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
    const before = d.plans[weekStart].days.map((x) => x.recipeId ?? null).join('|');
    const suggested = suggestWeek(d.plans[weekStart], recipesRepo.listAllSlim(), d.household, new Date(), b.day);
    kitchen.update((k) => {
      k.plans[weekStart] = suggested;
    });
    // Tiny library / heavy filters can make a re-suggest a visible no-op — say so
    // instead of looking broken (docs/39 owner feedback).
    const changed = suggested.days.map((x) => x.recipeId ?? null).join('|') !== before;
    return {
      ts: ts(),
      plan: suggested,
      ...(changed ? {} : { note: 'Library too small to vary — import more recipes or relax filters' }),
    };
  }),
);

// AI request box → candidate recipes. Soft 'intelligence-off' answer + a deterministic
// library keyword fallback when the feature is off/unavailable (docs/39).
kitchenRouter.post(
  '/plan/ask',
  wrap(async (req) => {
    const text = String((req.body as { text?: unknown })?.text ?? '').trim();
    if (!text) throw badInput('body.text required');
    const fallback = () => {
      const words = text
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);
      const scored = recipesRepo
        .listAllSlim()
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
    // AI prompts NEVER embed the full library (docs/46 §2b) — retrieval-cap to the top ≤120
    // slim entries relevant to the request; candidate ids are validated against this SAME
    // pool below (Claude can only cite what it was shown).
    const pool = recipesRepo.promptPool(text, 120);
    const library = pool
      .map((r) => `${r.id} | ${r.title} | ${r.cuisine} | ${r.prepMin + r.cookMin} min | ${r.nutrition?.kcal ?? '?'} kcal | ${r.tags.join(',')}`)
      .join('\n');
    const parsed = await claude.completeJSON<{ candidateIds?: string[]; note?: string }>({
      system:
        'You help plan family dinners. Given a recipe library (one per line: id | title | cuisine | total min | kcal | tags) ' +
        'and a free-text request, output ONLY JSON: {"candidateIds": [up to 5 library ids best matching the request], "note": "one short sentence"}.',
      prompt: `Library:\n${library}\n\nRequest: ${text}`,
      maxTokens: 400,
    });
    const poolIds = new Set(pool.map((r) => r.id));
    const valid = (parsed?.candidateIds ?? []).filter((id) => poolIds.has(id));
    if (!valid.length) return { ts: ts(), ok: false, reason: 'no-match', candidateIds: fallback() };
    return { ts: ts(), ok: true, candidateIds: valid.slice(0, 5), note: parsed?.note };
  }),
);

// Per-day "Pick" (docs/46 §1c): top 6 candidates for one day, deterministic-first. text is
// optional free-form ("something with fish, light"); excludeIds lets the sheet's Refresh
// button re-request while skipping the candidates already shown. Optional AI re-rank of the
// deterministic top ~30 rides the SAME plannerRequestBox feature as /plan/ask, fails soft.
const REQUEST_AI_POOL = 30;
const REQUEST_LIMIT = 6;

kitchenRouter.post(
  '/plan/request',
  wrap(async (req) => {
    const weekStart = weekParam(req);
    const b = (req.body ?? {}) as { date?: unknown; text?: unknown; excludeIds?: unknown };
    const date = String(b.date ?? '').trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badInput('body.date (YYYY-MM-DD) required');
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const excludeIds = Array.isArray(b.excludeIds) ? b.excludeIds.filter((x): x is string => typeof x === 'string') : [];
    planFor(weekStart);
    const d = kitchen.get();
    const plan = d.plans[weekStart];
    if (!plan.days.some((day) => day.date === date)) throw badInput(`date ${date} not in week ${weekStart}`);

    const ranked = rankPlanRequestCandidates(recipesRepo.listAllSlim(), d.household, plan, {
      date,
      now: new Date(),
      ...(text ? { text } : {}),
      excludeIds,
    });

    let ordered = ranked;
    let aiUsed = false;
    if (text && ranked.length > 1 && claude.isFeatureEnabled('plannerRequestBox')) {
      const pool = ranked.slice(0, REQUEST_AI_POOL);
      const library = pool
        .map(
          ({ recipe: r }) =>
            `${r.id} | ${r.title} | ${r.cuisine} | ${r.prepMin + r.cookMin} min | ${r.nutrition?.kcal ?? '?'} kcal | ${r.tags.join(',')}`,
        )
        .join('\n');
      try {
        const parsed = await claude.completeJSON<{ order?: string[] }>({
          system:
            "You help pick tonight's dinner. Given a candidate pool (one per line: id | title | cuisine | " +
            'total min | kcal | tags), already filtered to fit the household, output ONLY JSON: ' +
            '{"order": [pool ids, BEST match for the request first, every id present exactly once]}.',
          prompt: `Pool:\n${library}\n\nRequest: ${text}`,
          maxTokens: 400,
        });
        const byId = new Map(pool.map((c) => [c.recipe.id, c]));
        const orderedIds = (parsed?.order ?? []).filter((id) => byId.has(id));
        if (orderedIds.length) {
          const seen = new Set(orderedIds);
          const rest = pool.filter((c) => !seen.has(c.recipe.id));
          ordered = [...orderedIds.map((id) => byId.get(id)!), ...rest, ...ranked.slice(REQUEST_AI_POOL)];
          aiUsed = true;
        }
      } catch {
        // fail soft — the deterministic order stands
      }
    }
    return { ts: ts(), ok: true, aiUsed, candidates: ordered.slice(0, REQUEST_LIMIT) };
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

// enrichLines (price + pack math) moved to kitchen/enrich.ts in P2 — parallel with a
// connector-level unreachability short-circuit (docs/41 hardening #2).

/** Regenerate auto (pack-merge) + interactive smart suggestions for the draft. */
async function rebuildSuggestions(draft: OrderDraft, d: kitchen.KitchenData): Promise<void> {
  const auto = await enrichLines(draft.lines, d.productMap);
  const smart = await buildSuggestions({
    draft,
    staples: d.staples,
    history: d.orderHistory,
    mutes: d.suggestionMutes,
    now: new Date(),
    search: (q) => mercadona.searchProducts(q),
  });
  draft.suggestions = [...auto, ...smart];
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
          source:
            l.source === 'staple' || l.source === 'manual' || l.source === 'tablet' || l.source === 'regular' ? l.source : 'recipe',
          ...(Array.isArray(l.recipeIds) ? { recipeIds: l.recipeIds.filter((x): x is string => typeof x === 'string') } : {}),
          productId: typeof l.productId === 'string' ? l.productId : null,
          ingredientKey: typeof l.ingredientKey === 'string' ? l.ingredientKey : '',
          label: String(l.label).slice(0, 120),
          qty: typeof l.qty === 'number' && Number.isFinite(l.qty) ? Math.max(0, l.qty) : 1,
          unit: typeof l.unit === 'string' ? l.unit : 'count',
          checked: l.checked !== false,
          ...(l.pantry ? { pantry: true } : {}),
          ...(l.incomparable ? { incomparable: true } : {}),
          // Client-carried price survives only for unmapped lines (mapped ones are
          // recomputed server-side in enrichLines below).
          ...(typeof l.priceEur === 'number' ? { priceEur: l.priceEur } : {}),
        }));
    }
    if (b.status === 'draft' || b.status === 'submitted') current.status = b.status;
    await rebuildSuggestions(current, d);
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
      const recipe = recipesRepo.getFull(day.recipeId); // ingredients needed to explode the order — full fetch by id
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
        // Mixed units were aggregated — surface it so the UI can ask for a human look
        // (docs/41 hardening #3).
        ...(agg.incomparable ? { incomparable: true } : {}),
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
    await rebuildSuggestions(draft, d);
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
        source: 'checklist' as const,
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
    await rebuildSuggestions(d.orderDraft, d);
    draftTotals(d.orderDraft);
    d.orderDraft.updatedAt = ts();
    kitchen.update((k) => {
      k.orderDraft = d.orderDraft;
    });
    return { ts: ts(), entry, draft: d.orderDraft };
  }),
);

// ---- Interactive smart suggestions (P2, docs/41 §3) --------------------------------------------

kitchenRouter.post(
  '/order/suggestions/:id',
  wrap(async (req) => {
    const id = String(req.params.id);
    const action = String((req.body as { action?: unknown })?.action ?? '');
    if (action !== 'confirm' && action !== 'ignore') throw badInput("body.action must be 'confirm' or 'ignore'");
    const d = kitchen.get();
    const draft = d.orderDraft;
    const s = draft.suggestions.find((x) => x.id === id && !x.auto);
    if (!s) throw badInput(`suggestion ${id} not found`);

    if (action === 'ignore') {
      s.state = 'ignored';
      const suppressed = kitchen.update((k) => {
        if (!s.subject) return false;
        const key = muteKey(s.kind, s.subject);
        k.suggestionMutes[key] = (k.suggestionMutes[key] ?? 0) + 1;
        k.orderDraft = draft;
        return isMuted(k.suggestionMutes, s.kind, s.subject);
      });
      return { ts: ts(), draft, suppressed };
    }

    // Confirm — apply to the draft, then re-enrich so prices/packs follow the change.
    applySuggestion(draft, s);
    s.state = 'confirmed';
    const auto = await enrichLines(draft.lines, d.productMap);
    draft.suggestions = [...auto, ...draft.suggestions.filter((x) => !x.auto)];
    draftTotals(draft);
    draft.updatedAt = ts();
    kitchen.update((k) => {
      k.orderDraft = draft;
    });
    logEvent({
      class: 'action',
      category: 'kitchen',
      severity: 'low',
      summary: `Smart suggestion applied (${s.kind}): ${s.text.slice(0, 120)}`,
      trigger: { source: 'user' },
      ok: true,
      data: { kind: s.kind, subject: s.subject },
    });
    return { ts: ts(), draft, suppressed: false };
  }),
);

// ---- Cart fill (P2, docs/41 §2 — THE headline; never touches checkout) --------------------------

kitchenRouter.post(
  '/order/fill-cart',
  blockKiosk,
  wrap(async () => {
    const cfg = store.get().kitchen.mercadona;
    const d = kitchen.get();
    const draft = d.orderDraft;
    const plan = buildCartPlan(draft.lines);
    if (!plan.items.length) throw badInput('no checked, product-mapped lines to send — pick products first');

    // Server-side spend cap: refuse over-cap fills regardless of what the client shows.
    try {
      assertUnderSpendCap(plan, cfg.spendCapEur);
    } catch (e) {
      if (e instanceof SpendCapError) {
        logEvent({
          class: 'action',
          category: 'kitchen',
          severity: 'medium',
          summary: `Cart fill REFUSED — ${plan.totalEur.toFixed(2)} € over the ${cfg.spendCapEur} € spend cap`,
          trigger: { source: 'user' },
          ok: false,
          data: { totalEur: plan.totalEur, capEur: cfg.spendCapEur, items: plan.items.length },
        });
        throw badInput(e.message);
      }
      throw e;
    }

    const payload = { lines: wireLines(plan) };
    const dryRun = cfg.dryRun || !cfg.account;
    if (dryRun) {
      // Build + validate + log the EXACT batched payload — nothing is sent (docs/41).
      logEvent({
        class: 'action',
        category: 'kitchen',
        severity: 'low',
        summary: `Cart fill DRY RUN — ${plan.items.length} products · ${plan.totalEur.toFixed(2)} € (nothing sent)`,
        trigger: { source: 'user' },
        ok: true,
        data: { dryRun: true, payload, totalEur: plan.totalEur, skipped: plan.skipped.length, capEur: cfg.spendCapEur },
      });
      return {
        ts: ts(),
        ok: true,
        dryRun: true,
        linked: Boolean(cfg.account),
        payload,
        items: plan.items,
        skipped: plan.skipped,
        totalEur: plan.totalEur,
        unpricedCount: plan.unpricedCount,
        estimatedCount: plan.estimatedCount,
        capEur: cfg.spendCapEur,
      };
    }

    // REAL fill pre-flight: only the spend cap can refuse here (it's meaningful now —
    // enrich preserves last-known prices as estimates, so totalEur is a REAL total, not
    // the old 0-sum no-op). Unpriced (mapped-but-no-price) lines are genuinely
    // unavailable/obsolete items: buildCartPlan already SKIPPED them out of the payload
    // (skipped, reason 'unpriced'), so they can't hold up the fill — they come back in
    // the response for the user to resolve. The cap still judges the priced total.
    try {
      assertRealFillAllowed(plan, cfg.spendCapEur);
    } catch (e) {
      if (e instanceof SpendCapError) throw badInput(e.message); // belt+braces — already refused above
      throw e;
    }

    // The cart must land on the store we priced against (docs/41 §2).
    const wh = await mercadonaAuth.checkWarehouseMatch(cfg.warehouse);
    if (!wh.ok) {
      throw badInput(
        `the linked account's delivery address (${wh.postalCode ?? '?'}) shops warehouse "${wh.accountWarehouse}", ` +
          `but prices here are for "${cfg.warehouse}" — fix the delivery address or the app's postal code first`,
      );
    }

    const result = await mercadonaAuth.fillCart(payload.lines);
    const now = ts();
    kitchen.update((k) => {
      k.orderDraft.status = 'filled';
      k.orderDraft.pushedAt = now;
      k.orderDraft.updatedAt = now;
    });
    logEvent({
      class: 'action',
      category: 'kitchen',
      severity: 'low',
      summary: `Mercadona cart filled — ${plan.items.length} products · ${plan.totalEur.toFixed(2)} € (human checks out)`,
      trigger: { source: 'user' },
      ok: true,
      data: { items: plan.items.length, totalEur: plan.totalEur, cartLines: result.cartLines, skipped: plan.skipped.length },
    });
    return {
      ts: now,
      ok: true,
      dryRun: false,
      linked: true,
      added: result.added,
      cartLines: result.cartLines,
      items: plan.items,
      skipped: plan.skipped,
      totalEur: plan.totalEur,
      unpricedCount: plan.unpricedCount,
      estimatedCount: plan.estimatedCount,
      capEur: cfg.spendCapEur,
      cartUrl: 'https://tienda.mercadona.es',
    };
  }),
);

// ---- Delivery slots + order status (P2, docs/41 §4 — reads only; booking stays human) -----------

let slotsCache: { at: number; value: unknown } | null = null;
const SLOTS_CACHE_MS = 10 * 60_000;

kitchenRouter.get(
  '/order/slots',
  wrap(async () => {
    const cfg = store.get().kitchen.mercadona;
    if (!cfg.account) return { ts: ts(), linked: false, available: false, slots: [] };
    if (slotsCache && Date.now() - slotsCache.at < SLOTS_CACHE_MS) return slotsCache.value;
    const slots = await mercadonaAuth.getSlots();
    const value = { ts: ts(), linked: true, available: slots !== null, slots: slots ?? [] };
    if (slots !== null) slotsCache = { at: Date.now(), value };
    return value;
  }),
);

// Poll the account's orders once (Groceries open); the hourly coordinator also calls this.
kitchenRouter.post(
  '/order/sync-status',
  wrap(async () => {
    const result = await syncOrderStatus();
    return { ts: ts(), ...result, draft: kitchen.get().orderDraft };
  }),
);

// ---- "My regulars" browser (docs/43 — browse-to-add-to-order, decoupled from staples) ------------

// Read-only: the repeat-purchase history for browsing. Rows are flagged `inDraft` when
// the product is already a line in the current order draft (greyed, not re-addable in
// the UI). Adding a regular goes through PUT /order/draft (source:'regular') — there is
// NO import-to-staples path any more (that dumped all 131 regulars into staples).
kitchenRouter.get(
  '/staples/regulars',
  wrap(async () => {
    const cfg = store.get().kitchen.mercadona;
    if (!cfg.account) return { ts: ts(), linked: false, available: false, products: [] };
    const raw = await mercadonaAuth.getMyRegulars();
    if (raw === null) return { ts: ts(), linked: true, available: false, products: [] };
    const inDraft = new Set(kitchen.get().orderDraft.lines.map((l) => l.productId).filter(Boolean) as string[]);
    // myregulars returns WRAPPER rows { product, recommended_quantity, … } — unwrap
    // .product before normalizing (see kitchen/regulars.ts) and carry the quantity.
    const products = mapRegulars(raw, inDraft);
    return { ts: ts(), linked: true, available: true, products };
  }),
);

// ---- Mercadona account link (P2, docs/41 §1 — token bootstrap, Tesla pattern) ---------------------

// Status is readable by any household member (everything sensitive is masked).
kitchenRouter.get('/mercadona/account', wrap(() => ({ ts: ts(), account: mercadonaAuth.getAccountStatus() })));

kitchenRouter.post(
  '/mercadona/account/link',
  requireAdmin,
  wrap(async (req) => {
    const b = (req.body ?? {}) as { refreshToken?: unknown; customerId?: unknown };
    const token = String(b.refreshToken ?? '').trim();
    if (!token) throw badInput('body.refreshToken required');
    const result = await mercadonaAuth.linkAccount(token, typeof b.customerId === 'string' ? b.customerId : undefined);
    // A working link makes real cart fill available: dry-run off (docs/41 §2). The
    // confirm modal + spend cap still guard every fill; unlink re-arms dry-run.
    store.update((s) => {
      s.kitchen.mercadona.dryRun = false;
    });
    logEvent({
      class: 'action',
      category: 'kitchen',
      severity: 'low',
      summary: `Mercadona account linked${result.label ? ` (${result.label})` : ''}`,
      trigger: { source: 'user' },
      ok: true,
      data: { label: result.label }, // NEVER tokens/ids in the event payload
    });
    return { ts: ts(), ok: true, account: mercadonaAuth.getAccountStatus() };
  }),
);

// Unlink = the kill switch: forgets the tokens and re-arms dry-run.
kitchenRouter.delete(
  '/mercadona/account',
  requireAdmin,
  wrap(() => {
    mercadonaAuth.unlinkAccount();
    slotsCache = null;
    logEvent({
      class: 'action',
      category: 'kitchen',
      severity: 'low',
      summary: 'Mercadona account unlinked — cart fill disabled (kill switch)',
      trigger: { source: 'user' },
      ok: true,
    });
    return { ts: ts(), ok: true, account: mercadonaAuth.getAccountStatus() };
  }),
);

// Guardrail settings: spend cap + dry-run toggle (admin).
kitchenRouter.put(
  '/mercadona/settings',
  requireAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as { spendCapEur?: unknown; dryRun?: unknown };
    store.update((s) => {
      const m = s.kitchen.mercadona;
      if (typeof b.spendCapEur === 'number' && Number.isFinite(b.spendCapEur)) {
        m.spendCapEur = Math.max(10, Math.min(2000, Math.round(b.spendCapEur)));
      }
      if (typeof b.dryRun === 'boolean') m.dryRun = b.dryRun;
    });
    return { ts: ts(), account: mercadonaAuth.getAccountStatus() };
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
        for (const f of ['importParsing', 'cookingSuggestions', 'plannerRequestBox', 'weeklyPlanAssist', 'recipeGeneration'] as const) {
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
