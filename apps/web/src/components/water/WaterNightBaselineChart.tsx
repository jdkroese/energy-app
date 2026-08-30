import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTheme } from '../../lib/ThemeProvider';

/* ============================================================================
 * WaterNightBaselineChart — the leak detector's core signal, per docs/51 §1:
 * the night-hour floor over the selected period, with the continuous-flow
 * alert threshold marked as a dashed reference line. A point above the
 * threshold line is a night the floor never cleared.
 * ==========================================================================*/

const W = 1000;

function resolveToken(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function WaterNightBaselineChart({
  labels,
  values,
  thresholdL,
  height = 160,
  unit = 'L/h',
}: {
  labels: string[];
  values: number[];
  thresholdL: number;
  height?: number;
  unit?: string;
}) {
  const { resolved: theme } = useTheme();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const waterColor = useMemo(() => resolveToken('--water', '#4aa3ff'), [theme]);
  const dangerColor = useMemo(() => resolveToken('--danger', '#ff5d5d'), [theme]);

  const n = Math.min(labels.length, values.length);
  const padTop = 14;
  const padBottom = 22;
  const plotTop = padTop;
  const plotBottom = height - padBottom;
  const plotH = plotBottom - plotTop;

  const maxV = Math.max(1, thresholdL * 1.2, ...values.slice(0, n));
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => plotTop + (1 - v / maxV) * plotH;

  const path = Array.from({ length: n }, (_, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(values[i]).toFixed(1)}`).join(' ');
  const grids = [0, 0.25, 0.5, 0.75, 1];
  const stride = Math.max(1, Math.ceil(n / 8));

  function onMove(e: ReactPointerEvent<SVGSVGElement>) {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
    setHoverIdx(i);
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10, fontSize: 11.5, color: 'var(--text-2)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span aria-hidden style={{ width: 12, height: 2.5, borderRadius: 2, background: waterColor, display: 'inline-block' }} />
          Night-hour floor
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span aria-hidden style={{ width: 12, height: 0, borderTop: `2px dashed ${dangerColor}`, display: 'inline-block' }} />
          Alert threshold ({thresholdL} {unit})
        </span>
      </div>
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${W} ${height}`}
          width="100%"
          height={height}
          preserveAspectRatio="none"
          role="img"
          aria-label="Nightly water-flow floor against the continuous-flow alert threshold"
          style={{ display: 'block', overflow: 'visible', touchAction: 'none' }}
          onPointerMove={onMove}
          onPointerLeave={() => setHoverIdx(null)}
        >
          {grids.map((g, i) => {
            const yy = plotTop + g * plotH;
            return (
              <g key={i}>
                <line x1={0} y1={yy} x2={W} y2={yy} stroke="var(--grid-line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <text x={4} y={yy - 4} fill="var(--text-3)" style={{ font: '500 13px var(--font-mono)' }}>
                  {Math.round(maxV * (1 - g))}
                </text>
              </g>
            );
          })}

          <line x1={0} y1={y(thresholdL)} x2={W} y2={y(thresholdL)} stroke={dangerColor} strokeWidth={1.6} strokeDasharray="5 5" vectorEffect="non-scaling-stroke" opacity={0.85} />

          <path d={path} fill="none" stroke={waterColor} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />

          {Array.from({ length: n }).map((_, i) => {
            const over = values[i] > thresholdL;
            return <circle key={i} cx={x(i)} cy={y(values[i])} r={over ? 3.4 : 2.4} fill={over ? dangerColor : waterColor} stroke="var(--bg-1, #06090b)" strokeWidth={1} />;
          })}

          {hoverIdx != null && (
            <line x1={x(hoverIdx)} y1={plotTop} x2={x(hoverIdx)} y2={plotBottom} stroke="var(--text-1)" strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )}

          {Array.from({ length: n }).map((_, i) =>
            i % stride === 0 ? (
              <text key={i} x={x(i)} y={height - 4} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fill="var(--text-3)" style={{ font: '500 12px var(--font-mono)' }}>
                {labels[i]}
              </text>
            ) : null,
          )}
        </svg>

        {hoverIdx != null && (
          <div
            style={{
              position: 'absolute',
              top: 4,
              left: `${(hoverIdx / Math.max(1, n - 1)) * 100}%`,
              transform: `translateX(${hoverIdx / Math.max(1, n - 1) > 0.6 ? '-105%' : '5%'})`,
              minWidth: 120,
              background: 'var(--surface-3, #1b262b)',
              border: '1px solid var(--border-1)',
              borderRadius: 8,
              padding: '7px 9px',
              pointerEvents: 'none',
              zIndex: 2,
              boxShadow: 'var(--shadow-2)',
              fontSize: 11.5,
            }}
          >
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-1)', marginBottom: 3 }}>{labels[hoverIdx]}</div>
            <div style={{ fontFamily: 'var(--font-mono)', color: values[hoverIdx] > thresholdL ? dangerColor : waterColor }}>
              {values[hoverIdx]} {unit}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
