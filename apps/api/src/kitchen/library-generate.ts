// Bulk recipe-library generation (docs/46 §2c) — admin-triggered, targets ~2,000 recipes via
// the Anthropic Message Batches API (50% cheaper than the synchronous path). Architecture:
//
//   buildCoveragePlan(target, existingByCuisine) — PURE: turns a target count + what's
//     already in the library into a queue of GenSpec "asks" (cuisine + fish/veggie/weeknight/
//     kid/season hints + global sub-styles), each worth one batch REQUEST of 5 recipes.
//   buildLibraryPrompt(spec, household, ...) — PURE: the household-aware prompt for one spec,
//     reusing generate.ts's GENERATE_SYSTEM (same strict {"recipes":[…]} JSON schema).
//   processResults(results, household) — PURE-ish (writes into recipesRepo, the one
//     side-effecting step): validates each batch result with generate.ts's
//     sanitizeGeneratedBatch (same allergy/diet hard filter as the interactive path), dedupes
//     by normalized-title Levenshtein similarity within the same cuisine (vs the existing
//     library — which includes everything inserted so far this run), inserts the rest with
//     source:'ai', tallies inserted/duplicate/failed + the batch-priced € cost.
//   tick() — the coordinator step: poll in-flight batches → process any that ended → dispatch
//     more from the remaining queue up to a concurrency cap and the run's hard € cost cap →
//     persist job state (kitchen.libraryGeneration in state.json) so a restart mid-run resumes
//     (batch ids + the remaining spec queue survive; startLibraryGenerationCoordinator's timer
//     just keeps calling tick(), which is state-driven and doesn't care if it's a fresh call or
//     a resume).
//
// NEVER exercised against the live Batches API in tests — kitchen/library-generate.test.ts
// feeds buildCoveragePlan/buildLibraryPrompt/processResults fixture data directly.

import * as appStore from '../store';
import * as kitchenStore from './store';
import * as recipesRepo from './recipes-repo';
import * as claude from '../connectors/claude';
import * as realBatchApi from '../connectors/claude-batch';
import { GENERATE_SYSTEM, sanitizeGeneratedBatch } from './generate';
import { forbiddenKeywords } from './engine';
import type { LibraryGenerationJob } from '../store';
import type { Cuisine, Household, Recipe, Season } from './types';

/** The slice of the Batches connector tick() actually uses — swappable for tests. */
type BatchApi = Pick<typeof realBatchApi, 'createBatch' | 'getBatchStatus' | 'getBatchResults' | 'cancelBatch'>;

// Test seam (review F2): production always uses the real connector; library-generate.test.ts
// swaps in a mock so the tick()/cancel race is testable with zero live network calls.
let batchApi: BatchApi = realBatchApi;

/** Test-only: swap the Batches connector (pass nothing to restore the real one). */
export function _setBatchApiForTests(api?: BatchApi): void {
  batchApi = api ?? realBatchApi;
}

// ---- Coverage plan (docs/46 §2c) -----------------------------------------------------------

export const RECIPES_PER_REQUEST = 5;
export const REQUESTS_PER_BATCH = 20;
export const MAX_CONCURRENT_BATCHES = 3;
export const DEFAULT_CAP_EUR = 25;
const POLL_MS = 20_000;

const CUISINE_SPLIT: Record<Cuisine, number> = { spanish: 0.3, italian: 0.15, japanese: 0.15, dutch: 0.1, global: 0.3 };
const CUISINE_ORDER: Cuisine[] = ['spanish', 'italian', 'japanese', 'dutch', 'global'];
const GLOBAL_STYLES = ['jamie-style', 'nigella-style', 'mexican', 'indian', 'thai', 'greek', 'moroccan'];
const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];

export interface GenSpec {
  cuisine: Cuisine;
  styleHint?: string;
  fish?: boolean;
  veggie?: boolean;
  weeknight?: boolean;
  kid?: boolean;
  season?: Season;
}

