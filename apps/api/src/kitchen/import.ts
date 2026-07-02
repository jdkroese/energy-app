// Recipe URL import (docs/39 "Recipe import"): fetch server-side → parse
// schema.org/Recipe JSON-LD (most sites embed it) → normalize into our model.
// If Intelligence is ON and JSON-LD is missing/incomplete, ONE Claude call extracts
// the recipe. Fails soft to a manual-entry prefill — never throws to the route.

import * as claude from '../connectors/claude';
import { guardedFetch, SsrfBlockedError } from './ssrf';
import type { Cuisine, Recipe, RecipeIngredient, RecipeStep } from './types';

const TIMEOUT_MS = 10_000;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface ImportResult {
  ok: boolean;
  /** Fully-parsed recipe (without id/timestamps) when ok. */
  recipe?: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;
  /** Manual-entry prefill when parsing failed (title/photo best-effort). */
  prefill?: { title?: string; photo?: string | null; sourceUrl: string };
  detail?: string;
}

// ---- HTML fetch -------------------------------------------------------------------

/** SSRF-guarded HTML fetch (docs/41 hardening #1): the hostname must resolve to a
 *  public address, and every redirect hop is re-checked (guardedFetch). A blocked
 *  URL throws SsrfBlockedError so the route can answer with the real reason. */
async function fetchHtml(url: string): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await guardedFetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html') && !type.includes('text')) return null;
    return await res.text();
  } catch (e) {
    if (e instanceof SsrfBlockedError) throw e;
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- JSON-LD extraction -------------------------------------------------------------

interface LdRecipe {
  '@type'?: string | string[];
  name?: string;
  image?: unknown;
  recipeYield?: string | number | Array<string | number>;
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  recipeIngredient?: string[];
  recipeInstructions?: unknown;
  recipeCuisine?: string | string[];
  keywords?: string | string[];
  nutrition?: { calories?: string; proteinContent?: string; carbohydrateContent?: string; fatContent?: string };
  [key: string]: unknown;
}

function isRecipeNode(node: unknown): node is LdRecipe {
  if (!node || typeof node !== 'object') return false;
  const t = (node as LdRecipe)['@type'];
  return t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
}

/** Pull every JSON-LD block and hunt for a Recipe node (handles @graph + arrays). */
export function extractJsonLdRecipe(html: string): LdRecipe | null {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(b[1].trim());
    } catch {
      continue;
    }
    const queue: unknown[] = [parsed];
    while (queue.length) {
      const node = queue.shift();
      if (isRecipeNode(node)) return node;
      if (Array.isArray(node)) queue.push(...node);
      else if (node && typeof node === 'object') {
        const g = (node as { '@graph'?: unknown })['@graph'];
        if (Array.isArray(g)) queue.push(...g);
      }
    }
  }
  return null;
}

function firstImage(image: unknown): string | null {
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return firstImage(image[0]);
  if (image && typeof image === 'object') {
    const u = (image as { url?: unknown }).url;
    if (typeof u === 'string') return u;
  }
  return null;
}

/** ISO-8601 duration (PT1H30M) → minutes. */
export function durationMin(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return null;
  const mins = (Number(m[1]) || 0) * 1440 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  return mins > 0 ? mins : null;
}

function parseYield(y: LdRecipe['recipeYield']): number {
  const v = Array.isArray(y) ? y[0] : y;
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 && n <= 24 ? n : 4;
}

function instructionTexts(ins: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      const t = node.replace(/<[^>]+>/g, '').trim();
      if (t) out.push(t);
    } else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      const o = node as { text?: unknown; itemListElement?: unknown; name?: unknown };
      if (typeof o.text === 'string') walk(o.text);
      else if (o.itemListElement) walk(o.itemListElement);
      else if (typeof o.name === 'string') walk(o.name);
    }
  };
  walk(ins);
  return out;
}

