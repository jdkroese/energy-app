import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTheme } from '../../lib/ThemeProvider';

/* ============================================================================
 * WaterCumulativeChart — "measured vs accounted for": the meter's actual
 * running total (solid, water-hue, filled area) against what irrigation +
 * typical household rhythm would predict (dashed, neutral). The gap between
 * them is the unexplained running total — shaded, with an explicit labelled
 * bracket at the endpoint, because docs/51's real numbers put that gap at only
 * ~6% of the axis height: without a callout it reads as chart noise, not a
 * finding. Same DayChart conventions as the other Water charts.
 * ==========================================================================*/

const W = 1000;

function resolveToken(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function WaterCumulativeChart({
  labels,
  actual,
  expected,
  height = 200,
  unit = 'L',
}: {
  labels: string[];
  actual: number[];
  expected: number[];
  height?: number;
  unit?: string;
}) {
  const { resolved: theme } = useTheme();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const waterColor = useMemo(() => resolveToken('--water', '#4aa3ff'), [theme]);
  const expectedColor = 'var(--text-3)';
  const unexColor = useMemo(() => resolveToken('--series-water-unexplained', '#ff5d5d'), [theme]);

  const n = Math.min(labels.length, actual.length, expected.length);
  const padTop = 14;
  const padBottom = 22;
  const plotTop = padTop;
  const plotBottom = height - padBottom;
  const plotH = plotBottom - plotTop;

  const maxV = Math.max(1, ...actual.slice(0, n), ...expected.slice(0, n));
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => plotTop + (1 - v / maxV) * plotH;

  const actualPath = Array.from({ length: n }, (_, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(actual[i]).toFixed(1)}`).join(' ');
  const expectedPath = Array.from({ length: n }, (_, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(expected[i]).toFixed(1)}`).join(' ');
  const actualArea = n > 0 ? `${actualPath} L${x(n - 1).toFixed(1)} ${plotBottom} L${x(0).toFixed(1)} ${plotBottom} Z` : '';

  // Divergence band between the two curves.
  const bandTop = Array.from({ length: n }, (_, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(actual[i]).toFixed(1)}`).join(' ');
  const bandBottom = Array.from({ length: n }, (_, i) => `L${x(n - 1 - i).toFixed(1)} ${y(expected[n - 1 - i]).toFixed(1)}`).join(' ');
  const bandPath = n > 0 ? `${bandTop} ${bandBottom} Z` : '';

  const grids = [0, 0.25, 0.5, 0.75, 1];
  const stride = Math.max(1, Math.ceil(n / 8));

  function onMove(e: ReactPointerEvent<SVGSVGElement>) {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
    setHoverIdx(i);
  }

  const lastGapL = n > 0 ? Math.max(0, actual[n - 1] - expected[n - 1]) : 0;
  const gapPct = n > 0 && actual[n - 1] > 0 ? Math.round((lastGapL / actual[n - 1]) * 1000) / 10 : 0;

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10, fontSize: 11.5, color: 'var(--text-2)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span aria-hidden style={{ width: 12, height: 2.5, borderRadius: 2, background: waterColor, display: 'inline-block' }} />
          Measured (actual)
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span aria-hidden style={{ width: 12, height: 0, borderTop: `2px dashed ${expectedColor}`, display: 'inline-block' }} />
          Accounted for (household + irrigation)
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span aria-hidden style={{ width: 9, height: 9, borderRadius: 2, background: unexColor, display: 'inline-block' }} />
          Gap = unexplained
        </span>
      </div>
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${W} ${height}`}
          width="100%"
          height={height}
          preserveAspectRatio="none"
          role="img"
          aria-label="Cumulative measured water use versus what irrigation and household rhythm account for"
          style={{ display: 'block', overflow: 'visible', touchAction: 'none' }}
          onPointerMove={onMove}
          onPointerLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="water-cum-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={waterColor} stopOpacity="0.22" />
              <stop offset="100%" stopColor={waterColor} stopOpacity="0" />
            </linearGradient>
          </defs>

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

          {bandPath && <path d={bandPath} fill={unexColor} fillOpacity={0.16} />}
          {actualArea && <path d={actualArea} fill="url(#water-cum-fill)" />}
          <path d={expectedPath} fill="none" stroke={expectedColor} strokeWidth={1.8} strokeDasharray="5 5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={actualPath} fill="none" stroke={waterColor} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />

          {/* explicit labelled gap bracket at the endpoint — the gap is only ~6% of
              axis height in the real numbers, so it needs a callout, not just colour */}
          {n > 0 && lastGapL > 0 && (
            <g>
              <line
                x1={x(n - 1) - 6}
                y1={y(expected[n - 1])}
                x2={x(n - 1) - 6}
                y2={y(actual[n - 1])}
                stroke={unexColor}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
              <line x1={x(n - 1) - 10} y1={y(expected[n - 1])} x2={x(n - 1) - 2} y2={y(expected[n - 1])} stroke={unexColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <line x1={x(n - 1) - 10} y1={y(actual[n - 1])} x2={x(n - 1) - 2} y2={y(actual[n - 1])} stroke={unexColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </g>
          )}

          {hoverIdx != null && (
            <g>
              <line x1={x(hoverIdx)} y1={plotTop} x2={x(hoverIdx)} y2={plotBottom} stroke="var(--text-1)" strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <circle cx={x(hoverIdx)} cy={y(actual[hoverIdx])} r={2.8} fill={waterColor} stroke="var(--bg-1, #06090b)" strokeWidth={1.2} />
              <circle cx={x(hoverIdx)} cy={y(expected[hoverIdx])} r={2.8} fill={expectedColor} stroke="var(--bg-1, #06090b)" strokeWidth={1.2} />
            </g>
          )}

          {Array.from({ length: n }).map((_, i) =>
            i % stride === 0 ? (
              <text key={i} x={x(i)} y={height - 4} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fill="var(--text-3)" style={{ font: '500 12px var(--font-mono)' }}>
                {labels[i]}
              </text>
            ) : null,
          )}
        </svg>

        {/* endpoint gap label */}
        {n > 0 && lastGapL > 0 && (
          <div
            style={{
              position: 'absolute',
              right: 6,
              top: `calc(${((y(expected[n - 1]) + y(actual[n - 1])) / 2 / height) * 100}% - 9px)`,
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              fontWeight: 700,
              color: unexColor,
              background: 'var(--surface-1, #0f1619)',
              border: `1px solid ${unexColor}`,
              borderRadius: 5,
              padding: '1px 6px',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            +{Math.round(lastGapL)} {unit} unexplained ({gapPct}%)
          </div>
        )}

        {hoverIdx != null && (
          <div
            style={{
              position: 'absolute',
              top: 4,
              left: `${(hoverIdx / Math.max(1, n - 1)) * 100}%`,
              transform: `translateX(${hoverIdx / Math.max(1, n - 1) > 0.6 ? '-105%' : '5%'})`,
              minWidth: 140,
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
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-1)', marginBottom: 5 }}>{labels[hoverIdx]}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: 'var(--text-2)' }}>
              <span>Measured</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: waterColor }}>{Math.round(actual[hoverIdx])} {unit}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: 'var(--text-2)' }}>
              <span>Accounted for</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{Math.round(expected[hoverIdx])} {unit}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
