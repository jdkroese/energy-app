// "What can I make with…" (P3, docs/38 §2 Loop C) — DETERMINISTIC ingredient-coverage
// ranking over the recipe library. No LLM here: normalise the on-hand terms, match them
// against each recipe's ingredients (pantry staples count as always available), rank by
// % coverage. The Claude "More ideas" path lives in routes/kitchen.ts behind the
// Intelligence master + cooking-suggestions toggles and fails soft to this list.

import type { Recipe, RecipeIngredient } from './types';

/** Lower-case, accent-stripped — same normalisation as the mapping-memory key. */
export function normalizeIngredientText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Light singular collapse ("tomates" → "tomate") — the merge suggester's rule. */
function singular(word: string): string {
  return word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word;
}

/** Meaningful word tokens of a term ("chicken thighs, boneless" → chicken·thigh·boneles). */
function tokens(s: string): string[] {
  return normalizeIngredientText(s)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length > 2)
    .map(singular);
}

/**
 * True when an on-hand term names this ingredient: every token of the term appears
 * in the ingredient's (name + Spanish name) token set. "rice" hits "Round/bomba rice";
 * "chicken thighs" hits "Chicken thighs, boneless"; "beef" does NOT hit "chicken".
 */
export function termMatchesIngredient(term: string, ing: Pick<RecipeIngredient, 'name' | 'es'>): boolean {
  const t = tokens(term);
  if (!t.length) return false;
  const bag = new Set([...tokens(ing.name), ...tokens(ing.es)]);
  return t.every((w) => bag.has(w));
}

export interface CoverageResult {
  recipeId: string;
  /** Ingredients available: matched on-hand + pantry staples. */
  have: number;
  total: number;
  /** Non-pantry ingredients matched by the on-hand terms (the "real" hits). */
  matchedFresh: number;
  /** Display names of the ingredients still missing. */
  missing: string[];
}

/**
 * Rank the library by ingredient coverage for a set of on-hand terms. Pantry staples
 * always count as available (docs/38: oil/salt/rice-in-the-cupboard shouldn't sink a
 * match), but at least one NON-pantry ingredient must match — pantry alone isn't
 * "I can make this with what's on hand". Deterministic: coverage desc, real hits desc,
 * fewer missing first, id as the final tie-break.
 */
export function rankRecipesByCoverage(recipes: Recipe[], onHand: string[], limit = 8): CoverageResult[] {
  const terms = onHand.map((s) => s.trim()).filter(Boolean);
  if (!terms.length) return [];
  const scored: CoverageResult[] = [];
  for (const r of recipes) {
    if (!r.ingredients.length) continue;
    let have = 0;
    let matchedFresh = 0;
    const missing: string[] = [];
    for (const ing of r.ingredients) {
      const matched = terms.some((t) => termMatchesIngredient(t, ing));
      if (matched && !ing.pantryStaple) matchedFresh++;
      if (matched || ing.pantryStaple) have++;
      else missing.push(ing.name);
    }
    if (matchedFresh === 0) continue;
    scored.push({ recipeId: r.id, have, total: r.ingredients.length, matchedFresh, missing });
  }
  scored.sort(
    (a, b) =>
      b.have / b.total - a.have / a.total ||
      b.matchedFresh - a.matchedFresh ||
      a.missing.length - b.missing.length ||
      a.recipeId.localeCompare(b.recipeId),
  );
  return scored.slice(0, limit);
}
