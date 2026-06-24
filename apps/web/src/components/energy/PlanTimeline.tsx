import type { PlanAction } from '../../lib/types';

const BANDFILL = ['rgba(46,230,160,.06)', 'transparent', 'rgba(245,165,36,.10)'];
const BANDSOLID = ['var(--solar)', 'var(--grid-dim)', 'var(--grid)'];

type Props = {
  /** 25-length (0..24) solar forecast in kW */
  solar: number[];
  /** 25-length house load in kW */
  load: number[];
  /** 25-length battery SoC plan in % */
  soc: number[];
  /** 24-length tariff band index per hour (0/1/2) */
  tariff: number[];
  actions: PlanAction[];
  /** current time as a fractional hour, e.g. 16.8 */
  now: number;
};

/**
 * PlanTimeline — the brain's day-plan chart: tariff-band tints, solar-forecast
 * area, SoC trajectory, dashed load line, numbered action markers, now-marker,
 * and the band strip. Ported faithfully from energy-brain.html.
 */
export function PlanTimeline({ solar, load, soc, tariff, actions, now }: Props) {
  const W = 1000;
  const Hh = 330;
  const PADL = 34;
  const PADR = 12;
  const PADT = 12;
  const PADB = 46;
  const PW = W - PADL - PADR;
  const PH = Hh - PADT - PADB;
  const PMAX = 12;
  const X = (h: number) => PADL + (h / 24) * PW;
  const Yp = (v: number) => PADT + (1 - v / PMAX) * PH;
  const Ys = (v: number) => PADT + (1 - v / 100) * PH;
  const lineFrom = (arr: number[], Y: (v: number) => number) =>
    arr.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
  const solarArea = `${lineFrom(solar, Yp)} L${X(24)} ${Yp(0)} L${X(0)} ${Yp(0)} Z`;
  const nowHour = Math.min(soc.length - 1, Math.round(now));

  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} width="100%" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id="pt-sa" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--solar)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--solar)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {tariff.map((b, i) => (
        <rect key={i} x={X(i)} y={PADT} width={X(i + 1) - X(i)} height={PH} fill={BANDFILL[b]} />
      ))}
      {[0, 0.5, 1].map((g, i) => (
        <line key={i} x1={PADL} y1={PADT + g * PH} x2={W - PADR} y2={PADT + g * PH} stroke="var(--grid-line)" strokeWidth="1" />
      ))}
      <path d={solarArea} fill="url(#pt-sa)" />
      <path d={lineFrom(solar, Yp)} fill="none" stroke="var(--solar)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <path
        d={lineFrom(load, Yp)}
        fill="none"
        stroke="var(--home)"
        strokeWidth="2"
        strokeDasharray="5 5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <path d={lineFrom(soc, Ys)} fill="none" stroke="var(--battery)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {actions.map((a, i) => (
        <g key={i}>
          <line x1={X(a.h)} y1={PADT + 2} x2={X(a.h)} y2={PADT + PH} stroke="var(--border-3)" strokeWidth="1" strokeDasharray="2 4" />
          <circle cx={X(a.h)} cy={PADT - 2} r="9" fill="var(--surface-3)" stroke={`var(--${a.tone})`} />
          <text x={X(a.h)} y={PADT + 2} textAnchor="middle" fill={`var(--${a.tone})`} style={{ font: '600 11px var(--font-mono)' }}>
            {i + 1}
          </text>
        </g>
      ))}
      <line x1={X(now)} y1={PADT} x2={X(now)} y2={PADT + PH} stroke="var(--text-1)" strokeWidth="1.5" />
      <circle cx={X(now)} cy={Ys(soc[nowHour])} r="4.5" fill="var(--battery)" stroke="var(--bg-0)" strokeWidth="2" />
      {tariff.map((b, i) => (
        <rect key={'s' + i} x={X(i) + 1} y={PADT + PH + 8} width={X(i + 1) - X(i) - 2} height="6" rx="2" fill={BANDSOLID[b]} opacity={b === 1 ? 0.5 : 0.9} />
      ))}
      {[0, 4, 8, 12, 16, 20, 24].map((h, i, a) => (
        <text
          key={h}
          x={X(h)}
          y={PADT + PH + 34}
          textAnchor={i === 0 ? 'start' : i === a.length - 1 ? 'end' : 'middle'}
          fill="var(--text-3)"
          style={{ font: '500 14px var(--font-mono)' }}
        >
          {String(h).padStart(2, '0')}
        </text>
      ))}
    </svg>
  );
}
