import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTheme } from '../../lib/ThemeProvider';

/* ============================================================================
 * WaterStackedChart — hand-rolled inline SVG stacked-bar chart, following the
 * DayChart conventions (components/energy/DayChart.tsx): series colours read
 * from CSS vars via getComputedStyle with a fallback map, re-resolved on theme
 * change; gridlines at 0/.25/.5/.75/1; HTML overlay for the tooltip (not SVG
 * text); 4px rounded bar tops; a 2px surface-coloured gap between stacked
 * segments.
 *
 * Reused for both the Overview tab's today-by-hour chart (24 buckets) and the
 * History tab's per-period bars (7/12/28-31 buckets) — same shape, different n.
 *
 * SERIES STACK ORDER IS LOAD-BEARING (docs/52 §5): irrigation -> household ->
 * unexplained. An earlier ordering put irrigation-green next to danger-red,
 * ΔE 1.3 under deuteranopia (indistinguishable). Do not reorder.
 * ==========================================================================*/

const W = 1000;

const COLOR_FALLBACK: Record<string, string> = {
  '--series-water-irrigation': '#8bd450',
  '--series-water-household': '#c4a6ff',
  '--series-water-unexplained': '#ff5d5d',
};

function resolveToken(name: string): string {
  const fallback = COLOR_FALLBACK[name] ?? '#5f7672';
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export interface WaterStackedBucket {
  label: string;
  irrigationL: number;
  householdL: number;
  unexplainedL: number;
  /** Shades this bucket's column as the "night window" (Overview: 00:00–05:59). */
  night?: boolean;
  /** False for a hover bucket the meter hasn't reported yet (dims + "not yet reported"). */
  reported?: boolean;
}

function niceMax(values: number[]): number {
  const m = Math.max(1, ...values);
  const pow = Math.pow(10, Math.floor(Math.log10(m)));
  const n = m / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

export function WaterStackedChart({
  buckets,
  height = 220,
  unit = 'L',
  showNightShade = false,
}: {
  buckets: WaterStackedBucket[];
  height?: number;
  unit?: string;
  showNightShade?: boolean;
}) {
  const { resolved: theme } = useTheme();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const colors = useMemo(
    () => ({
      irrigation: resolveToken('--series-water-irrigation'),
      household: resolveToken('--series-water-household'),
      unexplained: resolveToken('--series-water-unexplained'),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme],
  );

  const n = buckets.length;
  const totals = buckets.map((b) => b.irrigationL + b.householdL + b.unexplainedL);
  const max = niceMax(totals);

  const padTop = 10;
  const padBottom = 22;
  const plotTop = padTop;
  const plotBottom = height - padBottom;
  const plotH = plotBottom - plotTop;

  const bw = W / n;
  const barW = Math.max(2, bw * 0.62);
  const gap = 2; // surface-coloured gap between stacked segments

  const grids = [0, 0.25, 0.5, 0.75, 1];
  const stride = Math.max(1, Math.ceil(n / (n > 20 ? 12 : 8)));

  function onMove(e: ReactPointerEvent<SVGSVGElement>) {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(n - 1, Math.floor(frac * n)));
    setHoverIdx(i);
  }

  const hover = hoverIdx != null ? buckets[hoverIdx] : null;
  const hoverPct = hoverIdx != null ? ((hoverIdx + 0.5) / n) * 100 : 0;

  const legend = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10, fontSize: 11.5, color: 'var(--text-2)' }}>
      <LegendChip color={colors.irrigation} label="Irrigation" />
      <LegendChip color={colors.household} label="Household" />
      <LegendChip color={colors.unexplained} label="Unexplained" />
    </div>
  );

  return (
    <div>
      {legend}
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${W} ${height}`}
          width="100%"
          height={height}
          preserveAspectRatio="none"
          role="img"
          aria-label="Water use by hour, stacked by irrigation, household and unexplained"
          style={{ display: 'block', overflow: 'visible', touchAction: 'none' }}
          onPointerMove={onMove}
          onPointerLeave={() => setHoverIdx(null)}
        >
          {/* night-window shading (Overview only) */}
          {showNightShade &&
            buckets.map((b, i) =>
              b.night ? <rect key={`n${i}`} x={i * bw} y={plotTop} width={bw} height={plotH} fill="var(--grid-line)" /> : null,
            )}

          {/* gridlines */}
          {grids.map((g, i) => {
            const yy = plotTop + g * plotH;
            return (
              <g key={i}>
                <line x1={0} y1={yy} x2={W} y2={yy} stroke="var(--grid-line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <text x={4} y={yy - 4} fill="var(--text-3)" style={{ font: '500 13px var(--font-mono)' }}>
                  {Math.round(max * (1 - g))}
                </text>
              </g>
            );
          })}

          {/* stacked bars — irrigation (bottom) -> household -> unexplained (top) */}
          {buckets.map((b, i) => {
            const cx = i * bw + (bw - barW) / 2;
            const irrH = (b.irrigationL / max) * plotH;
            const homeH = (b.householdL / max) * plotH;
            const unexH = (b.unexplainedL / max) * plotH;
            let cursorY = plotBottom;
            const dim = b.reported === false ? 0.4 : 1;
            const segs: { h: number; color: string; top?: boolean }[] = [
              { h: irrH, color: colors.irrigation },
              { h: homeH, color: colors.household },
              { h: unexH, color: colors.unexplained, top: true },
            ];
            return (
              <g key={i} opacity={hoverIdx == null || hoverIdx === i ? dim : dim * 0.55}>
                {segs.map((s, si) => {
                  if (s.h <= 0) return null;
                  const segY = cursorY - s.h;
                  cursorY = segY - gap;
                  const isTop = si === segs.length - 1 || segs.slice(si + 1).every((x) => x.h <= 0);
                  return (
                    <rect
                      key={si}
                      x={cx}
                      y={segY}
                      width={barW}
                      height={Math.max(1, s.h)}
                      fill={s.color}
                      rx={isTop ? 4 : 0}
                      ry={isTop ? 4 : 0}
                    />
                  );
                })}
              </g>
            );
          })}

          {/* hover crosshair column */}
          {hoverIdx != null && (
            <rect x={hoverIdx * bw} y={plotTop} width={bw} height={plotH} fill="var(--text-1)" opacity={0.05} />
          )}

          {/* x labels */}
          {buckets.map((b, i) =>
            i % stride === 0 ? (
              <text key={i} x={i * bw + bw / 2} y={height - 4} textAnchor="middle" fill="var(--text-3)" style={{ font: '500 12px var(--font-mono)' }}>
                {b.label}
              </text>
            ) : null,
          )}
        </svg>

        {/* hover tooltip (HTML overlay) */}
        {hover && (
          <div
            style={{
              position: 'absolute',
              top: 4,
              left: `${hoverPct}%`,
              transform: `translateX(${hoverPct > 60 ? '-105%' : '5%'})`,
              minWidth: 150,
              background: 'var(--surface-3, #1b262b)',
              border: '1px solid var(--border-1)',
              borderRadius: 8,
              padding: '7px 9px',
              pointerEvents: 'none',
              zIndex: 2,
              boxShadow: 'var(--shadow-2)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>{hover.label}</span>
              {hover.reported === false && (
                <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-3)' }}>not reported yet</span>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <TipRow color={colors.irrigation} label="Irrigation" value={`${Math.round(hover.irrigationL)} ${unit}`} />
              <TipRow color={colors.household} label="Household" value={`${Math.round(hover.householdL)} ${unit}`} />
              <TipRow color={colors.unexplained} label="Unexplained" value={`${Math.round(hover.unexplainedL)} ${unit}`} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span aria-hidden style={{ width: 9, height: 9, borderRadius: 2, background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}

function TipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-2)' }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
        {label}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-1)' }}>{value}</span>
    </div>
  );
}