/** "200 g arroz" / "2 cucharadas de aceite" / "1 onion, diced" → {qty, unit, name}. */
export function parseIngredientLine(line: string): RecipeIngredient {
  const clean = line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const m = clean.match(/^([\d.,/½¼¾⅓⅔]+)\s*(kg|g|gr|gramos|ml|l|litros?|cl|tbsp|tsp|cucharadas?|cucharaditas?|cups?|tazas?|dientes?|cloves?|unidades?|uds?\.?)?\s*(?:de\s+)?(.+)$/i);
  if (!m) return { name: clean, es: clean, qty: null, unit: 'to taste' };
  const qty = parseAmount(m[1]);
  let unit = (m[2] ?? 'count').toLowerCase();
  if (unit === 'gr' || unit === 'gramos') unit = 'g';
  if (unit.startsWith('litro')) unit = 'l';
  if (unit === 'cl') unit = 'ml';
  if (unit.startsWith('cucharad') || unit.startsWith('cup') || unit.startsWith('taza')) unit = 'tbsp';
  if (unit.startsWith('diente') || unit.startsWith('clove')) unit = 'clove';
  if (unit.startsWith('unidad') || unit.startsWith('ud')) unit = 'count';
  const name = m[3].trim();
  return { name, es: name, qty, unit };
}

