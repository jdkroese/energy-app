// Interactive smart suggestions (P2, docs/41 §3 — the cyan strip in the v4 mockup).
// DETERMINISTIC only — no LLM anywhere near the order. Three kinds:
//   pack    — a bigger pack of the mapped product is cheaper for this week's need
//   merge   — two draft lines resolve to the same product / same fresh ingredient
//   cadence — a staple's typical reorder interval has lapsed but it isn't checked
// Lifecycle: open → (Confirm = applySuggestion mutates the draft) | (Ignore = counted;
// ignored twice for the same (kind, subject) → permanently suppressed via
// kitchen.suggestionMutes — per the PR #190 review guidance).

import { normalizeQty } from './engine';
import type { MercadonaProduct } from '../connectors/mercadona';
import type {
  OrderDraft,
  OrderHistoryEntry,
  OrderLine,
  OrderSuggestion,
  StaplesItem,
} from './types';

export const MUTE_LIMIT = 2;
const MAX_PACK_SEARCHES = 4; // bound the live lookups per rebuild — this is a house, not a crawler
const MIN_PACK_SAVING_EUR = 0.25;

export function muteKey(kind: OrderSuggestion['kind'], subject: string): string {
  return `${kind}:${subject}`;
}

export function isMuted(mutes: Record<string, number>, kind: OrderSuggestion['kind'], subject: string): boolean {
  return (mutes[muteKey(kind, subject)] ?? 0) >= MUTE_LIMIT;
}

export interface SuggestionContext {
  draft: OrderDraft;
  staples: StaplesItem[];
  history: OrderHistoryEntry[];
  mutes: Record<string, number>;
  now: Date;
  /** Live product search for the bigger-pack scan; omit (or null results) → skip that kind. */
  search?: (query: string) => Promise<MercadonaProduct[] | null>;
}

/**
 * Build the open smart suggestions for the current draft. Deterministic given its
 * inputs; previously ignored-in-this-draft subjects keep their ignored state (they
 * don't pop back open on every rebuild), suppressed subjects never regenerate.
 */
export async function buildSuggestions(ctx: SuggestionContext): Promise<OrderSuggestion[]> {
  const prior = new Map<string, OrderSuggestion>();
  for (const s of ctx.draft.suggestions) {
    if (!s.auto && s.subject) prior.set(muteKey(s.kind, s.subject), s);
  }
  const fresh: OrderSuggestion[] = [
    ...(await packSuggestions(ctx)),
    ...mergeSuggestions(ctx),
    ...cadenceSuggestions(ctx),
  ];
  const out: OrderSuggestion[] = [];
  for (const s of fresh) {
    if (!s.subject) continue;
    if (isMuted(ctx.mutes, s.kind, s.subject)) continue; // permanently suppressed
    const before = prior.get(muteKey(s.kind, s.subject));
    if (before?.state === 'ignored') {
      out.push({ ...s, id: before.id, state: 'ignored' });
      continue;
    }
    if (before?.state === 'confirmed') continue; // applied — the condition should be gone; don't re-nag
    out.push({ ...s, ...(before ? { id: before.id } : {}) });
  }
  return out;
}

// ---- (a) Bigger-pack savings ---------------------------------------------------------

async function packSuggestions(ctx: SuggestionContext): Promise<OrderSuggestion[]> {
  if (!ctx.search) return [];
  const out: OrderSuggestion[] = [];
  // Usage support (docs/41): this week already needs ≥2 packs of the mapped product —
  // that IS the demonstrated usage; deterministic and explainable.
  const candidates = ctx.draft.lines.filter(
    (l) => l.checked && l.productId && (l.packsNeeded ?? 0) >= 2 && l.priceEur != null && !isMuted(ctx.mutes, 'pack', l.ingredientKey),
  );
  let searches = 0;
  for (const line of candidates) {
    if (searches >= MAX_PACK_SEARCHES) break;
    searches++;
    const hits = (await ctx.search(line.label)) ?? [];
    const better = bestBiggerPack(line, hits);
    if (!better) continue;
    out.push({
      id: `sugg-pack-${line.id}`,
      kind: 'pack',
      subject: line.ingredientKey,
      text:
        `Bigger pack saves: ${line.label} ${line.packsNeeded}× → ${better.packs}× ${better.product.packSizeDisplay ?? 'larger pack'}` +
        ` = −${better.savingEur.toFixed(2).replace('.', ',')} €`,
      state: 'open',
      apply: {
        action: 'switch-product',
        lineId: line.id,
        productId: better.product.id,
        productName: better.product.name,
        packsNeeded: better.packs,
      },
    });
  }
  return out;
}

/** Cheapest same-unit larger pack that actually saves money for this line's need. */
export function bestBiggerPack(
  line: OrderLine,
  hits: MercadonaProduct[],
): { product: MercadonaProduct; packs: number; savingEur: number } | null {
  if (line.priceEur == null || !line.packsNeeded) return null;
  const need = normalizeQty(line.qty, line.unit);
  let best: { product: MercadonaProduct; packs: number; savingEur: number } | null = null;
  for (const p of hits) {
    if (!p.packSize || p.unitPrice == null || p.id === line.productId) continue;
    const pack = normalizeQty(p.packSize.qty, p.packSize.unit);
    if (pack.unit !== need.unit || pack.qty <= 0) continue;
    const packs = Math.max(1, Math.ceil(need.qty / pack.qty));
    // "Bigger pack": fewer packs than today for the same need.
    if (packs >= line.packsNeeded) continue;
    const cost = Math.round(p.unitPrice * packs * 100) / 100;
    const saving = Math.round((line.priceEur - cost) * 100) / 100;
    if (saving < MIN_PACK_SAVING_EUR) continue;
    if (!best || saving > best.savingEur) best = { product: p, packs, savingEur: saving };
  }
  return best;
}