/**
 * Turn a target library size + current per-cuisine counts into a queue of generation specs,
 * one per batch REQUEST of RECIPES_PER_REQUEST recipes. Resumable by construction: pass the
 * CURRENT counts and it only asks for the shortfall (docs/46: "next run targets target minus
 * current count"). Deterministic (no randomness) so it's unit-testable: fish/veggie/weeknight/
 * kid hints and season/style rotation are all index-modulo, aiming for the brief's quotas
 * (≥20% fish, ≥25% veggie, weeknight majority, kid-friendly share, global sub-styles).
 */
export function buildCoveragePlan(target: number, existingByCuisine: Record<Cuisine, number>): GenSpec[] {
  const specs: GenSpec[] = [];
  for (const cuisine of CUISINE_ORDER) {
    const wanted = Math.round(target * CUISINE_SPLIT[cuisine]);
    const have = existingByCuisine[cuisine] ?? 0;
    const need = Math.max(0, wanted - have);
    const requestsNeeded = Math.ceil(need / RECIPES_PER_REQUEST);
    for (let idx = 0; idx < requestsNeeded; idx++) {
      specs.push({
        cuisine,
        ...(cuisine === 'global' ? { styleHint: GLOBAL_STYLES[idx % GLOBAL_STYLES.length] } : {}),
        fish: idx % 5 === 0, // ~20% of requests fish-focused
        veggie: idx % 4 === 1, // ~25% of requests veggie-focused
        weeknight: idx % 3 !== 2, // ~2/3 weeknight-quick (≤35 min majority)
        kid: idx % 5 < 2, // ~40% lean kid-friendly
        season: SEASONS[idx % 4],
      });
    }
  }
  return specs;
}

/** The household-aware prompt for one spec — same JSON contract as generate.ts's
 *  GENERATE_SYSTEM (system prompt is shared, unchanged). */
export function buildLibraryPrompt(spec: GenSpec, household: Household, avoidTitles: string[]): string {
  const lines: string[] = [
    `Invent ${RECIPES_PER_REQUEST} COMPLETE, distinct home dinner recipes for cuisine "${spec.cuisine}".`,
  ];
  if (spec.styleHint) {
    lines.push(
      `Style: ${spec.styleHint} — an ORIGINAL dish in that style/spirit (technique + flavour pairing), ` +
        'never a copy of any specific published recipe or its exact wording.',
    );
  }
  if (spec.fish) lines.push('At least one of the 5 MUST feature fish or seafood as the main ingredient.');
  if (spec.veggie) lines.push('At least one of the 5 MUST have no meat and no fish (a full vegetarian dinner).');
  if (spec.weeknight) lines.push('Most of these should be doable in 35 minutes total or less (weeknight-friendly).');
  if (spec.kid) lines.push('Lean kid-friendly where it fits the cuisine.');
  if (spec.season) lines.push(`Favor ${spec.season} produce where it fits.`);
  lines.push(
    `Cooking for ${household.adults} adult${household.adults === 1 ? '' : 's'}${household.kids > 0 ? ` + ${household.kids} kid${household.kids === 1 ? '' : 's'}` : ''}.`,
  );
  const forbidden = forbiddenKeywords(household);
  if (forbidden.length) lines.push(`NEVER use these ingredients or anything containing them: ${[...new Set(forbidden)].join(', ')}.`);
  if (avoidTitles.length) lines.push(`Avoid duplicating these already-in-library titles: ${avoidTitles.slice(0, 15).join('; ')}.`);
  lines.push('Make the 5 recipes genuinely distinct from each other (different main ingredient/technique each).');
  return lines.join('\n');
}

// ---- Dedupe: normalized-title Levenshtein similarity within the same cuisine ---------------

export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Classic Levenshtein edit distance (small strings — titles — so the O(n·m) table is fine). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** 0..1 similarity from normalized-title edit distance (1 = identical). */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  const maxLen = Math.max(na.length, nb.length) || 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

