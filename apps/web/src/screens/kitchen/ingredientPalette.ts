// Ingredient palette for "What can I make with…" (P3, docs/42) — a tap-to-add list of
// common ingredients grouped into a few sections. Sourced from the recipe library's own
// ingredients (most-frequent first, deduped by a normalised key — a client mirror of the
// server's normalizeIngredientText) BLENDED with a curated common-Spanish-kitchen fallback
// so the palette is useful even with a thin library. Pure + unit-tested (frequency+dedup).

import type { Recipe } from '../../lib/types';
// Only `.ingredients` is read here — RecipeSlim (P2, docs/46 §2a) is a strict superset for
// this purpose, so accepting Pick<Recipe,'ingredients'> works for both Recipe[] and
// RecipeSlim[] callers without pulling in the full Recipe shape (steps included).
type IngredientsOnly = Pick<Recipe, 'ingredients'>;

/** Lower-case, accent-stripped — client mirror of api normalizeIngredientText. */
export function normalizeIngredientText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export type PaletteSection =
  | 'Vegetables'
  | 'Proteins'
  | 'Carbs & grains'
  | 'Dairy & eggs'
  | 'Pantry';

export interface PaletteItem {
  /** Display label (the term added as a chip when tapped). */
  label: string;
  /** Normalised key for dedup + selected-state matching. */
  key: string;
  section: PaletteSection;
}

const SECTION_ORDER: PaletteSection[] = ['Vegetables', 'Proteins', 'Carbs & grains', 'Dairy & eggs', 'Pantry'];

// A curated ~30-item common-Spanish-kitchen fallback so the palette is useful even when the
// library is thin. English labels (the app's UI language); the coverage matcher already
// bridges to the Spanish ingredient names token-for-token.
const CURATED: Array<[string, PaletteSection]> = [
  ['Onion', 'Vegetables'],
  ['Garlic', 'Vegetables'],
  ['Tomato', 'Vegetables'],
  ['Courgette', 'Vegetables'],
  ['Pepper', 'Vegetables'],
  ['Carrot', 'Vegetables'],
  ['Potato', 'Vegetables'],
  ['Spinach', 'Vegetables'],
  ['Mushroom', 'Vegetables'],
  ['Broccoli', 'Vegetables'],
  ['Chicken', 'Proteins'],
  ['Beef', 'Proteins'],
  ['Pork', 'Proteins'],
  ['Salmon', 'Proteins'],
  ['Prawns', 'Proteins'],
  ['Chickpeas', 'Proteins'],
  ['Lentils', 'Proteins'],
  ['Tofu', 'Proteins'],
  ['Rice', 'Carbs & grains'],
  ['Pasta', 'Carbs & grains'],
  ['Bread', 'Carbs & grains'],
  ['Flour', 'Carbs & grains'],
  ['Potatoes', 'Carbs & grains'],
  ['Milk', 'Dairy & eggs'],
  ['Eggs', 'Dairy & eggs'],
  ['Cheese', 'Dairy & eggs'],
  ['Yoghurt', 'Dairy & eggs'],
  ['Butter', 'Dairy & eggs'],
  ['Olive oil', 'Pantry'],
  ['Salt', 'Pantry'],
  ['Tomato sauce', 'Pantry'],
  ['Stock', 'Pantry'],
];

/** Crude section guess for a library ingredient name (English + Spanish tokens). */
function guessSection(text: string): PaletteSection {
  const t = normalizeIngredientText(text);
  const has = (...words: string[]) => words.some((w) => t.includes(w));
  if (has('chicken', 'pollo', 'beef', 'ternera', 'vacuno', 'pork', 'cerdo', 'fish', 'pescado', 'salmon', 'atun', 'tuna', 'prawn', 'gamba', 'shrimp', 'tofu', 'chickpea', 'garbanzo', 'lentil', 'lenteja', 'bean', 'alubia', 'judia', 'egg', 'huevo', 'bacon', 'ham', 'jamon', 'sausage', 'chorizo'))
    return has('egg', 'huevo') ? 'Dairy & eggs' : 'Proteins';
  if (has('milk', 'leche', 'cheese', 'queso', 'yog', 'yoghurt', 'butter', 'mantequilla', 'cream', 'nata', 'egg', 'huevo'))
    return 'Dairy & eggs';
  if (has('rice', 'arroz', 'pasta', 'noodle', 'fideo', 'bread', 'pan', 'flour', 'harina', 'potato', 'patata', 'quinoa', 'couscous', 'cuscus', 'oat', 'avena'))
    return 'Carbs & grains';
  if (has('oil', 'aceite', 'salt', 'sal', 'pepper corn', 'pimienta', 'stock', 'caldo', 'sauce', 'salsa', 'vinegar', 'vinagre', 'sugar', 'azucar', 'spice', 'especia', 'sofrito', 'paprika', 'pimenton'))
    return 'Pantry';
  return 'Vegetables';
}

/**
 * Build the palette: rank the library's own ingredients by frequency (dedup by normalised
 * key, most-frequent first), blend in the curated fallback (curated items that aren't
 * already present get appended so every section stays useful). Deterministic: frequency
 * desc, then first-seen order; ties broken by insertion order (stable sort).
 */
export function buildPalette(recipes: IngredientsOnly[], perSection = 8): PaletteItem[] {
  interface Agg {
    label: string;
    key: string;
    count: number;
    order: number;
    section: PaletteSection;
  }
  const byKey = new Map<string, Agg>();
  // Guards a curated item against duplicating a library item that only matched on the
  // Spanish key ("cebolla") while sharing the English label ("Onion").
  const labels = new Set<string>();
  let order = 0;
  for (const r of recipes) {
    for (const ing of r.ingredients ?? []) {
      // Prefer the English display name for the chip label; fall back to Spanish.
      const label = (ing.name || ing.es || '').trim();
      if (!label) continue;
      const key = normalizeIngredientText(ing.es || ing.name);
      if (!key) continue;
      const prev = byKey.get(key);
      if (prev) {
        prev.count++;
      } else {
        byKey.set(key, { label, key, count: 1, order: order++, section: guessSection(`${ing.name} ${ing.es}`) });
        labels.add(normalizeIngredientText(label));
      }
    }
  }
  // Blend curated fallbacks in (only those not already present by Spanish key OR English label).
  for (const [label, section] of CURATED) {
    const key = normalizeIngredientText(label);
    if (byKey.has(key) || labels.has(key)) continue;
    byKey.set(key, { label, key, count: 0, order: order++, section });
    labels.add(key);
  }

  const all = [...byKey.values()].sort((a, b) => b.count - a.count || a.order - b.order);

  // Cap each section to keep the palette scannable; preserve the frequency ranking.
  const perSectionCount = new Map<PaletteSection, number>();
  const picked: PaletteItem[] = [];
  for (const a of all) {
    const n = perSectionCount.get(a.section) ?? 0;
    if (n >= perSection) continue;
    perSectionCount.set(a.section, n + 1);
    picked.push({ label: a.label, key: a.key, section: a.section });
  }
  // Order by section, then keep within-section frequency order (picked is already freq-sorted).
  return picked.sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section));
}

export { SECTION_ORDER };
