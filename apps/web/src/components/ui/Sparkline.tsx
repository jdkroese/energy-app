import { useId, useMemo } from 'react';

/* ============================================================================
 * Sparkline — a small inline trend line/bars for a single series (no axes, no
 * legend, no tooltip — those belong to a full chart). Built for the Water
 * hub's "quiet hour" 14-day strip and day-part small multiples (docs/51 §5
 * notes there is no Sparkline primitive yet), but general enough for any
 * compact trend. Hand-rolled SVG per house convention (no chart library).
 * ==========================================================================*/

export interface SparklineProps {
  /** Data points, oldest first. */
  values: number[];
  width?: number;
  height?: number;
  /** 'line' draws a stroke (+ optional filled area); 'bars' draws a column per value. */
  kind?: 'line' | 'bars';
  color?: string;
  /** Fill the area under a line sparkline (ignored for 'bars'). */
  area?: boolean;
  /** Optional fixed baseline for bars/lines (defaults to the data min). */
  min?: number;
  max?: number;
  /** Draws a dashed reference line at this value (e.g. an alert threshold). */
  referenceValue?: number;
  /** Highlights one index (e.g. "today") with a filled dot / brighter bar. */
  highlightIndex?: number;
  /** Per-bar colour override (kind='bars' only) — index -> CSS colour. */
  barColorAt?: (i: number, v: number) => string | undefined;
  className?: string;
}

/** Sparkline — compact trend visual, no axes/legend/tooltip. */
export function Sparkline({
  values,
  width = 120,
  height = 32,
  kind = 'line',
  color = 'var(--text-2)',
  area = false,
  min,
  max,
  referenceValue,
  highlightIndex,
  barColorAt,
  className,
}: SparklineProps) {
  const uid = 's' + useId().replace(/:/g, '');
  const n = values.length;
  const lo = min ?? Math.min(0, ...values);
  const hi = max ?? Math.max(1, ...values);
  const span = hi - lo || 1;
  const x = (i: number) => (n <= 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (v: number) => height - ((v - lo) / span) * height;

  const linePath = useMemo(() => {
    if (kind !== 'line' || n === 0) return '';
    return values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, width, height, lo, span, kind]);

  const areaPath = useMemo(() => {
    if (kind !== 'line' || !area || n === 0) return '';
    return `${linePath} L${x(n - 1).toFixed(1)} ${height} L${x(0).toFixed(1)} ${height} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linePath, area, kind, n, width, height]);

  if (n === 0) return <svg width={width} height={height} className={className} aria-hidden />;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden style={{ display: 'block', overflow: 'visible' }}>
      {area && kind === 'line' && (
        <defs>
          <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {referenceValue != null && (
        <line x1={0} y1={y(referenceValue)} x2={width} y2={y(referenceValue)} stroke="var(--danger)" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} vectorEffect="non-scaling-stroke" />
      )}
      {kind === 'bars' ? (
        <g>
          {values.map((v, i) => {
            const bw = Math.max(1, width / n - 2);
            const bx = (i / n) * width + 1;
            const by = y(Math.max(v, lo));
            const bh = Math.max(1, height - by);
            const c = barColorAt?.(i, v) ?? (i === highlightIndex ? color : color);
            return <rect key={i} x={bx} y={by} width={bw} height={bh} rx={1} fill={c} opacity={highlightIndex == null || i === highlightIndex ? 1 : 0.55} />;
          })}
        </g>
      ) : (
        <>
          {area && areaPath && <path d={areaPath} fill={`url(#${uid}-fill)`} />}
          <path d={linePath} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </>
      )}
      {highlightIndex != null && kind === 'line' && values[highlightIndex] != null && (
        <circle cx={x(highlightIndex)} cy={y(values[highlightIndex])} r={2.4} fill={color} stroke="var(--surface-1)" strokeWidth={1} />
      )}
    </svg>
  );
}
