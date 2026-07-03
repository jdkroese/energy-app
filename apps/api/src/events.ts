// The unified Event bus (docs/37). ONE writer — logEvent() — feeds:
//   1. an in-memory ring (~1000) for instant reads,
//   2. a durable append-only JSONL (.data/events.jsonl) for reproducibility, and
//   3. (for high-severity active observations) the existing alert/notify fan-out.
//
// The Event model is the UNION of World A (action logs: battery / climate / blinds /
// EV / irrigation / arbitrage) and World B (alerts). Adapters at each World-A emit site
// call logEvent() ALONGSIDE the existing per-domain log write (shim-first), and the alert
// rules emit observation events through the same bus. See docs/37 for the full design.
//
// SAFETY: this module NEVER throws into a caller. Durable writes are wrapped so an EACCES
// (which broke arbitrage-events.jsonl on the mini) degrades to ring-only. It touches NO
// battery-control logic — it is logging + read-only forwarding.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from './store';

// ---- Model ----------------------------------------------------------------

export type EventClass = 'action' | 'observation' | 'system';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type EventCategory =
  | 'battery'
  | 'climate'
  | 'blinds'
  | 'ev'
  | 'irrigation'
  | 'arbitrage'
  | 'grid'
  | 'solar'
  | 'connectivity'
  | 'security'
  | 'kitchen'
  | 'app';
export type TriggerSource =
  | 'surplus-rule'
  | 'schedule'
  | 'arbitrage'
  | 'manual'
  | 'user'
  | 'threshold'
  | 'guardrail'
  | 'health-probe'
  | 'coordinator'
  | 'engine-shadow'
  | 'boot'
  | 'deploy';

export type EventState = 'active' | 'cleared';
export type EventAckStatus = 'new' | 'ack' | 'resolved';

export interface EventTrigger {
  source: TriggerSource;
  detail?: string;
}

export interface EventChange {
  from: unknown;
  to: unknown;
}

export interface EnergyEvent {
  id: string; // sortable ULID (time-ordered, unique)
  ts: string; // ISO timestamp
  class: EventClass;
  category: EventCategory;
  severity: Severity;
  summary: string;
  trigger: EventTrigger;
  device?: string;
  /** Resolved friendly/user-assigned device name (read-path enrichment; not stored). */
  deviceName?: string;
  /** Device category/type routing hint (read-path enrichment; not stored). */
  deviceType?: string;
  entity?: string;
  change?: EventChange;
  ok?: boolean; // actions only: succeeded / rejected
  detail?: string;
  data?: Record<string, unknown>; // reproduction payload
  // observation lifecycle (conditions that clear):
  state?: EventState;
  relatedId?: string; // a 'cleared' points back to its 'active'
  // delivery (observations only):
  ackStatus?: EventAckStatus;
  notified?: TriggerSource[];
}

/** What a caller passes to logEvent(): everything but the id + resolved severity/ts. */
export interface LogEventInput {
  class: EventClass;
  category: EventCategory;
  /** Override the auto-derived severity (§4). Omit to auto-derive. */
  severity?: Severity;
  summary: string;
  trigger: EventTrigger;
  device?: string;
  entity?: string;
  change?: EventChange;
  ok?: boolean;
  detail?: string;
  data?: Record<string, unknown>;
  state?: EventState;
  relatedId?: string;
  /** ISO timestamp override (defaults to now). */
  ts?: string;
  /** Stable id override (used by the alert bridge so active/cleared can be idempotent). */
  id?: string;
  /**
   * Log-only: when true, the severity-forwarding to the notify fan-out is skipped even
   * for a high/critical active observation. Used by the new high-load / high-current
   * monitors (locked decision §10.2 — record but never notify).
   */
  noNotify?: boolean;
}

