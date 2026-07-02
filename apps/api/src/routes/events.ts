// HTTP surface for the unified Event Viewer (docs/37 §6). Read-only + ack/resolve for
// observation events. All reads are any-authed (mounted after requireAuth in index.ts).

import type { Request, Response } from 'express';
import {
  queryEvents,
  getEventById,
  streamEvents,
  setEventAck,
  type EventClass,
  type EventCategory,
  type Severity,
  type TriggerSource,
  type EventState,
  type EventQuery,
} from '../events';
import * as store from '../store';

const CLASSES: EventClass[] = ['action', 'observation', 'system'];
const CATEGORIES: EventCategory[] = [
  'battery',
  'climate',
  'blinds',
  'ev',
  'irrigation',
  'arbitrage',
  'grid',
  'connectivity',
  'security',
  'app',
];
const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
const SOURCES: TriggerSource[] = [
  'surplus-rule',
  'schedule',
  'arbitrage',
  'manual',
  'user',
  'threshold',
  'guardrail',
  'health-probe',
  'coordinator',
  'boot',
  'deploy',
];

/** Parse a comma-separated multi-value query param, keeping only allowed values. */
function multi<T extends string>(raw: unknown, allowed: T[]): T[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => (allowed as string[]).includes(s)) as T[];
  return parts.length ? parts : undefined;
}

function buildQuery(req: Request): EventQuery {
  const q = req.query;
  const query: EventQuery = {};
  const cls = multi(q.class, CLASSES);
  if (cls) query.class = cls;
  const cat = multi(q.category, CATEGORIES);
  if (cat) query.category = cat;
  const sev = multi(q.severity, SEVERITIES);
  if (sev) query.severity = sev;
  const src = multi(q.source, SOURCES);
  if (src) query.source = src;
  if (typeof q.device === 'string' && q.device) query.device = q.device;
  if (q.state === 'active' || q.state === 'cleared') query.state = q.state as EventState;
  if (typeof q.q === 'string' && q.q) query.q = q.q;
  if (typeof q.from === 'string' && q.from) query.from = q.from;
  if (typeof q.to === 'string' && q.to) query.to = q.to;
  if (typeof q.cursor === 'string' && q.cursor) query.cursor = q.cursor;
  if (typeof q.limit === 'string') {
    const n = Number(q.limit);
    if (Number.isFinite(n)) query.limit = n;
  }
  return query;
}

/** GET /api/events — filtered + searched + cursor-paginated (newest-first). */
export function listEvents(req: Request): unknown {
  const page = queryEvents(buildQuery(req));
  return { ts: new Date().toISOString(), ...page };
}

/** GET /api/events/:id — full record incl. data payload. */
export function getEvent(req: Request): unknown {
  const ev = getEventById(String(req.params.id));
  if (!ev) {
    const e = new Error('event not found') as Error & { code?: string };
    e.code = 'BAD_INPUT';
    throw e;
  }
  return ev;
}

/**
 * Ack / resolve an observation event. Sets the ackStatus on the ring entry AND mirrors into
 * the persisted alertOverrides store (reusing the alert delivery/override path) so the state
 * survives a restart. Actions/system events have no ack lifecycle → rejected.
 */
export function setEventStatus(id: string, status: 'ack' | 'resolved'): unknown {
  const ev = setEventAck(id, status);
  if (!ev) {
    const e = new Error('event not found') as Error & { code?: string };
    e.code = 'BAD_INPUT';
    throw e;
  }
  if (ev.class !== 'observation') {
    const e = new Error('only observation events can be acked/resolved') as Error & {
      code?: string;
    };
    e.code = 'BAD_INPUT';
    throw e;
  }
  store.update((s) => {
    s.alertOverrides[id] = { status };
  });
  return { ts: new Date().toISOString(), id, status };
}

/**
 * GET /api/events/export — stream the filtered events as JSONL (default) or CSV. Sends its
 * own response (not wrapped). Reads the whole matching ring newest-first.
 */
export function exportEvents(req: Request, res: Response): void {
  const query = buildQuery(req);
  const events = streamEvents(query);
  const format = String(req.query.format ?? 'jsonl').toLowerCase();
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="events.csv"');
    const cols = ['id', 'ts', 'class', 'category', 'severity', 'summary', 'device', 'trigger', 'ok', 'state', 'detail'];
    const lines = [cols.join(',')];
    for (const e of events) {
      const row = [
        e.id,
        e.ts,
        e.class,
        e.category,
        e.severity,
        e.summary,
        e.device ?? '',
        `${e.trigger.source}${e.trigger.detail ? ` (${e.trigger.detail})` : ''}`,
        e.ok === undefined ? '' : String(e.ok),
        e.state ?? '',
        e.detail ?? '',
      ].map(csvCell);
      lines.push(row.join(','));
    }
    res.send(lines.join('\n'));
    return;
  }
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="events.jsonl"');
  res.send(events.map((e) => JSON.stringify(e)).join('\n'));
}

function csvCell(v: string): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
