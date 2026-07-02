import { useId, useRef, useState } from 'react';
import type { VoltageSample } from '../../lib/types';

/* ============================================================================
 * VoltageHistoryChart — hand-rolled SVG line chart of the last 48h of grid
 * voltage (5-min buckets). Draws the breaker voltage line in --grid, dashed band
 * lines at minV/maxV, tints out-of-band segments --danger, and labels a few x-axis
 * time ticks. Overlays a SECOND line (--warning) for the Sonnen inverter's own AC
 * terminal voltage (Uac) — it runs higher than the breaker meter and is the value
 * that actually governs the over-voltage trip; samples missing Uac leave a GAP in
 * that line (never plotted as 0). A small legend distinguishes the two. Hover/drag
 * (pointer events → mouse + touch) reveals a crosshair, a dot on the nearest sample,
 * and a tooltip with both values + date/time. Empty/too-few-points → a tidy
 * "Collecting data…" state. Used in both viewports (desktop modal + mobile sheet).
 * Model: AreaChart/DayChart.
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

/** Localized "Sun 28 Jun · 22:15" for the hover tooltip. */
function whenLabel(ts: number): string {
  const d = new Date(ts);
  const day = d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });
  return `${day} · ${hhmm(ts)}`;
}

export function VoltageHistoryChart({ samples, band, height = 200 }: Props) {
  const id = 'v' + useId().replace(/:/g, '');
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

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
  // Sonnen inverter Uac values (only the real ones — >0); used to widen the Y-range so
  // the (higher) inverter line stays in view, and to draw the overlay line below.
  const uacVals = samples.map((s) => s.sonnenUacV).filter((v): v is number => typeof v === 'number' && v > 0);
  const hasUac = uacVals.length >= 2;
  const dataMin = Math.min(...vals);
  const dataMax = Math.max(...vals, ...uacVals);
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

  // Sonnen inverter Uac overlay — build as contiguous polyline runs so samples that
  // lack a real Uac (missing/0) leave a GAP in the line rather than dropping to 0.
  const uacRuns: string[] = [];
  if (hasUac) {
    let run: string[] = [];
    for (const s of samples) {
      const u = s.sonnenUacV;
      if (typeof u === 'number' && u > 0) {
        run.push(`${run.length ? 'L' : 'M'}${x(s.ts).toFixed(1)} ${y(u).toFixed(1)}`);
      } else if (run.length) {
        if (run.length >= 2) uacRuns.push(run.join(' '));
        run = [];
      }
    }
    if (run.length >= 2) uacRuns.push(run.join(' '));
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

  // ---- Hover: map pointer x → nearest sample (by time) -----------------------
  const vbH = h + 24; // svg viewBox height
  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const tt = t0 + fx * tSpan;
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < samples.length; i++) {
      const dd = Math.abs(samples[i].ts - tt);
      if (dd < best) {
        best = dd;
        idx = i;
      }
    }
    setHover(idx);
  }

  const hp = hover != null ? pts[hover] : null;
  const hs = hover != null ? samples[hover] : null;
  const hBad = hs ? outOfBand(hs.voltageV) : false;
  // Tooltip horizontal anchor — flip near the edges so it never clips.
  const fracX = hp ? hp.x / w : 0;
  const anchor = fracX < 0.16 ? 'translateX(0)' : fracX > 0.84 ? 'translateX(-100%)' : 'translateX(-50%)';

  return (
    <div
      ref={wrapRef}
      onPointerMove={onMove}
      onPointerDown={onMove}
      onPointerUp={() => setHover(null)}
      onPointerLeave={() => setHover(null)}
      style={{ position: 'relative', touchAction: 'none', cursor: 'crosshair' }}
    >
      {/* legend — distinguishes the breaker meter from the Sonnen inverter Uac line */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          display: 'flex',
          gap: 12,
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: '0.02em',
          color: 'var(--text-3)',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      >
        <LegendKey color="var(--grid)" label="Breaker" />
        {hasUac && <LegendKey color="var(--warning)" label="Inverter (Sonnen)" />}
      </div>
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

      {/* Sonnen inverter Uac overlay — amber, drawn over the breaker line; gaps where absent */}
      {uacRuns.map((d, i) => (
        <path
          key={`uac${i}`}
          d={d}
          fill="none"
          stroke="var(--warning)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeOpacity="0.9"
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

      {/* hover crosshair (vertical) */}
      {hp && (
        <line
          x1={hp.x}
          y1={padY}
          x2={hp.x}
          y2={h - padY}
          stroke="var(--text-2)"
          strokeWidth="1"
          strokeDasharray="4 4"
          strokeOpacity="0.55"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>

      {/* hover dot — HTML overlay so it stays round under the stretched SVG */}
      {hp && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: `${(hp.x / w) * 100}%`,
            top: `${(hp.y / vbH) * 100}%`,
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: hBad ? 'var(--danger)' : 'var(--grid)',
            boxShadow: '0 0 0 3px var(--surface-1)',
            transform: 'translate(-50%, -50%)',
            transition: 'left .07s ease-out, top .07s ease-out',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* hover tooltip — value + date/time */}
      {hp && hs && (
        <div
          style={{
            position: 'absolute',
            left: `${fracX * 100}%`,
            top: 2,
            transform: anchor,
            pointerEvents: 'none',
            background: 'var(--surface-2, #141d21)',
            border: '1px solid var(--border-2)',
            borderRadius: 8,
            padding: '5px 9px',
            whiteSpace: 'nowrap',
            boxShadow: '0 6px 18px rgba(0,0,0,.45)',
            transition: 'left .07s ease-out',
          }}
        >
          <span style={{ font: '600 15px var(--font-mono)', color: hBad ? 'var(--danger)' : 'var(--grid)' }}>
            {hs.voltageV} V
          </span>
          {typeof hs.sonnenUacV === 'number' && hs.sonnenUacV > 0 && (
            <span style={{ font: '600 15px var(--font-mono)', color: 'var(--warning)', marginLeft: 8 }}>
              {hs.sonnenUacV} V
            </span>
          )}
          <span style={{ font: '500 11px var(--font-sans, inherit)', color: 'var(--text-3)', marginLeft: 8 }}>
            {whenLabel(hs.ts)}
          </span>
        </div>
      )}
    </div>
  );
}

/** Legend swatch + label — a short colored dash matching the line stroke. */
function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 14, height: 3, borderRadius: 2, background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}
