// AI recipe generation (docs/43): the DISCOVERY front door. Claude generates a few
// COMPLETE, structured candidate recipes that already fit the household; the owner picks
// the one(s) they like and saves them INTO the library (via the existing POST /recipes),
// where the deterministic planner / groceries / cooking pipelines take over. The library
// stays the structured substrate; AI is the on-ramp.
//
// This module is PURE (no Claude I/O, no store I/O) so it's unit-testable:
//  - buildGeneratePrompt(): composes the household-aware system+user prompt.
//  - sanitizeGenerated(): clamps ONE untrusted LLM recipe into a valid Recipe-shape
//    (source:'ai', photo:null, nutrition.estimated=true) — the same clamp discipline as
//    routes/kitchen.ts sanitizeRecipe, minus id/timestamps (assigned by the route).
//  - dropForbidden(): belt-and-braces hard filter — any candidate still naming an
//    allergen / diet-restriction ingredient is removed (the model is TOLD never to use
//    them; this guarantees it).

import { forbiddenKeywords, recipeHasForbidden } from './engine';
import type { Cuisine, Household, Recipe, Season } from './types';

const CUISINES: Cuisine[] = ['spanish', 'dutch', 'japanese', 'italian', 'global'];
const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];

/** The unsaved candidate: a full Recipe shape with a temporary gen_<n> id, no timestamps. */
export type GeneratedRecipe = Omit<Recipe, 'createdAt' | 'updatedAt'>;

export function clampCount(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : 3;
  return Math.max(2, Math.min(4, n));
}

/**
 * Clamp ONE untrusted generated recipe into a valid candidate. Returns null when it can't
 * be salvaged (no title, or no usable ingredient/step at all — a blob we can't plan/order).
 */
export function sanitizeGenerated(raw: unknown, index: number): GeneratedRecipe | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const title = String(b.title ?? '').trim();
  if (!title) return null;

  const cuisine: Cuisine = CUISINES.includes(b.cuisine as Cuisine) ? (b.cuisine as Cuisine) : 'global';

  const ingredients = Array.isArray(b.ingredients)
    ? b.ingredients
        .filter((i) => i && typeof i === 'object' && typeof (i as { es?: unknown }).es === 'string' && (i as { es: string }).es.trim())
        .map((i) => {
          const ing = i as Record<string, unknown>;
          const es = String(ing.es).trim();
          return {
            name: String(ing.name ?? es).trim() || es,
            es,
            qty: typeof ing.qty === 'number' && Number.isFinite(ing.qty) && ing.qty > 0 ? ing.qty : null,
            unit: typeof ing.unit === 'string' && ing.unit.trim() ? ing.unit.trim() : 'count',
            ...(ing.pantryStaple ? { pantryStaple: true as const } : {}),
          };
        })
        .slice(0, 40)
    : [];
  if (!ingredients.length) return null; // can't order a recipe with no ingredients

  const steps = Array.isArray(b.steps)
    ? b.steps
        .filter((s) => s && typeof (s as { text?: unknown }).text === 'string' && (s as { text: string }).text.trim())
        .map((s) => {
          const st = s as Record<string, unknown>;
          return {
            phase: st.phase === 'mise' ? ('mise' as const) : ('cook' as const),
            text: String(st.text).trim().slice(0, 600),
            ...(typeof st.timerSec === 'number' && Number.isFinite(st.timerSec) && st.timerSec > 0
              ? { timerSec: Math.round(st.timerSec) }
              : {}),
          };
        })
        .slice(0, 30)
    : [];
  if (!steps.length) return null; // can't cook a recipe with no steps

  const n = (b.nutrition ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

  const season = Array.isArray(b.season)
    ? (b.season.filter((s): s is Season => SEASONS.includes(s as Season)) as Season[])
    : undefined;

  return {
    id: `gen_${index}`,
    title: title.slice(0, 120),
    photo: null, // illustrated card until an image provider exists (docs/43)
    source: 'ai',
    servingsBase:
      typeof b.servingsBase === 'number' && b.servingsBase > 0 ? Math.min(24, Math.round(b.servingsBase)) : 4,
    prepMin: typeof b.prepMin === 'number' && b.prepMin >= 0 ? Math.min(600, Math.round(b.prepMin)) : 15,
    cookMin: typeof b.cookMin === 'number' && b.cookMin >= 0 ? Math.min(600, Math.round(b.cookMin)) : 30,
    tags: Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === 'string').slice(0, 12) : [],
    cuisine,
    ...(typeof b.kidScore === 'number' && Number.isFinite(b.kidScore)
      ? { kidScore: Math.max(0, Math.min(1, b.kidScore)) }
      : {}),
    ...(season && season.length ? { season } : {}),
    nutrition: {
      kcal: num(n.kcal),
      proteinG: num(n.proteinG),
      carbsG: num(n.carbsG),
      fatG: num(n.fatG),
      estimated: true, // always AI-estimated (docs/43)
    },
    tools: Array.isArray(b.tools) ? b.tools.filter((t): t is string => typeof t === 'string').slice(0, 12) : [],
    ingredients,
    steps,
    lastCookedAt: null,
  };
}

