// The unified Event Viewer (docs/37) — one searchable, filterable, severity-tagged timeline
// that replaces the battery-only "Command log" events tab. World A (action logs) + World B
// (alerts) merged behind ONE /api/events stream. Single responsive component: desktop (≥768px)
// is a two-pane list + right drawer; mobile (<768px) is a single column + filter/detail sheets.
// Follows the Power dark control-room system. Read + ack/resolve only (no control writes).

import { Fragment, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { Icon, SegmentedControl, Input, Button } from '../components/ui';
import type {
  EnergyEvent,
  EventsListResponse,
  EventClass,
  EventSeverity,
  EventCategory,
  EventsQuery,
} from '../lib/types';

/* ---- Severity palette (docs/37 §8) --------------------------------------- */
const SEV_COLOR: Record<EventSeverity, string> = {
  low: 'var(--text-3)',
  medium: '#f5c518', // --sun-lit-1
  high: 'var(--grid)',
  critical: 'var(--danger)',
};
const SEV_LABEL: Record<EventSeverity, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  critical: 'Critical',
};
const SEV_ORDER: EventSeverity[] = ['low', 'medium', 'high', 'critical'];

const CLASS_BADGE: Record<EventClass, { label: string; icon: string }> = {
  action: { label: 'Action', icon: 'zap' },
  observation: { label: 'Alert', icon: 'radar' },
  system: { label: 'System', icon: 'settings' },
};

const CATEGORY_ICON: Record<EventCategory, string> = {
  battery: 'battery-charging',
  climate: 'thermometer',
  blinds: 'blinds',
  ev: 'car',
  irrigation: 'droplets',
  arbitrage: 'trending-up',
  grid: 'plug',
  connectivity: 'wifi',
  security: 'shield',
  app: 'layout-dashboard',
};
const ALL_CATEGORIES: EventCategory[] = [
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

type ClassFilter = 'all' | 'action' | 'observation' | 'system';
type RangeKey = 'live' | '24h' | '7d' | '30d';

const RANGE_MS: Record<Exclude<RangeKey, 'live'>, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
};

/* ---- Time helpers -------------------------------------------------------- */
function relTime(ts: string): string {
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60_000) return `${Math.max(0, Math.round(d / 1000))}s ago`;
  if (d < 3600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}