export const DUP_SIMILARITY_THRESHOLD = 0.82;

/** True when `title` is a near-duplicate of any existing title in the SAME cuisine. */
export function isDuplicateTitle(title: string, existingTitlesSameCuisine: string[]): boolean {
  return existingTitlesSameCuisine.some((t) => titleSimilarity(title, t) >= DUP_SIMILARITY_THRESHOLD);
}

// ---- Batch result processing (validate → dedupe → insert) ----------------------------------

export interface ProcessOutcome {
  inserted: number;
  duplicates: number;
  failed: number;
  spentEur: number;
}

/**
 * Parse + validate + dedupe + insert ONE batch's worth of results. Pure aside from the
 * recipesRepo.insertRecipe side effect (the whole point) — `titlesByCuisine` is re-read after
 * each insert so within-batch duplicates (two similar recipes in the same result set) are
 * caught too, not just duplicates vs. the pre-existing library. Exported so
 * library-generate.test.ts can feed it fixture BatchResult[] with no network involved.
 */
export function processResults(results: realBatchApi.BatchResult[], household: Household): ProcessOutcome {
  let inserted = 0;
  let duplicates = 0;
  let failed = 0;
  let spentEur = 0;

  for (const r of results) {
    if (r.outcome !== 'succeeded') {
      failed += RECIPES_PER_REQUEST;
      continue;
    }
    spentEur += claude.estimateBatchCostEur(r.inputTokens, r.outputTokens);
    claude.recordBatchUsage(r.inputTokens, r.outputTokens);

    let parsed: { recipes?: unknown } | null = null;
    try {
      const cleaned = r.text.replace(/^[\s\S]*?(\{)/, '$1').replace(/(\})[^}]*$/, '$1');
      parsed = JSON.parse(cleaned) as { recipes?: unknown };
    } catch {
      parsed = null;
    }
    if (!parsed) {
      failed += RECIPES_PER_REQUEST;
      continue;
    }

    const batch = sanitizeGeneratedBatch(parsed, household);
    failed += Math.max(0, RECIPES_PER_REQUEST - batch.length); // recipes the sanitizer couldn't salvage

    for (const gen of batch) {
      const existingTitles = recipesRepo.titlesByCuisine(gen.cuisine);
      if (isDuplicateTitle(gen.title, existingTitles)) {
        duplicates++;
        continue;
      }
      const now = new Date().toISOString();
      const recipe: Recipe = { ...gen, id: kitchenStore.newId('recipe'), createdAt: now, updatedAt: now };
      recipesRepo.insertRecipe(recipe);
      inserted++;
    }
  }

  return { inserted, duplicates, failed, spentEur };
}

// ---- Job orchestration (persisted in state.json's kitchen.libraryGeneration) ----------------

export function jobStatus(): LibraryGenerationJob {
  return appStore.get().kitchen.libraryGeneration;
}

function titlesSampleForSpecs(specs: GenSpec[]): string[] {
  const cuisines = new Set(specs.map((s) => s.cuisine));
  const out: string[] = [];
  for (const c of cuisines) out.push(...recipesRepo.titlesByCuisine(c).slice(0, 5));
  return out;
}

/**
 * Start a new run. Refuses if one is already running, or if there's genuinely nothing left
 * to generate (already at/above target for every cuisine bucket). Deliberately does NOT call
 * tick() itself — that would fire a real network request (createBatch) as a side effect of a
 * plain state-mutation function, which is exactly what library-generate.test.ts must never
 * trigger. The route (POST /library/generate) kicks the coordinator with `void tick()` after
 * a successful start; the periodic coordinator timer would pick it up within POLL_MS anyway.
 *
 * Also sets `autoTarget = target` (docs/47 §3a) — a manual Generate press (or an auto-start,
 * which always passes the current autoTarget right back) always brings the self-fill target in
 * sync with whatever was just started, and — because status flips to 'running' here — clears
 * any 'cancelled'/'error' latch that was blocking auto-start.
 */
