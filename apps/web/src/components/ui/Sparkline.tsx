import { useMemo } from 'react';

const TONE: Record<string, string> = {
  solar: 'var(--solar)',
  battery: 'var(--battery)',
  grid: 'var(--grid)',
  home: 'var(--home)',
  ev: 'var(--ev)',
  accent: 'var(--accent)',
};

let uid = 0;

type Props = {
  data?: number[];
  width?: number;
  height?: number;
  tone?: keyof typeof TONE;
  area?: boolean;
  strokeWidth?: number;
  showDot?: boolean;
  className?: string;
};

/** Sparkline — compact axis-less trend line/area for tiles & rows. */
export function Sparkline({
  data = [],
  width = 120,
  height = 36,
  tone = 'solar',
  area = true,
  strokeWidth = 2,
  showDot = false,
  className = '',
}: Props) {
  const id = useMemo(() => 'pwr-spark-' + uid++, []);
  if (!data.length) return <svg width={width} height={height} className={className} aria-hidden="true" />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = strokeWidth;
  const stepX = (width - pad * 2) / (data.length - 1 || 1);
  const pts = data.map((d, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (d - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const fill = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${height} L${pts[0][0].toFixed(1)} ${height} Z`;
  const color = TONE[tone] || TONE.solar;
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <path d={fill} fill={`url(#${id})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {showDot && <circle cx={last[0]} cy={last[1]} r={strokeWidth + 1} fill={color} />}
    </svg>
  );
}