function absTime(ts: string): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
function dateHeader(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* ========================================================================== */

export function EventViewer({ wide }: { wide: boolean }) {
  // Filter state. Default = Actions + Observations, medium+ (locked §10.1).
  const [classFilter, setClassFilter] = useState<ClassFilter>('all');
  const [severities, setSeverities] = useState<EventSeverity[]>(['medium', 'high', 'critical']);
  const [categories, setCategories] = useState<EventCategory[]>([]);
  const [range, setRange] = useState<RangeKey>('24h');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<EnergyEvent | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Build the server query. The default view hides class 'system' + low severity, and shows
  // Actions + Observations; the "All" class chip reveals system too.
  const query: EventsQuery = useMemo(() => {
    const q: EventsQuery = { limit: 200 };
    if (classFilter === 'all') q.class = ['action', 'observation'];
    else q.class = [classFilter];
    if (severities.length && severities.length < 4) q.severity = severities;
    if (categories.length) q.category = categories;
    if (search.trim()) q.q = search.trim();
    if (range !== 'live') q.from = new Date(Date.now() - RANGE_MS[range]).toISOString();
    return q;
  }, [classFilter, severities, categories, search, range]);

  // Poll the events stream — SWR via usePolling (opens instantly from last-good).
  const key = JSON.stringify(query);
  const { data, loading } = usePolling<EventsListResponse>(
    () => api.events.list(query),
    range === 'live' ? 8_000 : 20_000,
    [key],
  );
  const events = data?.events ?? [];

  const toggleSeverity = (s: EventSeverity) =>
    setSeverities((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  const toggleCategory = (c: EventCategory) =>
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const onAck = async (id: string) => {
    try {
      await api.events.ack(id);
      setSelected((s) => (s ? { ...s, ackStatus: 'ack' } : s));
    } catch {
      /* ignore */
    }
  };
  const onResolve = async (id: string) => {
    try {
      await api.events.resolve(id);
      setSelected((s) => (s ? { ...s, ackStatus: 'resolved' } : s));
    } catch {
      /* ignore */
    }
  };

  /* ---- Filter bar ------------------------------------------------------- */
  const filterBar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Input
        placeholder="Search events…"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      {/* Class segmented — always visible */}
      <SegmentedControl
        block
        size="sm"
        options={[
          { value: 'all', label: 'All' },
          { value: 'action', label: 'Actions' },
          { value: 'observation', label: 'Observations' },
          { value: 'system', label: 'System' },
        ]}
        value={classFilter}
        onChange={(v) => setClassFilter(v as ClassFilter)}
      />
      {/* Desktop: severity + category + range inline. Mobile: behind the Filters sheet. */}
      {wide ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SeverityChips severities={severities} onToggle={toggleSeverity} />
          <CategoryChips categories={categories} onToggle={toggleCategory} />
          <RangeControl range={range} setRange={setRange} />
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Icon name="sliders-horizontal" size={15} />}
            onClick={() => setFiltersOpen(true)}
          >
            Filters
            {(severities.length < 4 || categories.length > 0 || range !== '24h') && (
              <span style={{ marginLeft: 6, color: 'var(--solar)' }}>•</span>
            )}
          </Button>
          <div style={{ flex: 1 }} />
          <a
            href={api.events.exportUrl(query, 'jsonl')}
            style={{ fontSize: 12, color: 'var(--text-3)', alignSelf: 'center', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            <Icon name="download" size={14} /> Export
          </a>
        </div>
      )}
    </div>
  );

  /* ---- Severity heat-strip (24h) ---------------------------------------- */
  const heatStrip = <HeatStrip events={events} onPick={(ev) => setSelected(ev)} />;

  /* ---- Event list grouped by date --------------------------------------- */
  const list = (
    <EventList
      events={events}
      loading={loading}
      selectedId={selected?.id ?? null}
      onSelect={setSelected}
    />
  );

  /* ---- Layout ----------------------------------------------------------- */
  if (wide) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {filterBar}
        {heatStrip}
        <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 380px' : '1fr', gap: 14, alignItems: 'start' }}>
          <div>{list}</div>
          {selected && (
            <div style={{ position: 'sticky', top: 12 }}>
              <EventDetail
                ev={selected}
                onClose={() => setSelected(null)}
                onAck={onAck}
                onResolve={onResolve}
                embedded
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Mobile: single column + Filters bottom-sheet + detail bottom-sheet.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {filterBar}
      {heatStrip}
      {list}
      {filtersOpen && (
        <BottomSheet title="Filters" onClose={() => setFiltersOpen(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <Label>Severity</Label>
              <SeverityChips severities={severities} onToggle={toggleSeverity} />
            </div>
            <div>
              <Label>Category</Label>
              <CategoryChips categories={categories} onToggle={toggleCategory} />
            </div>
            <div>
              <Label>Time range</Label>
              <RangeControl range={range} setRange={setRange} />
            </div>
            <Button variant="primary" onClick={() => setFiltersOpen(false)}>Done</Button>
          </div>
        </BottomSheet>
      )}
      {selected && (
        <BottomSheet title="Event detail" onClose={() => setSelected(null)}>
          <EventDetail ev={selected} onClose={() => setSelected(null)} onAck={onAck} onResolve={onResolve} />
        </BottomSheet>
      )}
    </div>
  );
}

/* ---- Sub-components ------------------------------------------------------- */

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', marginBottom: 8 }}>
      {children}
    </div>
  );
}

function SeverityChips({ severities, onToggle }: { severities: EventSeverity[]; onToggle: (s: EventSeverity) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {SEV_ORDER.map((s) => {
        const on = severities.includes(s);
        return (
          <button
            key={s}
            onClick={() => onToggle(s)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
              padding: '5px 11px', borderRadius: 999, cursor: 'pointer',
              border: `1px solid ${on ? SEV_COLOR[s] : 'var(--border-2)'}`,
              background: on ? 'var(--surface-3)' : 'transparent',
              color: on ? 'var(--text-1)' : 'var(--text-3)',
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV_COLOR[s] }} />
            {SEV_LABEL[s]}
          </button>
        );
      })}
    </div>
  );
}

function CategoryChips({ categories, onToggle }: { categories: EventCategory[]; onToggle: (c: EventCategory) => void }) {
  return (
    <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
      {ALL_CATEGORIES.map((c) => {
        const on = categories.includes(c);
        return (
          <button
            key={c}
            onClick={() => onToggle(c)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5,
              padding: '4px 9px', borderRadius: 999, cursor: 'pointer', textTransform: 'capitalize',
              border: `1px solid ${on ? 'var(--solar)' : 'var(--border-2)'}`,
              background: on ? 'var(--solar-wash)' : 'transparent',
              color: on ? 'var(--text-1)' : 'var(--text-3)',
            }}
          >
            <Icon name={CATEGORY_ICON[c]} size={12} />
            {c}
          </button>
        );
      })}
    </div>
  );
}

function RangeControl({ range, setRange }: { range: RangeKey; setRange: (r: RangeKey) => void }) {
  return (
    <SegmentedControl
      block
      size="sm"
      options={[
        { value: 'live', label: 'Live' },
        { value: '24h', label: '24h' },
        { value: '7d', label: '7d' },
        { value: '30d', label: '30d' },
      ]}
      value={range}
      onChange={(v) => setRange(v as RangeKey)}
    />
  );
}

/** A thin 24h heat-band: one tick per event colored by severity. */
function HeatStrip({ events, onPick }: { events: EnergyEvent[]; onPick: (ev: EnergyEvent) => void }) {
  // Only the last 24h for the strip, newest-right.
  const cutoff = Date.now() - 24 * 3600_000;
  const recent = events.filter((e) => new Date(e.ts).getTime() >= cutoff).slice(0, 200);
  if (recent.length === 0) {
    return (
      <div style={{ height: 26, borderRadius: 8, border: '1px solid var(--border-1)', background: 'var(--surface-1)', display: 'grid', placeItems: 'center', fontSize: 11, color: 'var(--text-3)' }}>
        No events in the last 24h
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 2, height: 26, borderRadius: 8, border: '1px solid var(--border-1)', background: 'var(--surface-1)', padding: '3px 5px', overflow: 'hidden' }}>
      {[...recent].reverse().map((e) => (
        <button
          key={e.id}
          title={`${SEV_LABEL[e.severity]} · ${e.summary} · ${absTime(e.ts)}`}
          onClick={() => onPick(e)}
          style={{ flex: 1, minWidth: 2, maxWidth: 8, borderRadius: 2, border: 'none', cursor: 'pointer', background: SEV_COLOR[e.severity], opacity: e.severity === 'low' ? 0.5 : 0.9 }}
        />
      ))}
    </div>
  );
}