// ---- ULID (small, dependency-free) ----------------------------------------
// A Crockford-base32, time-ordered, monotonic id: 10 chars of ms timestamp + 16 chars
// of randomness, with a per-ms counter so ids minted in the same ms still sort in order.
// Good enough for a single-site log (not a distributed guarantee) and avoids a heavy dep.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastMs = 0;
let lastRand: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  let n = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function randChars(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(Math.random() * 32));
  return out;
}

/** Monotonic-ish ULID. Same-ms ids increment the random tail so they still sort. */
export function ulid(now: number = Date.now()): string {
  if (now === lastMs) {
    // Increment the previous random tail by one (base-32, from the least significant end).
    for (let i = lastRand.length - 1; i >= 0; i--) {
      if (lastRand[i] < 31) {
        lastRand[i] += 1;
        break;
      }
      lastRand[i] = 0;
    }
  } else {
    lastMs = now;
    lastRand = randChars(16);
  }
  return encodeTime(now) + lastRand.map((c) => CROCKFORD[c]).join('');
}

// ---- Severity map (§4) ----------------------------------------------------

/**
 * Central auto-severity. Emitters may override via input.severity. Defaults per docs/37 §4:
 *  - action guardrail rejection (ok===false) → high
 *  - action no-op / routine nudge → low
 *  - other actions → medium
 *  - observation → whatever the emitter set (alerts map info→low, warning→medium,
 *    danger→high, safety→critical) — default medium
 *  - system → low (medium for arm/disarm/mode; handled by the emitter)
 */
export function severityFor(input: LogEventInput): Severity {
  if (input.severity) return input.severity;
  if (input.class === 'action') {
    if (input.ok === false) return 'high';
    return 'low';
  }
  if (input.class === 'system') return 'low';
  return 'medium';
}

// ---- Durable JSONL --------------------------------------------------------
// MIRRORS store.dataDir() (the SAME resolution as arbitrage-events.jsonl), so the file
// lands beside state.json in the writable data dir. Wrapped so a failure degrades to
// ring-only and warns exactly ONCE (the EACCES /opt/energy history — docs/37 §7).

function logPath(): string {
  if (process.env.EVENTS_LOG_FILE) return process.env.EVENTS_LOG_FILE;
  return resolve(dataDir(), 'events.jsonl');
}

let resolvedPath: string | null = null;
function file(): string {
  if (!resolvedPath) resolvedPath = logPath();
  return resolvedPath;
}

let durableDisabled = false;
let warnedOnce = false;

