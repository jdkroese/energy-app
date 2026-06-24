import { useMemo } from 'react';

export interface AreaSeries {
  data: number[];
  tone: string;
  dash?: boolean;
  fill?: boolean;
}

type Props = {
  series: AreaSeries[];
  height?: number;
  labels?: string[];
  /** show a left value axis with gridline labels (desktop) */
  axis?: boolean;
};

const tone = (t: string) => ({ solar: 'var(--solar)', home: 'var(--home)' } as Record<string, string>)[t] || t;

/** AreaChart — hand-rolled SVG area/line chart (ported from the mockups). */
export function AreaChart({ series, height = 150, labels, axis = false }: Props) {
  const w = 1000;
  const h = height;
  const padY = axis ? 16 : 14;
  const id = useMemo(() => 'c' + Math.floor(Math.random() * 1e6), []);
  const niceMax = Math.ceil(Math.max(...series.flatMap((s) => s.data), 1));
  const stepX = w / (series[0].data.length - 1);
  const grids = axis ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];

  return (
    <svg
      viewBox={`0 0 ${w} ${h + (axis ? 26 : 24)}`}
      width="100%"
      preserveAspectRatio="none"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        {series.map((s, i) => (
          <linearGradient key={i} id={`${id}-${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone(s.tone)} stopOpacity="0.26" />
            <stop offset="100%" stopColor={tone(s.tone)} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      {grids.map((g, i) => (
        <g key={i}>
          <line x1="0" y1={padY + g * (h - padY * 2)} x2={w} y2={padY + g * (h - padY * 2)} stroke="var(--grid-line)" strokeWidth="1" />
          {axis && (
            <text x="6" y={padY + g * (h - padY * 2) - 5} fill="var(--text-3)" style={{ font: '500 16px var(--font-mono)' }}>
              {Math.round(niceMax * (1 - g))}
            </text>
          )}
        </g>
      ))}
      {series.map((s, i) => {
        const pts = s.data.map((d, j) => [j * stepX, padY + (1 - d / niceMax) * (h - padY * 2)] as const);
        const line = pts.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
        const fill = `${line} L${w} ${h - padY} L0 ${h - padY} Z`;
        return (
          <g key={i}>
            {s.fill !== false && <path d={fill} fill={`url(#${id}-${i})`} />}
            <path
              d={line}
              fill="none"
              stroke={tone(s.tone)}
              strokeWidth={s.dash ? 2 : 2.5}
              strokeDasharray={s.dash ? '5 5' : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
      {(labels || ['00', '08', '16', '24']).map((lb, i, a) => (
        <text
          key={i}
          x={(i / (a.length - 1)) * w}
          y={h + 16}
          textAnchor={i === 0 ? 'start' : i === a.length - 1 ? 'end' : 'middle'}
          fill="var(--text-3)"
          style={{ font: '500 16px var(--font-mono)' }}
        >
          {lb}
        </text>
      ))}
    </svg>
  );
}