/** Grouped, collapsed event list. */
function EventList({
  events,
  loading,
  selectedId,
  onSelect,
}: {
  events: EnergyEvent[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (ev: EnergyEvent) => void;
}) {
  if (loading && events.length === 0) {
    return <div style={{ padding: '28px 0', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}><Icon name="loader" size={16} /> Loading events…</div>;
  }
  if (events.length === 0) {
    return (
      <div style={{ padding: '28px 14px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13, border: '1px dashed var(--border-2)', borderRadius: 12 }}>
        No events match these filters. Widen the class, severity, or time range.
      </div>
    );
  }

  // Group under date headers; collapse consecutive identical (summary) rows into "×N".
  const groups: { date: string; rows: { ev: EnergyEvent; count: number }[] }[] = [];
  for (const ev of events) {
    const date = dateHeader(ev.ts);
    let g = groups[groups.length - 1];
    if (!g || g.date !== date) {
      g = { date, rows: [] };
      groups.push(g);
    }
    const last = g.rows[g.rows.length - 1];
    if (last && last.ev.summary === ev.summary && last.ev.class === ev.class && last.ev.device === ev.device) {
      last.count += 1;
    } else {
      g.rows.push({ ev, count: 1 });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {groups.map((g) => (
        <div key={g.date}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', padding: '10px 2px 6px' }}>{g.date}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {g.rows.map(({ ev, count }) => (
              <EventRow key={ev.id} ev={ev} count={count} selected={ev.id === selectedId} onSelect={() => onSelect(ev)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EventRow({ ev, count, selected, onSelect }: { ev: EnergyEvent; count: number; selected: boolean; onSelect: () => void }) {
  const sev = SEV_COLOR[ev.severity];
  const badge = CLASS_BADGE[ev.class];
  const rejected = ev.ok === false;
  return (
    <button
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'stretch', gap: 0, textAlign: 'left', width: '100%',
        border: `1px solid ${selected ? 'var(--border-2)' : 'var(--border-1)'}`,
        background: selected ? 'var(--surface-3)' : 'var(--surface-1)',
        borderRadius: 'var(--radius-md)', cursor: 'pointer', overflow: 'hidden', padding: 0,
      }}
    >
      {/* severity left-rail */}
      <span style={{ width: 4, flex: 'none', background: sev, opacity: ev.severity === 'low' ? 0.5 : 1 }} />
      <span style={{ display: 'flex', gap: 10, padding: '10px 12px', flex: 1, minWidth: 0, alignItems: 'flex-start' }}>
        <span style={{ width: 26, height: 26, borderRadius: 8, flex: 'none', display: 'grid', placeItems: 'center', marginTop: 1, background: 'var(--surface-3)', color: sev }}>
          <Icon name={CATEGORY_ICON[ev.category]} size={14} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span title={absTime(ev.ts)} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', flex: 'none' }}>{relTime(ev.ts)}</span>
            <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 5, background: 'var(--surface-3)', color: 'var(--text-2)', display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' }}>
              <Icon name={badge.icon} size={10} /> {badge.label}
            </span>
            {rejected && <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 5, background: 'var(--danger-wash)', color: 'var(--danger)', flex: 'none' }}>rejected</span>}
            {ev.state === 'cleared' && <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 5, background: 'var(--solar-wash)', color: 'var(--solar)', flex: 'none' }}>cleared</span>}
            {count > 1 && <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 5, background: 'var(--surface-3)', color: 'var(--text-3)', flex: 'none' }}>×{count}</span>}
          </span>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-1)', marginTop: 3 }}>{ev.summary}</span>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginTop: 3 }}>
            <span style={{ fontSize: 11, color: 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="git-branch" size={11} /> via {ev.trigger.source}
            </span>
            {ev.change && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-2)' }}>
                {fmtVal(ev.change.from)} → <span style={{ color: 'var(--text-1)' }}>{fmtVal(ev.change.to)}</span>
              </span>
            )}
            {ev.device && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· {ev.device}</span>}
          </span>
        </span>
      </span>
    </button>
  );
}

/** Detail pane / sheet — the reproduction view. */
function EventDetail({
  ev,
  onClose,
  onAck,
  onResolve,
  embedded,
}: {
  ev: EnergyEvent;
  onClose: () => void;
  onAck: (id: string) => void;
  onResolve: (id: string) => void;
  embedded?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const sev = SEV_COLOR[ev.severity];
  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(ev, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  const isObservation = ev.class === 'observation';

  return (
    <div style={{ border: embedded ? '1px solid var(--border-1)' : 'none', borderRadius: embedded ? 'var(--radius-card)' : 0, background: embedded ? 'var(--surface-1)' : 'transparent', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border-1)' }}>
        <span style={{ width: 6, height: 30, borderRadius: 3, background: sev, flex: 'none' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-1)' }}>{ev.summary}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>{absTime(ev.ts)}</div>
        </div>
        {embedded && (
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 4 }} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        )}
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <MetaGrid ev={ev} />

        {ev.detail && (
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 10, padding: 11 }}>
            {ev.detail}
          </div>
        )}

        {ev.change && (
          <div>
            <Label>Transition</Label>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-2)' }}>
              {fmtVal(ev.change.from)} → <span style={{ color: 'var(--text-1)' }}>{fmtVal(ev.change.to)}</span>
            </div>
          </div>
        )}

        {ev.data && Object.keys(ev.data).length > 0 && (
          <div>
            <Label>Context at the time (reproduction payload)</Label>
            <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 10, padding: 11, overflowX: 'auto', maxHeight: 260 }}>
              {JSON.stringify(ev.data, null, 2)}
            </pre>
          </div>
        )}

        {ev.relatedId && (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            <Icon name="link" size={12} /> Related to {ev.relatedId}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
          <Button size="sm" variant="secondary" iconLeft={<Icon name={copied ? 'check' : 'copy'} size={14} />} onClick={copyJson}>
            {copied ? 'Copied' : 'Copy JSON'}
          </Button>
          <a
            href={api.events.exportUrl({ q: ev.id }, 'jsonl')}
            style={{ fontSize: 12.5, color: 'var(--text-2)', display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none', padding: '6px 11px', border: '1px solid var(--border-2)', borderRadius: 8 }}
          >
            <Icon name="download" size={14} /> Export incident
          </a>
          {isObservation && ev.ackStatus !== 'resolved' && (
            <>
              {ev.ackStatus !== 'ack' && (
                <Button size="sm" variant="secondary" iconLeft={<Icon name="check" size={14} />} onClick={() => onAck(ev.id)}>Ack</Button>
              )}
              <Button size="sm" variant="primary" iconLeft={<Icon name="check-check" size={14} />} onClick={() => onResolve(ev.id)}>Resolve</Button>
            </>
          )}
          {isObservation && ev.ackStatus === 'resolved' && (
            <span style={{ fontSize: 12, color: 'var(--solar)', alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Icon name="check-check" size={14} /> Resolved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaGrid({ ev }: { ev: EnergyEvent }) {
  const rows: [string, string][] = [
    ['Class', CLASS_BADGE[ev.class].label],
    ['Category', ev.category],
    ['Severity', SEV_LABEL[ev.severity]],
    ['Trigger', `${ev.trigger.source}${ev.trigger.detail ? ` · ${ev.trigger.detail}` : ''}`],
  ];
  if (ev.device) rows.push(['Device', ev.device]);
  if (ev.entity) rows.push(['Entity', ev.entity]);
  if (ev.state) rows.push(['State', ev.state]);
  if (ev.ok !== undefined) rows.push(['Outcome', ev.ok ? 'ok' : 'rejected']);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: 6, columnGap: 12 }}>
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{k}</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-1)', textTransform: k === 'Category' || k === 'State' ? 'capitalize' : 'none' }}>{v}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** Mobile bottom-sheet shell. */
function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} />
      <div style={{ position: 'relative', background: 'var(--surface-1)', borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTop: '1px solid var(--border-2)', maxHeight: '86vh', overflowY: 'auto', padding: '14px 16px 26px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-1)' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 4 }} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