export function startGeneration(target: number, capEur = DEFAULT_CAP_EUR): { ok: boolean; reason?: string } {
  if (!claude.isConfigured()) {
    return { ok: false, reason: 'No Anthropic key — add it in Settings → Intelligence' };
  }
  const current = jobStatus();
  if (current.status === 'running') return { ok: false, reason: 'a generation run is already in progress' };

  const clampedTarget = Math.max(1, Math.min(5000, Math.round(target)));
  const clampedCap = Math.max(1, Math.min(500, Math.round(capEur)));
  const plan = buildCoveragePlan(clampedTarget, recipesRepo.countByCuisine());
  if (!plan.length) {
    return { ok: false, reason: `library already has ${recipesRepo.count()} recipes — nothing left to reach target ${clampedTarget}` };
  }

  const now = new Date().toISOString();
  appStore.update((s) => {
    s.kitchen.libraryGeneration = {
      status: 'running',
      target: clampedTarget,
      capEur: clampedCap,
      startedAt: now,
      updatedAt: now,
      batchIds: [],
      queued: plan.length,
      insertedCount: 0,
      duplicateCount: 0,
      failedCount: 0,
      spentEur: 0,
      error: null,
      remainingJson: JSON.stringify(plan),
      autoTarget: clampedTarget,
      monthlyBudgetEur: current.monthlyBudgetEur,
    };
  });
  return { ok: true };
}

/** Stop the run: best-effort cancel of any in-flight batches, mark cancelled, drop the queue
 *  (a later Generate press recomputes the shortfall fresh — nothing is lost). Fire-and-forget
 *  network cancels only run when there are actual batchIds to cancel — a job with none in
 *  flight (e.g. cancelled the instant after starting) makes no network call at all.
 *
 * Also sets `autoTarget = the current library count` (docs/47 §3a) — stop MEANS stop: without
 * this, the very next auto-start check would just re-launch the same run the owner just
 * cancelled. A later manual Generate (which sets autoTarget back to whatever target is chosen)
 * is the only way to resume auto-fill. */
export function cancelGeneration(): { ok: boolean } {
  const job = jobStatus();
  if (job.status !== 'running') return { ok: false };
  const ids = [...job.batchIds];
  appStore.update((s) => {
    s.kitchen.libraryGeneration.status = 'cancelled';
    s.kitchen.libraryGeneration.updatedAt = new Date().toISOString();
    s.kitchen.libraryGeneration.remainingJson = null;
    s.kitchen.libraryGeneration.batchIds = [];
    s.kitchen.libraryGeneration.autoTarget = recipesRepo.count();
  });
  void Promise.all(ids.map((id) => batchApi.cancelBatch(id).catch(() => false)));
  return { ok: true };
}

let ticking = false;

