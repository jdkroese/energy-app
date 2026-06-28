import { useId } from 'react';
import type { BreakerUsagePoint } from '../../lib/types';

/* ============================================================================
 * BreakerUsageChart — hand-rolled SVG line/area chart of a breaker's power over
 * the selected window. Mirrors VoltageHistoryChart (PR #85): --grid line, soft
 * area fill, 3 value gridlines, ~5 localized x-axis time ticks, and a tidy
 * "Collecting data…" empty state until there are ≥2 points. Used in both
 * viewports (desktop full-width + mobile single-column).
 *
 * `ts` on each point is unix SECONDS (the metering store's unit); we convert to
 * ms for label formatting.
 * ==========================================================================*/

type Props = {
  points: BreakerUsagePoint[];
  height?: number;
};

/** Localized tick label — HH:mm for sub-day spans, else DD/MM. */
function tickLabel(tsSec: number, spanSec: number): string {
  const d = new Date(tsSec * 1000);
  if (spanSec <= 36 * 3600) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

export function BreakerUsageChart({ points, height = 200 }: Props) {
  const id = 'u' + useId().replace(/:/g, '');

  // Use power where present; fall back to 0 so a gap reads as a dip, not a break.
  const series = points
    .map((p) => ({ ts: p.ts, w: typeof p.powerAvgW === 'number' ? p.powerAvgW : null }))
    .filter((p) => p.w !== null) as Array<{ ts: number; w: number }>;

  if (series.length < 2) {
    return (
      <div
        style={{
          height,
          display: 'grid',
          placeItems: 'center',
          textAlign: 'center',
          border: '1px dashed var(--border-2)',
          borderRadius: 'var(--radius-lg)',
          color: 'var(--text-3)',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', padding: 16 }}>
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Collecting data…</span>
          <span style={{ fontSize: 11.5, maxWidth: 260, lineHeight: 1.5 }}>
            Usage is sampled every minute. The chart fills in as readings arrive.
          </span>
        </div>
      </div>
    );
  }

  const w = 1000;
  const h = height;
  const padY = 18;
  const plotH = h - padY * 2;

  const vals = series.map((s) => s.w);
  const dataMax = Math.max(...vals, 1);
  const lo = 0;
  const hi = Math.ceil(dataMax * 1.1);
  const span = Math.max(1, hi - lo);

  const t0 = series[0].ts;
  const t1 = series[series.length - 1].ts;
  const tSpan = Math.max(1, t1 - t0);

  const x = (ts: number) => ((ts - t0) / tSpan) * w;
  const y = (v: number) => padY + (1 - (v - lo) / span) * plotH;

  const pts = series.map((s) => ({ x: x(s.ts), y: y(s.w) }));
  const line = pts.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  const TICKS = 5;
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const ts = t0 + (tSpan * i) / (TICKS - 1);
    return { x: (i / (TICKS - 1)) * w, label: tickLabel(ts, tSpan) };
  });

  const grids = [0, 0.5, 1];

  return (
    <svg
      viewBox={`0 0 ${w} ${h + 24}`}
      width="100%"
      preserveAspectRatio="none"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--grid)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--grid)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* value gridlines + left labels (W) */}
      {grids.map((g, i) => {
        const gy = padY + g * plotH;
        const val = Math.round(hi - g * span);
        return (
          <g key={`g${i}`}>
            <line x1="0" y1={gy} x2={w} y2={gy} stroke="var(--grid-line)" strokeWidth="1" />
            <text x="6" y={gy - 5} fill="var(--text-3)" style={{ font: '500 15px var(--font-mono)' }}>
              {val}
            </text>
          </g>
        );
      })}

      {/* area fill under the line */}
      <path d={`${line} L${w} ${h - padY} L0 ${h - padY} Z`} fill={`url(#${id}-fill)`} />

      {/* power line */}
      <path
        d={line}
        fill="none"
        stroke="var(--grid)"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />

      {/* unit hint top-right */}
      <text x={w - 6} y={padY - 4} textAnchor="end" fill="var(--text-3)" style={{ font: '600 13px var(--font-mono)' }}>
        W
      </text>

      {/* x-axis time ticks */}
      {ticks.map((tk, i) => (
        <text
          key={`t${i}`}
          x={tk.x}
          y={h + 14}
          textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
          fill="var(--text-3)"
          style={{ font: '500 15px var(--font-mono)' }}
        >
          {tk.label}
        </text>
      ))}
    </svg>
  );
}