// ---- (b) Merge duplicates ------------------------------------------------------------

function normalizedMergeKey(key: string): string {
  // Light singular/plural collapse ("tomate"/"tomates") — strip ONE trailing 's';
  // deterministic and safe for the Spanish canonical names the keys are built from.
  return key.endsWith('s') && key.length > 3 ? key.slice(0, -1) : key;
}

export function mergeSuggestions(ctx: Pick<SuggestionContext, 'draft' | 'mutes'>): OrderSuggestion[] {
  const out: OrderSuggestion[] = [];
  const seen = new Set<string>();
  const lines = ctx.draft.lines.filter((l) => l.checked);
  // Same mapped product across separate lines, or near-identical ingredient keys
  // (from-plan already merges exact keys across recipes — this catches the leaks:
  // a manual line duplicating a recipe line, singular/plural drift, staple overlap).
  const groups = new Map<string, OrderLine[]>();
  for (const l of lines) {
    const key = l.productId ? `p:${l.productId}` : l.ingredientKey ? `k:${normalizedMergeKey(l.ingredientKey)}` : `id:${l.id}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  for (const [key, group] of groups) {
    if (group.length < 2 || seen.has(key)) continue;
    seen.add(key);
    const subject = key;
    if (isMuted(ctx.mutes, 'merge', subject)) continue;
    const keep = group.find((l) => l.source === 'recipe') ?? group[0];
    const drop = group.find((l) => l.id !== keep.id);
    if (!drop) continue;
    out.push({
      id: `sugg-merge-${keep.id}-${drop.id}`,
      kind: 'merge',
      subject,
      text: `Buy once: “${keep.label}” and “${drop.label}” are the same buy — one line covers both.`,
      state: 'open',
      apply: { action: 'merge-lines', keepLineId: keep.id, dropLineId: drop.id },
    });
  }
  return out;
}

// ---- (c) Cadence nudge ----------------------------------------------------------------

const FALLBACK_CADENCE_DAYS: Record<StaplesItem['cadence'], number> = { weekly: 7, biweekly: 14, monthly: 30 };

/** Typical reorder interval for a staple from the order history (median gap), else its configured cadence. */
export function typicalIntervalDays(staple: StaplesItem, history: OrderHistoryEntry[]): number {
  const key = `staple:${staple.id}`;
  const dates = history
    .filter((h) => h.lines.some((l) => l.ingredientKey === key))
    .map((h) => new Date(h.date).getTime())
    .sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 86_400_000);
  if (gaps.length < 2) return FALLBACK_CADENCE_DAYS[staple.cadence];
  gaps.sort((a, b) => a - b);
  return Math.max(3, Math.round(gaps[Math.floor(gaps.length / 2)]));
}

export function cadenceSuggestions(
  ctx: Pick<SuggestionContext, 'draft' | 'staples' | 'history' | 'mutes' | 'now'>,
): OrderSuggestion[] {
  const out: OrderSuggestion[] = [];
  for (const s of ctx.staples) {
    if (!s.lastOrderedAt) continue; // never ordered → the due logic already checks it
    if (isMuted(ctx.mutes, 'cadence', s.id)) continue;
    const line = ctx.draft.lines.find((l) => l.ingredientKey === `staple:${s.id}`);
    if (!line || line.checked) continue; // nothing to nudge — it's already in the basket
    const interval = typicalIntervalDays(s, ctx.history);
    const days = Math.floor((ctx.now.getTime() - new Date(s.lastOrderedAt).getTime()) / 86_400_000);
    if (days <= interval * 1.25) continue; // give the household a 25% grace window
    out.push({
      id: `sugg-cadence-${s.id}`,
      kind: 'cadence',
      subject: s.id,
      text: `Running low? ${s.name} usually goes every ~${interval} days — it's been ${days}.`,
      state: 'open',
      apply: { action: 'check-line', lineId: line.id },
    });
  }
  return out;
}

// ---- Apply (Confirm) --------------------------------------------------------------------

/** Mutate the draft per the suggestion's apply payload. Returns false when the target
 *  lines are gone (stale suggestion) — the caller then just marks it confirmed. */
export function applySuggestion(draft: OrderDraft, s: OrderSuggestion): boolean {
  const ap = s.apply;
  if (!ap) return false;
  switch (ap.action) {
    case 'switch-product': {
      const line = draft.lines.find((l) => l.id === ap.lineId);
      if (!line) return false;
      line.productId = ap.productId;
      // Enrichment recomputes packs/price against the new product right after.
      delete line.packsNeeded;
      delete line.coverageNote;
      line.priceEur = null;
      return true;
    }
    case 'merge-lines': {
      const keep = draft.lines.find((l) => l.id === ap.keepLineId);
      const drop = draft.lines.find((l) => l.id === ap.dropLineId);
      if (!keep || !drop) return false;
      const a = normalizeQty(keep.qty, keep.unit);
      const b = normalizeQty(drop.qty, drop.unit);
      if (a.unit === b.unit) {
        keep.qty = Math.round((a.qty + b.qty) * 100) / 100;
        keep.unit = a.unit;
      } else {
        keep.incomparable = true; // mixed units — merged anyway, flag for a human look
      }
      keep.recipeIds = [...new Set([...(keep.recipeIds ?? []), ...(drop.recipeIds ?? [])])];
      keep.checked = keep.checked || drop.checked;
      draft.lines = draft.lines.filter((l) => l.id !== drop.id);
      keep.priceEur = null; // re-enriched right after
      return true;
    }
    case 'check-line': {
      const line = draft.lines.find((l) => l.id === ap.lineId);
      if (!line) return false;
      line.checked = true;
      return true;
    }
  }
}