/**
 * Belt-and-braces hard filter: drop any candidate that still names an allergen or
 * diet-restriction ingredient after generation. The model is instructed never to use
 * them (see buildGeneratePrompt) — this guarantees it regardless of what came back.
 */
export function dropForbidden<T extends Pick<Recipe, 'title' | 'ingredients'>>(
  recipes: T[],
  h: Pick<Household, 'allergies' | 'dietRestrictions'>,
): T[] {
  return recipes.filter((r) => !recipeHasForbidden(r, h));
}

/** Parse + sanitize + hard-filter a raw {recipes:[…]} payload. Renumbers ids gen_0..n. */
export function sanitizeGeneratedBatch(
  raw: { recipes?: unknown } | null | undefined,
  household: Pick<Household, 'allergies' | 'dietRestrictions'>,
): GeneratedRecipe[] {
  const list = Array.isArray(raw?.recipes) ? raw!.recipes : [];
  const cleaned = list
    .map((r, i) => sanitizeGenerated(r, i))
    .filter((r): r is GeneratedRecipe => r !== null);
  const kept = dropForbidden(cleaned, household);
  // Renumber so ids are contiguous gen_0..n after any drops (stable candidate keys).
  return kept.map((r, i) => ({ ...r, id: `gen_${i}` }));
}

// ---- Prompt --------------------------------------------------------------------------

/** A short signature of the household prefs that steer generation — the cache key input. */
export function householdSignature(h: Household): string {
  const weights = CUISINES.map((c) => `${c}${h.cuisineWeights[c] ?? 50}`).join('');
  return [
    `a${h.adults}k${h.kids}`,
    `al:${[...h.allergies].sort().join(',')}`,
    `dr:${[...(h.dietRestrictions ?? [])].sort().join(',')}`,
    `dl:${[...h.dislikes].sort().join(',')}`,
    `lo:${[...h.loves].sort().join(',')}`,
    weights,
    `g:${h.goals.mode ?? '-'}:${h.goals.kcalPerDinner ?? '-'}`,
  ].join('|');
}

export const GENERATE_SYSTEM =
  'You invent a few COMPLETE home dinner recipes for a specific household. Output ONLY JSON ' +
  '{"recipes":[…]} — no prose, no markdown fences. Each recipe MUST have: ' +
  'title (short), cuisine (one of spanish|dutch|japanese|italian|global), ' +
  'ingredients (array of {name (English), es (the canonical Spanish grocery name, e.g. "calabacín", "pechuga de pollo", ' +
  'used verbatim for Mercadona search), qty (number or null for "to taste"), unit ("g"|"kg"|"ml"|"l"|"count"|"tbsp"|"clove"|… ), ' +
  'pantryStaple (true for oil/salt/common cupboard basics)}), ' +
  'steps (array of {phase:"mise"|"cook", text, timerSec (optional seconds)}), ' +
  'nutrition ({kcal,proteinG,carbsG,fatG} per serving, best estimate), ' +
  'prepMin, cookMin, servingsBase (default 4), tags (array), kidScore (0..1), season (subset of spring|summer|autumn|winter). ' +
  'Doable weeknight home food; real quantities; assume common pantry staples exist. Prefer variety across the set.';

/** The household-aware user prompt: the ask + hard/soft constraints. */
export function buildGeneratePrompt(opts: {
  question?: string;
  ingredients?: string[];
  count: number;
  household: Household;
}): string {
  const { question, ingredients, count, household: h } = opts;
  const forbidden = forbiddenKeywords(h);
  const lines: string[] = [`Invent ${count} complete recipes.`];
  if (question && question.trim()) lines.push(`Request: ${question.trim()}`);
  if (ingredients && ingredients.length) lines.push(`Use mainly what's on hand: ${ingredients.join(', ')}.`);
  lines.push(`Cooking for ${h.adults} adult${h.adults === 1 ? '' : 's'}${h.kids > 0 ? ` + ${h.kids} kid${h.kids === 1 ? '' : 's'}` : ''}.`);
  if (forbidden.length) {
    lines.push(
      `NEVER use these ingredients or anything containing them (allergies / diet — HARD rule): ${[...new Set(forbidden)].join(', ')}.`,
    );
  }
  if (h.dislikes.length) lines.push(`Avoid if you can (disliked): ${h.dislikes.join(', ')}.`);
  if (h.loves.length) lines.push(`Bonus if it features: ${h.loves.join(', ')}.`);
  if (h.kids > 0) lines.push('Keep it kid-friendly.');
  const topCuisines = CUISINES.filter((c) => (h.cuisineWeights[c] ?? 50) >= 60);
  if (topCuisines.length) lines.push(`Lean toward these cuisines when it fits: ${topCuisines.join(', ')}.`);
  if (h.goals.kcalPerDinner) lines.push(`Aim near ${h.goals.kcalPerDinner} kcal per serving${h.goals.mode ? ` (${h.goals.mode})` : ''}.`);
  return lines.join('\n');
}
