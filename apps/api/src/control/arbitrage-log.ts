// Durable tariff-arbitrage effectiveness logging. Each event is recorded TWO ways:
//   1. Appended as one JSON line to an append-only JSONL file (the durable, reproducible
//      record — survives a state.json reset; the path mirrors store.statePath()).
//   2. Pushed onto an in-state ring buffer (last ARBITRAGE_LOG_RING_MAX) and folded into
//      cumulative headline stats (survives a restart via state.json), for the UI history.
//
// BEST-EFFORT, NEVER THROWS: a logging failure (full disk, permissions) must never crash a
// coordinator tick, so every fs touch is wrapped. The in-state write goes through store.update.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as store from '../store';
import type { ArbitrageEvent } from '../store';
import { ARBITRAGE_LOG_RING_MAX } from '../store';
import { logArbitrageEvent } from './log-adapters';

/**
 * Resolve the JSONL path. MIRRORS store.statePath():
 *   ARBITRAGE_LOG_FILE env override, else
 *   production → /opt/energy/arbitrage-events.jsonl
 *   dev        → <repoRoot>/.data/arbitrage-events.jsonl
 */
function logPath(): string {
  if (process.env.ARBITRAGE_LOG_FILE) return process.env.ARBITRAGE_LOG_FILE;
  if (process.env.NODE_ENV === 'production') return '/opt/energy/arbitrage-events.jsonl';
  const repoRoot =
    typeof __dirname !== 'undefined'
      ? resolve(__dirname, '..', '..', '..', '..')
      : resolve(process.cwd(), '..', '..');
  return resolve(repoRoot, '.data', 'arbitrage-events.jsonl');
}

let path: string | null = null;
function file(): string {
  if (!path) path = logPath();
  return path;
}

/** Append one event as a JSON line. Best-effort; swallows all errors. */
function appendJsonl(ev: ArbitrageEvent): void {
  try {
    const f = file();
    const dir = dirname(f);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(f, `${JSON.stringify(ev)}\n`, 'utf8');
  } catch (e) {
    // Never let a logging failure crash a tick.
    console.error('[arbitrage-log] JSONL append failed:', (e as Error).message);
  }
}

/** Round to 3 decimals (kWh / €) to keep the persisted JSON compact + stable. */
function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Record one arbitrage event: append to the JSONL file, push onto the in-state ring (capped
 * at ARBITRAGE_LOG_RING_MAX), and — for an `engage` (which is transition-gated, so it fires
 * ONCE per distinct engagement) — bump the engagement COUNTER. Best-effort, never throws.
 *
 * NOTE: kWh/€ savings are NOT accrued here. Because `engage` is logged only on a state
 * transition, accruing energy from the single engage line would credit just one 90s tick of a
 * multi-hour charge. Per-tick energy is accrued separately via accrueArbitrageCharge(), called
 * every charging tick — so the headline totals reflect the full charge duration.
 */
export function appendArbitrageEvent(ev: ArbitrageEvent): void {
  appendJsonl(ev);
  // Shim: mirror into the unified event bus (docs/37 §3) alongside the arbitrage JSONL/ring.
  logArbitrageEvent(ev);
  try {
    store.update((s) => {
      const ctrl = s.control;
      ctrl.arbitrageLog.push(ev);
      if (ctrl.arbitrageLog.length > ARBITRAGE_LOG_RING_MAX) {
        ctrl.arbitrageLog = ctrl.arbitrageLog.slice(-ARBITRAGE_LOG_RING_MAX);
      }
      const st = ctrl.arbitrageStats;
      st.lastEventTs = ev.ts;
      // Count DISTINCT engagements (one per transition); energy/savings accrue per-tick below.
      if (ev.type === 'engage') {
        if (ev.executionMode === 'active') st.engagementsActive += 1;
        else st.engagementsAdvisory += 1;
      }
      ctrl.updatedAt = Date.now();
    });
  } catch (e) {
    console.error('[arbitrage-log] in-state record failed:', (e as Error).message);
  }
}

/**
 * Accrue ONE charging tick's energy + modelled saving into the cumulative stats. Called on
 * EVERY tick the rule is charging (active) or would-charge (advisory) — separate from the
 * transition-gated `engage` event — so a multi-hour valley charge accumulates across its whole
 * duration instead of crediting a single tick. Advisory (modelled) and active (realized) are
 * tracked apart. Updates lastEventTs. Does NOT touch the ring/JSONL. Best-effort, never throws.
 */
export function accrueArbitrageCharge(
  mode: 'advisory' | 'active',
  chargedKwhTick: number,
  spreadEur: number,
  ts: number,
): void {
  if (!(chargedKwhTick > 0)) return; // nothing to credit (also guards NaN)
  const savedEur = chargedKwhTick * spreadEur;
  try {
    store.update((s) => {
      const st = s.control.arbitrageStats;
      if (mode === 'active') {
        st.valleyKwhActive = r3(st.valleyKwhActive + chargedKwhTick);
        st.estSavedEurActive = r3(st.estSavedEurActive + savedEur);
      } else {
        st.valleyKwhAdvisory = r3(st.valleyKwhAdvisory + chargedKwhTick);
        st.estSavedEurAdvisory = r3(st.estSavedEurAdvisory + savedEur);
      }
      st.lastEventTs = ts;
      s.control.updatedAt = Date.now();
    });
  } catch (e) {
    console.error('[arbitrage-log] charge accrual failed:', (e as Error).message);
  }
}

/** Test/diagnostic helper — drop the resolved-path memo so the next call re-resolves. */
export function _resetArbitrageLogPath(): void {
  path = null;
}
