import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { BreakerUsageGranularity, BreakerUsageResponse } from '../../lib/types';
import { Card, StatTile, Icon } from '../ui';
import { BreakerUsageChart } from './BreakerUsageChart';

/* ============================================================================
 * BreakerUsageSection — the "Usage" block on a metered breaker's detail page
 * (spec docs/28 §8 Phase-1 minimum). A kWh stat row (Today · This week · This
 * month) over the StatTile style, plus a hand-rolled power chart over a
 * selectable window (24h / 7d / 30d) in the voltage-history chart's visual
 * language. Renders on BOTH viewports; the caller gates on isMeteredBreaker().
 *
 * Reads only — the metering store is read-only. When metering is unavailable
 * (available:false) it shows the same "Collecting data…" empty state.
 * ==========================================================================*/

type Window = '24h' | '7d' | '30d';

const WINDOWS: { key: Window; label: string; hours: number; granularity: BreakerUsageGranularity }[] = [
  { key: '24h', label: '24h', hours: 24, granularity: 'raw' },
  { key: '7d', label: '7d', hours: 24 * 7, granularity: 'hour' },
  { key: '30d', label: '30d', hours: 24 * 30, granularity: 'hour' },
];

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

/** Start-of-this-week (Mon) ISO, local. */
function isoWeekStart(): string {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - dow);
  return d.toISOString();
}
/** Start-of-this-month ISO, local. */
function isoMonthStart(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}
/** Start-of-today ISO, local. */
function isoTodayStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function kwh(v: number | null | undefined): string {
  if (v == null) return '—';
  return v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2);
}

export function BreakerUsageSection({ id }: { id: string }) {
  const [win, setWin] = useState<Window>('24h');
  const spec = WINDOWS.find((w) => w.key === win)!;

  // The power chart over the selected window (polls so it fills live).
  const { data: chart } = usePolling<BreakerUsageResponse>(
    () => api.breakers.usage(id, { from: isoHoursAgo(spec.hours), granularity: spec.granularity }),
    60_000,
    [id, win],
  );

  // kWh totals — Today / This week / This month (one cheap call each, polled slowly).
  const { data: today } = usePolling<BreakerUsageResponse>(
    () => api.breakers.usage(id, { from: isoTodayStart() }),
    60_000,
    [id],
  );
  const { data: week } = usePolling<BreakerUsageResponse>(
    () => api.breakers.usage(id, { from: isoWeekStart() }),
    300_000,
    [id],
  );
  const { data: month } = usePolling<BreakerUsageResponse>(
    () => api.breakers.usage(id, { from: isoMonthStart() }),
    300_000,
    [id],
  );

  // "Collecting" until the chart window has enough points OR a total is known.
  const points = useMemo(() => chart?.points ?? [], [chart]);
  const unavailable = chart?.available === false;

  return (
    <Card padded style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Icon name="activity" size={14} color="var(--text-3)" />
        <span className="pwr-eyebrow" style={{ flex: 1 }}>Usage</span>
      </div>

      {/* kWh stat row — Today · This week · This month */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
          marginBottom: 14,
        }}
      >
        <StatTile size="sm" label="Today" value={kwh(today?.totalKwh)} unit="kWh" tone="grid" />
        <StatTile size="sm" label="This week" value={kwh(week?.totalKwh)} unit="kWh" tone="grid" />
        <StatTile size="sm" label="This month" value={kwh(month?.totalKwh)} unit="kWh" tone="grid" />
      </div>

      {/* Window selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)', flex: 1 }}>Power</span>
        {WINDOWS.map((w) => {
          const active = w.key === win;
          return (
            <button
              key={w.key}
              type="button"
              onClick={() => setWin(w.key)}
              className="pwr-mono"
              style={{
                fontSize: 11.5,
                padding: '3px 9px',
                borderRadius: 999,
                cursor: 'pointer',
                border: '1px solid ' + (active ? 'var(--grid)' : 'var(--border-1)'),
                background: active ? 'var(--grid-wash)' : 'transparent',
                color: active ? 'var(--grid)' : 'var(--text-3)',
              }}
            >
              {w.label}
            </button>
          );
        })}
      </div>

      <BreakerUsageChart points={unavailable ? [] : points} />
    </Card>
  );
}