/**
 * One coordinator step: poll in-flight batches → process any that ended → dispatch more from
 * the remaining queue (bounded by MAX_CONCURRENT_BATCHES and the run's € cap) → persist.
 * Re-entrancy guarded (mirrors the fleet/kitchen coordinators elsewhere in this app) and
 * state-driven — safe to call on a timer regardless of whether a run just started or is being
 * resumed after a restart (the persisted batchIds/remainingJson carry it forward).
 */
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const job = jobStatus();
    if (job.status !== 'running') return;

    let batchIds: string[] = [...job.batchIds];
    let queuedSpecs: GenSpec[] = job.remainingJson ? (JSON.parse(job.remainingJson) as GenSpec[]) : [];
    let inserted = job.insertedCount;
    let duplicates = job.duplicateCount;
    let failed = job.failedCount;
    let spent = job.spentEur;
    const household = kitchenStore.get().household;

    // 1) Poll + process ended batches.
    const stillInFlight: string[] = [];
    for (const id of batchIds) {
      const info = await batchApi.getBatchStatus(id);
      if (!info || info.processingStatus !== 'ended') {
        stillInFlight.push(id); // transient poll failure or still running — retry next tick
        continue;
      }
      const results = await batchApi.getBatchResults(id);
      if (!results) {
        stillInFlight.push(id); // couldn't fetch results yet — retry next tick
        continue;
      }
      const outcome = processResults(results, household);
      inserted += outcome.inserted;
      duplicates += outcome.duplicates;
      failed += outcome.failed;
      spent += outcome.spentEur;
    }
    batchIds = stillInFlight;

    // 2) Dispatch more from the queue, bounded by concurrency AND the hard € cap.
    // Cancel race (review F2): cancelGeneration() can flip the persisted status while this
    // loop awaits network calls. The final appStore.update below already refuses to write
    // state over a cancel — but a batch created HERE after the cancel would then be recorded
    // nowhere: it would run to completion on Anthropic's side (billed) with results never
    // fetched. So (a) re-check the LIVE status right before each createBatch and stop
    // dispatching once cancelled, and (b) if the cancel landed DURING the createBatch await,
    // best-effort cancel the batch we just made so it doesn't run orphaned.
    while (batchIds.length < MAX_CONCURRENT_BATCHES && queuedSpecs.length > 0 && spent < job.capEur) {
      if (jobStatus().status !== 'running') break; // cancelled mid-tick — stop dispatching
      const batchSpecs = queuedSpecs.slice(0, REQUESTS_PER_BATCH);
      const avoidTitles = titlesSampleForSpecs(batchSpecs);
      const requests = batchSpecs.map((spec, i) => ({
        custom_id: `r${i}`,
        system: GENERATE_SYSTEM,
        prompt: buildLibraryPrompt(spec, household, avoidTitles),
        maxTokens: Math.min(8000, 1200 * RECIPES_PER_REQUEST + 800),
      }));
      // Rough pre-flight estimate (real cost is recorded from actual usage once results are
      // back) — abort cleanly rather than overshoot the cap by dispatching one batch too many.
      const estCost = requests.length * claude.estimateBatchCostEur(400, 1200 * RECIPES_PER_REQUEST);
      if (spent + estCost > job.capEur) break;

      const batchId = await batchApi.createBatch(requests);
      if (!batchId) break; // key/network hiccup — leave batchSpecs queued, try again next tick
      if (jobStatus().status !== 'running') {
        // Cancelled while createBatch was in flight — this batch would otherwise be orphaned
        // (state write below is discarded on cancel). Best-effort cancel it and stop.
        void batchApi.cancelBatch(batchId).catch(() => false);
        break;
      }
      queuedSpecs = queuedSpecs.slice(batchSpecs.length);
      batchIds.push(batchId);
    }

    const capReached = spent >= job.capEur;
    const done = batchIds.length === 0 && (queuedSpecs.length === 0 || capReached);

    appStore.update((s) => {
      const j = s.kitchen.libraryGeneration;
      if (j.status !== 'running') return; // cancelled while we were awaiting network calls
      j.batchIds = batchIds;
      j.queued = queuedSpecs.length;
      j.insertedCount = inserted;
      j.duplicateCount = duplicates;
      j.failedCount = failed;
      j.spentEur = Math.round(spent * 100) / 100;
      j.remainingJson = done || !queuedSpecs.length ? null : JSON.stringify(queuedSpecs);
      j.updatedAt = new Date().toISOString();
      if (done) {
        j.status = 'done';
        j.queued = 0;
      }
    });
  } catch (e) {
    console.error('[library-generate] tick failed:', (e as Error).message);
    appStore.update((s) => {
      s.kitchen.libraryGeneration.status = 'error';
      s.kitchen.libraryGeneration.error = (e as Error).message;
      s.kitchen.libraryGeneration.updatedAt = new Date().toISOString();
    });
  } finally {
    ticking = false;
  }
}

// ---- Auto-generation (docs/47 §3a — no button) ----------------------------------------------
// A self-fill target replaces the owner having to press Generate at all. The decision itself
// (shouldAutoStart) is a pure function of a small context so the full status x count x budget
// matrix is unit-testable without touching the store/network; maybeAutoStart() is the thin
// side-effecting wrapper the coordinator actually calls.