function appendJsonl(ev: EnergyEvent): void {
  if (durableDisabled) return;
  try {
    const f = file();
    const dir = resolve(f, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(f, `${JSON.stringify(ev)}\n`, 'utf8');
  } catch (e) {
    // Degrade to ring-only; warn once so a broken data dir doesn't spam the log.
    if (!warnedOnce) {
      warnedOnce = true;
      console.error(
        '[events] durable JSONL write failed — degrading to ring-only:',
        (e as Error).message,
      );
    }
  }
}

// ---- In-memory ring -------------------------------------------------------

const RING_MAX = 1000;
/** Newest-last ring of the most recent events. Rebuilt from the JSONL tail on boot. */
const ring: EnergyEvent[] = [];

function pushRing(ev: EnergyEvent): void {
  ring.push(ev);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

/**
 * Warm the ring from the durable JSONL tail on boot (best-effort) so a restart doesn't
 * start with an empty timeline. Reads the whole file (bounded by retention) and keeps the
 * last RING_MAX lines. Never throws.
 */
export function warmEventRingFromDisk(): void {
  try {
    const f = file();
    if (!existsSync(f)) return;
    const text = readFileSync(f, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const tail = lines.slice(-RING_MAX);
    for (const line of tail) {
      try {
        const ev = JSON.parse(line) as EnergyEvent;
        if (ev && typeof ev.id === 'string' && typeof ev.ts === 'string') pushRing(ev);
      } catch {
        /* skip a malformed line */
      }
    }
    if (ring.length > 0) console.log(`[events] warmed ${ring.length} events from disk`);
  } catch (e) {
    console.error('[events] ring warm failed:', (e as Error).message);
  }
}

// ---- Severity forwarding to the alert/notify fan-out ----------------------
// A high/critical ACTIVE observation is delivered over the existing channels — so alerts
// are emitted AS events, not a second path. Injected by index.ts (avoids a require cycle:
// alert-loop imports notify + store which are heavy; events.ts stays light). The new
// high-load / high-current monitors pass noNotify:true and are skipped here (§10.2).

type ForwardFn = (ev: EnergyEvent) => TriggerSource[] | void;
let forward: ForwardFn | null = null;

/** Register the notify fan-out (called once from index.ts at boot). */
export function setEventForwarder(fn: ForwardFn): void {
  forward = fn;
}

function maybeForward(ev: EnergyEvent, noNotify: boolean): void {
  if (noNotify) return;
  if (ev.class !== 'observation') return;
  if (ev.state !== 'active') return;
  if (ev.severity !== 'high' && ev.severity !== 'critical') return;
  if (!forward) return;
  try {
    const channels = forward(ev);
    if (Array.isArray(channels) && channels.length) ev.notified = channels;
  } catch (e) {
    console.error('[events] forward failed:', (e as Error).message);
  }
}

// ---- The single writer ----------------------------------------------------

/**
 * Record ONE event. Assigns an id + auto-severity, appends to the ring AND the durable
 * JSONL, and (for high/critical active observations, unless noNotify) forwards to the
 * notify fan-out. Returns the stored event (with its id) so callers can pair a later
 * 'cleared' via relatedId. NEVER throws.
 */
export function logEvent(input: LogEventInput): EnergyEvent {
  const now = input.ts ? new Date(input.ts).getTime() : Date.now();
  const ev: EnergyEvent = {
    id: input.id ?? ulid(now),
    ts: input.ts ?? new Date(now).toISOString(),
    class: input.class,
    category: input.category,
    severity: severityFor(input),
    summary: input.summary,
    trigger: input.trigger,
    ...(input.device !== undefined ? { device: input.device } : {}),
    ...(input.entity !== undefined ? { entity: input.entity } : {}),
    ...(input.change !== undefined ? { change: input.change } : {}),
    ...(input.ok !== undefined ? { ok: input.ok } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.relatedId !== undefined ? { relatedId: input.relatedId } : {}),
  };
  // Observations carry an ack lifecycle (default 'new') so the viewer can ack/resolve them.
  if (ev.class === 'observation' && ev.ackStatus === undefined) ev.ackStatus = 'new';

  try {
    maybeForward(ev, input.noNotify === true);
  } catch {
    /* forwarding never blocks the log */
  }
  pushRing(ev);
  appendJsonl(ev);
  return ev;
}

// ---- Query / filter / search ----------------------------------------------

export interface EventQuery {
  class?: EventClass[];
  category?: EventCategory[];
  severity?: Severity[];
  source?: TriggerSource[];
  device?: string;
  state?: EventState;
  q?: string; // free-text over summary/detail/device/trigger
  from?: string; // ISO
  to?: string; // ISO
  cursor?: string; // opaque = the id to page before (older than)
  limit?: number;
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Retention windows by severity (ms). §7: critical/high 90d · medium 30d · low 7d. */
const RETENTION_MS: Record<Severity, number> = {
  critical: 90 * 24 * 3600_000,
  high: 90 * 24 * 3600_000,
  medium: 30 * 24 * 3600_000,
  low: 7 * 24 * 3600_000,
};

function matchesText(ev: EnergyEvent, q: string): boolean {
  const needle = q.toLowerCase();
  const hay = [
    ev.summary,
    ev.detail ?? '',
    ev.device ?? '',
    ev.entity ?? '',
    ev.trigger.source,
    ev.trigger.detail ?? '',
    ev.category,
    ev.class,
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

function matches(ev: EnergyEvent, query: EventQuery): boolean {
  if (query.class && query.class.length && !query.class.includes(ev.class)) return false;
  if (query.category && query.category.length && !query.category.includes(ev.category)) return false;
  if (query.severity && query.severity.length && !query.severity.includes(ev.severity)) return false;
  if (query.source && query.source.length && !query.source.includes(ev.trigger.source)) return false;
  if (query.device && ev.device !== query.device) return false;
  if (query.state && ev.state !== query.state) return false;
  if (query.from && ev.ts < query.from) return false;
  if (query.to && ev.ts > query.to) return false;
  if (query.q && query.q.trim() && !matchesText(ev, query.q.trim())) return false;
  return true;
}

export interface EventPage {
  events: EnergyEvent[];
  /** Opaque cursor to fetch the next (older) page, or null when exhausted. */
  nextCursor: string | null;
}

/**
 * Server-side filter + free-text search + cursor pagination. Newest-first. The cursor is
 * simply the id of the last event on the previous page; the next page returns events with
 * a strictly smaller id (older). The log grows unbounded, so filtering can't be client-only.
 */
export function queryEvents(query: EventQuery): EventPage {
  const limit = Math.max(1, Math.min(500, query.limit ?? 100));
  // Newest-first (ring is newest-last, so iterate in reverse).
  const all = [...ring].reverse();
  let filtered = all.filter((e) => matches(e, query));
  if (query.cursor) {
    const idx = filtered.findIndex((e) => e.id === query.cursor);
    filtered = idx >= 0 ? filtered.slice(idx + 1) : filtered;
  }
  const page = filtered.slice(0, limit);
  const nextCursor =
    filtered.length > limit && page.length > 0 ? page[page.length - 1].id : null;
  return { events: page, nextCursor };
}

/** Full record by id (ring only — the durable JSONL is the forensic tail). */
export function getEventById(id: string): EnergyEvent | null {
  for (let i = ring.length - 1; i >= 0; i--) {
    if (ring[i].id === id) return ring[i];
  }
  return null;
}

/** Newest-first stream of the whole ring matching a query (for export). */
export function streamEvents(query: EventQuery): EnergyEvent[] {
  return [...ring].reverse().filter((e) => matches(e, query));
}

// ---- Ack / resolve (observation events) -----------------------------------
// Observation events reuse the alert override store keyed by event id; but since events
// live in the ring (not state.json), we set the ackStatus on the ring entry directly and
// let the caller persist to alertOverrides too (index.ts bridges to the existing store).

export function setEventAck(id: string, status: EventAckStatus): EnergyEvent | null {
  const ev = getEventById(id);
  if (!ev) return null;
  ev.ackStatus = status;
  return ev;
}

// ---- Retention ------------------------------------------------------------

/**
 * Tiered prune of the in-memory ring by severity (§7). The JSONL file is append-only and
 * pruned lazily on warm (bounded by RING_MAX); this keeps the ring's forensic tail bounded
 * by age per severity. Called from the existing log-prune pass. Returns the count dropped.
 */
export function pruneEventRing(now: number = Date.now()): number {
  const before = ring.length;
  const kept = ring.filter((e) => {
    const age = now - new Date(e.ts).getTime();
    return age <= RETENTION_MS[e.severity];
  });
  if (kept.length !== ring.length) {
    ring.length = 0;
    ring.push(...kept);
  }
  return before - ring.length;
}

/** Test/diagnostic helpers. */
export function _resetEvents(): void {
  ring.length = 0;
  resolvedPath = null;
  durableDisabled = false;
  warnedOnce = false;
  lastMs = 0;
  lastRand = [];
}

/** Severity rank helper (exported for the "medium+" default filter, etc.). */
export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

/** Snapshot of the ring size (diagnostics). */
export function ringSize(): number {
  return ring.length;
}
