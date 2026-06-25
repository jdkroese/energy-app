import { useId, useState } from 'react';

/**
 * One toggleable series on the day chart. `axis` picks the scale (kW on the left,
 * % on the right); `kind` picks area vs line. `defaultOn: false` starts hidden.
 */
export interface DaySeriesDef {
  key: string;
  label: string;
  color: string;
  axis: 'power' | 'soc';
  kind: 'area' | 'line';
  data: number[];
  dash?: boolean;
  defaultOn?: boolean;
}

const W = 1000;
const X_LABELS = ['00', '04', '08', '12', '16', '20', '24'];

/**
 * DayChart — today's energy curves on a dual axis (kW left, SoC % right) with a
 * click-to-toggle legend and a dotted "now" marker. Data is 24 hourly buckets in
 * Madrid time; everything past `nowHour` is dropped so we only draw the day so far.
 */
export function DayChart({
  series,
  nowHour,
  height = 220,
}: {
  series: DaySeriesDef[];
  nowHour: number;
  height?: number;
}) {
  const uid = 'd' + useId().replace(/:/g, '');
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(series.filter((s) => s.defaultOn === false).map((s) => s.key)),
  );
  const toggle = (k: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const H = height;
  const padY = 18;
  const plotH = H - padY * 2;
  const baseY = H - padY;

  const clampedNow = Math.max(0, Math.min(24, nowHour));
  const x = (h: number) => (h / 24) * W;
  const nowX = x(clampedNow);
  const nowIdx = Math.max(0, Math.min(23, Math.floor(clampedNow)));

  const visible = series.filter((s) => !hidden.has(s.key));
  const niceMax = Math.ceil(
    Math.max(
      1,
      ...visible
        .filter((s) => s.axis === 'power')
        .flatMap((s) => s.data.slice(0, nowIdx + 1)),
    ),
  );
  const hasSoc = visible.some((s) => s.axis === 'soc');

  const yOf = (s: DaySeriesDef, v: number) =>
    s.axis === 'soc'
      ? padY + (1 - v / 100) * plotH
      : padY + (1 - v / niceMax) * plotH;

  function pathFor(s: DaySeriesDef) {
    const pts = s.data.slice(0, nowIdx + 1).map((v, i) => [x(i), yOf(s, v)] as const);
    if (pts.length === 0) return { line: '', area: '' };
    const line = pts.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const lastX = pts[pts.length - 1][0].toFixed(1);
    const firstX = pts[0][0].toFixed(1);
    return { line, area: `${line} L${lastX} ${baseY} L${firstX} ${baseY} Z` };
  }

  // Draw areas first so line series stay readable on top of them.
  const drawOrder = [...visible].sort(
    (a, b) => (a.kind === 'area' ? 0 : 1) - (b.kind === 'area' ? 0 : 1),
  );

  const grids = [0, 0.25, 0.5, 0.75, 1];
  const nh = Math.floor(clampedNow);
  const nm = Math.min(59, Math.round((clampedNow - nh) * 60));
  const nowLabel = `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;

  return (
    <div>
      {/* legend — click a chip to show/hide that series */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 14 }}>
        {series.map((s) => {
          const off = hidden.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              aria-pressed={!off}
              title={off ? `Show ${s.label}` : `Hide ${s.label}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 9px',
                borderRadius: 999,
                border: '1px solid var(--border-1)',
                background: off ? 'transparent' : 'var(--bg-1)',
                color: off ? 'var(--text-3)' : 'var(--text-1)',
                fontSize: 12,
                fontWeight: 500,
                lineHeight: 1.2,
                cursor: 'pointer',
                opacity: off ? 0.6 : 1,
                transition: 'opacity .12s, background .12s',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 12,
                  height: s.kind === 'area' ? 10 : 3,
                  borderRadius: s.kind === 'area' ? 3 : 2,
                  background: s.color,
                  ...(s.dash
                    ? { backgroundImage: `repeating-linear-gradient(90deg, ${s.color} 0 4px, transparent 4px 7px)`, background: undefined }
                    : {}),
                }}
              />
              <span style={{ textDecoration: off ? 'line-through' : 'none' }}>{s.label}</span>
            </button>
          );
        })}
      </div>

      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${W} ${H + 26}`}
          width="100%"
          preserveAspectRatio="none"
          role="img"
          aria-label="Today's production, consumption, battery flow and state of charge by hour"
          style={{ display: 'block', overflow: 'visible' }}
        >
          <defs>
            {drawOrder
              .filter((s) => s.kind === 'area')
              .map((s) => (
                <linearGradient key={s.key} id={`${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity="0.24" />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              ))}
          </defs>

          {/* gridlines + axes (kW left, % right) */}
          {grids.map((g, i) => {
            const yy = padY + g * plotH;
            return (
              <g key={i}>
                <line x1="0" y1={yy} x2={W} y2={yy} stroke="var(--grid-line)" strokeWidth="1" />
                <text x="4" y={yy - 5} fill="var(--text-3)" style={{ font: '500 15px var(--font-mono)' }}>
                  {Math.round(niceMax * (1 - g))}
                </text>
                {hasSoc && (
                  <text
                    x={W - 4}
                    y={yy - 5}
                    textAnchor="end"
                    fill="var(--text-3)"
                    style={{ font: '500 15px var(--font-mono)' }}
                  >
                    {Math.round(100 * (1 - g))}%
                  </text>
                )}
              </g>
            );
          })}

          {/* series */}
          {drawOrder.map((s) => {
            const { line, area } = pathFor(s);
            if (!line) return null;
            return (
              <g key={s.key}>
                {s.kind === 'area' && <path d={area} fill={`url(#${uid}-${s.key})`} />}
                <path
                  d={line}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.dash ? 2 : 2.4}
                  strokeDasharray={s.dash ? '5 5' : undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}

          {/* "now" marker */}
          <line
            x1={nowX}
            y1={padY - 6}
            x2={nowX}
            y2={baseY}
            stroke="var(--text-2)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />

          {/* x axis (hours) */}
          {X_LABELS.map((lb, i, a) => (
            <text
              key={lb}
              x={x(Number(lb))}
              y={H + 16}
              textAnchor={i === 0 ? 'start' : i === a.length - 1 ? 'end' : 'middle'}
              fill="var(--text-3)"
              style={{ font: '500 15px var(--font-mono)' }}
            >
              {lb}
            </text>
          ))}
        </svg>

        {/* now time label — HTML overlay so it stays crisp (SVG text is stretched) */}
        <div
          style={{
            position: 'absolute',
            top: -3,
            left: `${(clampedNow / 24) * 100}%`,
            transform: 'translateX(-50%)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-2)',
            background: 'var(--bg-1)',
            padding: '1px 5px',
            borderRadius: 5,
            border: '1px solid var(--border-1)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {nowLabel}
        </div>
      </div>
    </div>
  );
}

/** Build the toggleable series list for the Live day chart from a LiveResponse.day. */
export function liveDaySeries(day: {
  solarKw: number[];
  homeKw: number[];
  chargeKw: number[];
  dischargeKw: number[];
  gridImportKw: number[];
  gridExportKw: number[];
  sonnenSoc: number[];
  teslaSoc: number[];
  combinedSoc: number[];
}): DaySeriesDef[] {
  return [
    { key: 'production', label: 'Production', color: 'var(--solar)', axis: 'power', kind: 'area', data: day.solarKw },
    { key: 'consumption', label: 'Consumption', color: 'var(--home)', axis: 'power', kind: 'line', data: day.homeKw },
    { key: 'charge', label: 'Charging', color: 'var(--battery)', axis: 'power', kind: 'line', data: day.chargeKw, defaultOn: false },
    { key: 'discharge', label: 'Discharging', color: '#f5736b', axis: 'power', kind: 'line', data: day.dischargeKw, defaultOn: false },
    { key: 'gridExport', label: 'Grid feed-in', color: 'var(--grid)', axis: 'power', kind: 'line', data: day.gridExportKw, defaultOn: false },
    { key: 'gridImport', label: 'Grid buy', color: '#ff6b8a', axis: 'power', kind: 'line', data: day.gridImportKw, defaultOn: false },
    { key: 'socCombined', label: 'SoC · combined', color: '#2dd4bf', axis: 'soc', kind: 'area', data: day.combinedSoc },
    { key: 'socSonnen', label: 'SoC · Sonnen', color: '#8bd450', axis: 'soc', kind: 'line', data: day.sonnenSoc, dash: true, defaultOn: false },
    { key: 'socTesla', label: 'SoC · Tesla', color: '#5ac8fa', axis: 'soc', kind: 'line', data: day.teslaSoc, dash: true, defaultOn: false },
  ];
}
