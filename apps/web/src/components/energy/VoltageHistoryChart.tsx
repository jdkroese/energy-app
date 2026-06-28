import { useId } from 'react';
import type { VoltageSample } from '../../lib/types';

/* ============================================================================
 * VoltageHistoryChart — hand-rolled SVG line chart of the last 48h of grid
 * voltage (5-min buckets). Draws the voltage line in --grid, dashed band lines
 * at minV/maxV, tints out-of-band segments --danger, and labels a few x-axis
 * time ticks. Empty/too-few-points → a tidy "Collecting data…" state. Used in
 * both viewports (desktop modal + mobile sheet). Model: AreaChart/DayChart.
 * ==========================================================================*/

type Props = {
  samples: VoltageSample[];
  band: { minV: number; maxV: number };
  height?: number;
};

/** Localized HH:mm for an epoch-ms tick label. */
function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function VoltageHistoryChart({ samples, band, height = 200 }: Props) {
  const id = 'v' + useId().replace(/:/g, '');

  // Collecting / empty state — need ≥2 points to draw a line.
  if (samples.length < 2) {
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
            Voltage is sampled every 5 minutes. The 48-hour history fills in as readings arrive.
          </span>
        </div>
      </div>
    );
  }

  const w = 1000;
  const h = height;
  const padY = 18;
  const plotH = h - padY * 2;

  const vals = samples.map((s) => s.voltageV);
  const dataMin = Math.min(...vals);
  const dataMax = Math.max(...vals);
  // Y-range always includes the band, with a little padding above/below.
  const lo = Math.floor(Math.min(dataMin, band.minV) - 4);
  const hi = Math.ceil(Math.max(dataMax, band.maxV) + 4);
  const span = Math.max(1, hi - lo);

  const t0 = samples[0].ts;
  const t1 = samples[samples.length - 1].ts;
  const tSpan = Math.max(1, t1 - t0);

  const x = (ts: number) => ((ts - t0) / tSpan) * w;
  const y = (v: number) => padY + (1 - (v - lo) / span) * plotH;

  // Build the line as segments so we can tint out-of-band portions --danger.
  const pts = samples.map((s) => ({ x: x(s.ts), y: y(s.voltageV), v: s.voltageV }));
  const outOfBand = (v: number) => v < band.minV || v > band.maxV;
  const segs: Array<{ d: string; bad: boolean }> = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    segs.push({
      d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} L${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
      bad: outOfBand(a.v) || outOfBand(b.v),
    });
  }

  // Band lines (clamped into the plot when within range).
  const yMin = y(band.minV);
  const yMax = y(band.maxV);

  // X ticks across the window — aim for ~5 evenly spaced, localized HH:mm.
  const TICKS = 5;
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const ts = t0 + (tSpan * i) / (TICKS - 1);
    return { x: (i / (TICKS - 1)) * w, label: hhmm(ts) };
  });

  // Horizontal value gridlines (3) for orientation.
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

      {/* value gridlines + left labels */}
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

      {/* band lines (minV / maxV), dashed, danger-toned */}
      <g>
        <line
          x1="0"
          y1={yMax}
          x2={w}
          y2={yMax}
          stroke="var(--danger)"
          strokeWidth="1.5"
          strokeDasharray="6 5"
          strokeOpacity="0.7"
          vectorEffect="non-scaling-stroke"
        />
        <text x={w - 6} y={yMax - 5} textAnchor="end" fill="var(--danger)" style={{ font: '600 14px var(--font-mono)' }}>
          {band.maxV} V
        </text>
        <line
          x1="0"
          y1={yMin}
          x2={w}
          y2={yMin}
          stroke="var(--danger)"
          strokeWidth="1.5"
          strokeDasharray="6 5"
          strokeOpacity="0.7"
          vectorEffect="non-scaling-stroke"
        />
        <text x={w - 6} y={yMin + 16} textAnchor="end" fill="var(--danger)" style={{ font: '600 14px var(--font-mono)' }}>
          {band.minV} V
        </text>
      </g>

      {/* fill under the line */}
      <path
        d={`${pts.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L${w} ${
          h - padY
        } L0 ${h - padY} Z`}
        fill={`url(#${id}-fill)`}
      />

      {/* voltage line — in-band segments --grid, out-of-band --danger */}
      {segs.map((s, i) => (
        <path
          key={i}
          d={s.d}
          fill="none"
          stroke={s.bad ? 'var(--danger)' : 'var(--grid)'}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}

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