function parseAmount(s: string): number | null {
  const map: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };
  if (map[s] != null) return map[s];
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    if (a && b) return a / b;
  }
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function kcalFromNutrition(n: LdRecipe['nutrition']): Recipe['nutrition'] | undefined {
  if (!n) return undefined;
  const num = (s?: string) => {
    const v = parseFloat(String(s ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(v) ? v : 0;
  };
  const kcal = num(n.calories);
  if (!kcal) return undefined;
  return { kcal: Math.round(kcal), proteinG: Math.round(num(n.proteinContent)), carbsG: Math.round(num(n.carbohydrateContent)), fatG: Math.round(num(n.fatContent)), estimated: true };
}

function guessCuisine(ld: LdRecipe): Cuisine {
  const raw = [ld.recipeCuisine, ld.keywords]
    .flat()
    .filter((x): x is string => typeof x === 'string')
    .join(' ')
    .toLowerCase();
  if (/spanish|españa|español/.test(raw)) return 'spanish';
  if (/dutch|nederland|holland/.test(raw)) return 'dutch';
  if (/japan/.test(raw)) return 'japanese';
  if (/ital/.test(raw)) return 'italian';
  return 'global';
}

function fromJsonLd(ld: LdRecipe, url: string): ImportResult['recipe'] | null {
  const title = typeof ld.name === 'string' ? ld.name.trim() : '';
  const ingredients = Array.isArray(ld.recipeIngredient) ? ld.recipeIngredient.filter((x) => typeof x === 'string') : [];
  const steps = instructionTexts(ld.recipeInstructions);
  if (!title || ingredients.length === 0 || steps.length === 0) return null;
  const prep = durationMin(ld.prepTime);
  const cook = durationMin(ld.cookTime) ?? durationMin(ld.totalTime);
  const stepObjs: RecipeStep[] = steps.map((text, i) => ({
    // Heuristic phase tagging: the first ~third of steps (chop/mix/marinate) = mise.
    phase: i < Math.max(1, Math.floor(steps.length / 3)) ? 'mise' : 'cook',
    text,
  }));
  return {
    title,
    photo: firstImage(ld.image),
    source: 'url',
    sourceUrl: url,
    servingsBase: parseYield(ld.recipeYield),
    prepMin: prep ?? 15,
    cookMin: cook ?? 30,
    tags: ['imported'],
    cuisine: guessCuisine(ld),
    ...(kcalFromNutrition(ld.nutrition) ? { nutrition: kcalFromNutrition(ld.nutrition) } : {}),
    tools: [],
    ingredients: ingredients.map(parseIngredientLine),
    steps: stepObjs,
    lastCookedAt: null,
  };
}

// ---- Claude fallback (Intelligence D2 — one call, small max_tokens) -----------------

interface LlmRecipe {
  title?: string;
  servings?: number;
  prepMin?: number;
  cookMin?: number;
  cuisine?: string;
  ingredients?: Array<{ name?: string; es?: string; qty?: number | null; unit?: string }>;
  steps?: Array<{ phase?: string; text?: string }>;
  tools?: string[];
  nutrition?: { kcal?: number; proteinG?: number; carbsG?: number; fatG?: number };
}

async function fromClaude(html: string, url: string): Promise<ImportResult['recipe'] | null> {
  if (!claude.isFeatureEnabled('importParsing')) return null;
  // Strip tags/scripts and clamp the page to keep the call small.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 14_000);
  const parsed = await claude.completeJSON<LlmRecipe>({
    system:
      'You extract recipes into strict JSON. Output ONLY a JSON object with keys: title, servings (number), ' +
      'prepMin, cookMin, cuisine (one of spanish|dutch|japanese|italian|global), ' +
      'ingredients (array of {name, es, qty, unit} — es is the canonical Spanish supermarket name; qty null when "to taste"; unit one of g|kg|ml|l|count|tbsp|tsp|clove|bunch), ' +
      'steps (array of {phase, text} — phase "mise" for prep tasks, "cook" for cooking), ' +
      'tools (array of strings), nutrition ({kcal, proteinG, carbsG, fatG} per serving, best estimate).',
    prompt: `Extract the recipe from this page text:\n\n${text}`,
    maxTokens: 2500,
  });
  if (!parsed?.title || !Array.isArray(parsed.ingredients) || !parsed.ingredients.length) return null;
  const cuisine: Cuisine = (['spanish', 'dutch', 'japanese', 'italian', 'global'] as Cuisine[]).includes(
    parsed.cuisine as Cuisine,
  )
    ? (parsed.cuisine as Cuisine)
    : 'global';
  return {
    title: parsed.title,
    photo: ogImage(html),
    source: 'url',
    sourceUrl: url,
    servingsBase: typeof parsed.servings === 'number' && parsed.servings > 0 ? Math.min(24, parsed.servings) : 4,
    prepMin: typeof parsed.prepMin === 'number' ? parsed.prepMin : 15,
    cookMin: typeof parsed.cookMin === 'number' ? parsed.cookMin : 30,
    tags: ['imported'],
    cuisine,
    ...(parsed.nutrition?.kcal
      ? {
          nutrition: {
            kcal: Math.round(parsed.nutrition.kcal),
            proteinG: Math.round(parsed.nutrition.proteinG ?? 0),
            carbsG: Math.round(parsed.nutrition.carbsG ?? 0),
            fatG: Math.round(parsed.nutrition.fatG ?? 0),
            estimated: true,
          },
        }
      : {}),
    tools: Array.isArray(parsed.tools) ? parsed.tools.filter((t): t is string => typeof t === 'string') : [],
    ingredients: parsed.ingredients.map((i) => ({
      name: String(i.name ?? '').trim() || 'Ingredient',
      es: String(i.es ?? i.name ?? '').trim() || 'ingrediente',
      qty: typeof i.qty === 'number' ? i.qty : null,
      unit: String(i.unit ?? 'count'),
    })),
    steps: (parsed.steps ?? [])
      .filter((s): s is { phase?: string; text: string } => typeof s?.text === 'string' && s.text.length > 0)
      .map((s) => ({ phase: s.phase === 'mise' ? 'mise' : 'cook', text: s.text })),
    lastCookedAt: null,
  };
}

function ogImage(html: string): string | null {
  const m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? m[1] : null;
}

function ogTitle(html: string): string | undefined {
  const m =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : undefined;
}

// ---- Entry point ---------------------------------------------------------------------

export async function importRecipeFromUrl(url: string): Promise<ImportResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('bad protocol');
  } catch {
    return { ok: false, prefill: { sourceUrl: url }, detail: 'not a valid URL' };
  }
  let html: string | null;
  try {
    html = await fetchHtml(parsedUrl.toString());
  } catch (e) {
    // SSRF guard tripped — tell the user why instead of a generic "unreachable".
    return { ok: false, prefill: { sourceUrl: url }, detail: (e as Error).message };
  }
  if (!html) return { ok: false, prefill: { sourceUrl: url }, detail: 'page unreachable' };

  // 1) schema.org/Recipe JSON-LD — the deterministic path, works without Intelligence.
  const ld = extractJsonLdRecipe(html);
  if (ld) {
    const recipe = fromJsonLd(ld, url);
    if (recipe) return { ok: true, recipe };
  }

  // 2) Intelligence ON → one Claude extraction call.
  const viaClaude = await fromClaude(html, url);
  if (viaClaude) return { ok: true, recipe: viaClaude };

  // 3) Fail soft: manual-entry prefill with whatever the page tells us.
  return {
    ok: false,
    prefill: { title: ogTitle(html), photo: ogImage(html), sourceUrl: url },
    detail: ld ? 'JSON-LD present but incomplete' : 'no structured recipe found',
  };
}