export interface AutoStartContext {
  status: LibraryGenerationJob['status'];
  autoTarget: number;
  currentCount: number;
  monthlyBudgetEur: number;
  monthUsageEur: number;
  configured: boolean;
}

/** Pure decision: should the coordinator start a run right now? Mirrors docs/47 §3a exactly —
 *  configured, below target, idle-or-done (NEVER cancelled/error — a human pressed Stop or
 *  something broke; auto-resuming either is hostile), and under the monthly € budget. */
export function shouldAutoStart(ctx: AutoStartContext): boolean {
  if (!ctx.configured) return false;
  if (ctx.autoTarget <= 0) return false; // 0 = auto-off
  if (ctx.status !== 'idle' && ctx.status !== 'done') return false;
  if (ctx.currentCount >= ctx.autoTarget) return false;
  if (ctx.monthUsageEur >= ctx.monthlyBudgetEur) return false;
  return true;
}

/** Pure "why isn't it auto-filling right now" reason for the Library card, or null when
 *  there's nothing to explain (auto-fill off, already at target, actively running, or about
 *  to start on the next tick). */
export function autoIdleReasonFor(ctx: AutoStartContext): string | null {
  if (ctx.autoTarget <= 0) return null;
  if (ctx.currentCount >= ctx.autoTarget) return null;
  if (ctx.status === 'running') return null;
  if (!ctx.configured) return 'Waiting for an Anthropic key — add one in Settings → Intelligence';
  if (ctx.monthUsageEur >= ctx.monthlyBudgetEur) {
    return `Monthly budget reached (€${ctx.monthlyBudgetEur.toFixed(0)}) — resumes next calendar month`;
  }
  return null;
}

function currentAutoStartContext(): AutoStartContext {
  const job = jobStatus();
  return {
    status: job.status,
    autoTarget: job.autoTarget,
    currentCount: recipesRepo.count(),
    monthlyBudgetEur: job.monthlyBudgetEur,
    monthUsageEur: claude.currentMonthUsageEur(),
    configured: claude.isConfigured(),
  };
}

/** Side-effecting wrapper: reads live state, and starts a run when shouldAutoStart() agrees.
 *  Safe to call on every coordinator tick — startGeneration() is itself idempotent-refusing
 *  (won't double-start a running job) and this is a no-op the moment the target is reached. */
export function maybeAutoStart(): void {
  const ctx = currentAutoStartContext();
  if (!shouldAutoStart(ctx)) return;
  startGeneration(ctx.autoTarget);
}

/** Library card "why idle" line — live version of autoIdleReasonFor() for the status route. */
export function autoIdleReasonNow(): string | null {
  return autoIdleReasonFor(currentAutoStartContext());
}

let coordinatorHandle: ReturnType<typeof setInterval> | null = null;

/** Boot wiring (index.ts): start the poll timer. State-driven, so it transparently resumes a
 *  run that was still `status: 'running'` when the process last stopped (batch ids + the
 *  remaining queue were persisted) — nothing special to do on resume beyond just ticking.
 *  Also runs the auto-start check once shortly after boot, and again on every tick after
 *  (docs/47 §3a: "on the existing coordinator timer, and once shortly after boot"). */
export function startLibraryGenerationCoordinator(): void {
  if (coordinatorHandle) return;
  coordinatorHandle = setInterval(() => {
    void tick();
    maybeAutoStart();
  }, POLL_MS);
  if (jobStatus().status === 'running') {
    console.log('[library-generate] resuming a library-generation run from a previous boot');
    void tick();
  } else {
    maybeAutoStart();
  }
}

/** Test-only: stop the poll timer (avoids leaking an interval across test files). */
export function _stopCoordinatorForTests(): void {
  if (coordinatorHandle) clearInterval(coordinatorHandle);
  coordinatorHandle = null;
}
