import { useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { HistoryDayResponse, TariffBandSegment } from '../../lib/types';
import { useTheme } from '../../lib/ThemeProvider';

/* ============================================================================
 * DayChart — the Live screen's "Production & consumption" day chart.
 *
 * 5-minute resolution (288 buckets/day) with a MEASURED vs FORECAST split at
 * "now": left of the now-line is measured (solid lines, production a filled
 * area); right of it is forecast (dashed lines on a faintly shaded panel). Dual
 * axis (kW left, SoC % right), a bottom tariff strip (P1/P2/P3), a peak-
 * production marker, an interactive hover crosshair + tooltip, pill-chip legend
 * toggles, prev/next day navigation, and a forecast on/off toggle.
 *
 * Self-contained: it consumes a HistoryDayResponse and renders an SVG plot with
 * an HTML overlay for crisp tooltips. Power design tokens only.
 * ==========================================================================*/

const N = 288; // 5-min buckets/day
const W = 1000; // SVG user-space width (stretched to container)

// ---- Series catalogue ------------------------------------------------------

type SeriesKey =
  | 'production'
  | 'consumption'
  | 'charge'
  | 'discharge'
  | 'gridExport'
  | 'gridImport'
  | 'socCombined'
  | 'socSonnen'
  | 'socTesla';

interface SeriesDef {
  key: SeriesKey;
  /** Source field in HistoryDayResponse.series / .forecast. */
  field:
    | 'solarKw'
    | 'homeKw'
    | 'chargeKw'
    | 'dischargeKw'
    | 'gridExportKw'
    | 'gridImportKw'
    | 'combinedSoc'
    | 'sonnenSoc'
    | 'teslaSoc';
  label: string;
  /** CSS custom property (without var()) that holds this series' colour. */
  colorVar: string;
  axis: 'power' | 'soc';
  kind: 'area' | 'line';
  dash?: boolean;
  defaultOn: boolean;
}

const SERIES: SeriesDef[] = [
  { key: 'production', field: 'solarKw', label: 'Production', colorVar: '--series-production', axis: 'power', kind: 'area', defaultOn: true },
  { key: 'consumption', field: 'homeKw', label: 'Consumption', colorVar: '--series-consumption', axis: 'power', kind: 'line', defaultOn: true },
  { key: 'charge', field: 'chargeKw', label: 'Charging', colorVar: '--series-charge', axis: 'power', kind: 'line', defaultOn: true },
  { key: 'discharge', field: 'dischargeKw', label: 'Discharging', colorVar: '--series-discharge', axis: 'power', kind: 'line', defaultOn: false },
  { key: 'gridExport', field: 'gridExportKw', label: 'Grid feed-in', colorVar: '--series-grid-export', axis: 'power', kind: 'line', defaultOn: false },
  { key: 'gridImport', field: 'gridImportKw', label: 'Grid buy', colorVar: '--series-grid-import', axis: 'power', kind: 'line', defaultOn: false },
  { key: 'socCombined', field: 'combinedSoc', label: 'SoC · combined', colorVar: '--series-soc-combined', axis: 'soc', kind: 'line', defaultOn: true },
  { key: 'socSonnen', field: 'sonnenSoc', label: 'SoC · Sonnen', colorVar: '--series-soc-sonnen', axis: 'soc', kind: 'line', dash: true, defaultOn: false },
  { key: 'socTesla', field: 'teslaSoc', label: 'SoC · Tesla', colorVar: '--series-soc-tesla', axis: 'soc', kind: 'line', dash: true, defaultOn: false },
];

const BAND_VAR: Record<string, string> = {
  P1: '--band-p1',
  P2: '--band-p2',
  P3: '--band-p3',
};
const BAND_LABEL: Record<string, string> = { P1: 'peak', P2: 'shoulder', P3: 'valley' };

/* Series/band colours live as CSS vars (so a future light theme can override
 * them). SVG needs concrete values, so resolve the tokens to hex via
 * getComputedStyle. Fallbacks keep dark-theme output identical if a var is
 * missing (e.g. during SSR/first paint). */
const COLOR_FALLBACK: Record<string, string> = {
  '--series-production': '#2ee6a0',
  '--series-consumption': '#c4a6ff',
  '--series-charge': '#38d9f5',
  '--series-discharge': '#f5736b',
  '--series-grid-export': '#f5a524',
  '--series-grid-import': '#ff6b8a',
  '--series-soc-combined': '#2dd4bf',
  '--series-soc-sonnen': '#8bd450',
  '--series-soc-tesla': '#5ac8fa',
  '--band-p1': '#f5a524',
  '--band-p2': '#5f7672',
  '--band-p3': '#2ee6a0',
};

function resolveToken(name: string): string {
  const fallback = COLOR_FALLBACK[name] ?? '#5f7672';
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// ---- Helpers ---------------------------------------------------------------

function niceMaxOf(values: number[]): number {
  const m = Math.max(1, ...values.filter((v) => Number.isFinite(v)));
  // Round up to a friendly step.
  const pow = Math.pow(10, Math.floor(Math.log10(m)));
  const n = m / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function bucketTime(i: number): string {
  const mins = i * 5;
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const X_TICKS = [0, 48, 96, 144, 192, 240, 288]; // every 4h

// ---- Component -------------------------------------------------------------

export function DayChart({
  day,
  height = 240,
  onPrev,
  onNext,
  loading = false,
}: {
  day: HistoryDayResponse;
  height?: number;
  onPrev?: () => void;
  onNext?: () => void;
  loading?: boolean;
}) {
  const uid = 'd' + useId().replace(/:/g, '');
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Active resolved theme — drives re-resolution of the CSS-var → hex colours
  // below, so the SVG re-colours when the user switches dark ⇄ light.
  const { resolved: theme } = useTheme();

  // Resolve series/band CSS tokens to concrete colours for the SVG. Memoized on
  // `theme` so a theme switch re-reads the (now light/dark) token values.
  const colorOf = useMemo(() => {
    const m = new Map<SeriesKey, string>();
    for (const s of SERIES) m.set(s.key, resolveToken(s.colorVar));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
  const bandColor = useMemo(
    () => ({
      P1: resolveToken(BAND_VAR.P1),
      P2: resolveToken(BAND_VAR.P2),
      P3: resolveToken(BAND_VAR.P3),
    } as Record<string, string>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme],
  );
  const productionColor = colorOf.get('production') ?? COLOR_FALLBACK['--series-production'];

  const [hidden, setHidden] = useState<Set<SeriesKey>>(
    () => new Set(SERIES.filter((s) => !s.defaultOn).map((s) => s.key)),
  );
  const [showForecast, setShowForecast] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const toggle = (k: SeriesKey) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const isToday = day.nowIndex != null;
  const nowIdx = day.nowIndex ?? N;
  const forecastOn = showForecast && isToday && day.forecast != null;

  // Geometry.
  const H = height;
  const padTop = 16;
  const padBottom = 22; // room for x labels
  const stripH = 6; // tariff strip
  const plotTop = padTop;
  const plotBottom = H - padBottom - stripH - 4;
  const plotH = plotBottom - plotTop;
  const x = (i: number) => (i / (N - 1)) * W;
  const nowX = x(nowIdx);

  const visible = useMemo(() => SERIES.filter((s) => !hidden.has(s.key)), [hidden]);

  // Merge measured + (optional) forecast into one 288-length array per series.
  const merged = useMemo(() => {
    const m = new Map<SeriesKey, (number | null)[]>();
    for (const s of SERIES) {
      const meas = day.series[s.field] ?? [];
      const fc = forecastOn ? day.forecast?.[s.field] ?? [] : [];
      const arr: (number | null)[] = new Array(N).fill(null);
      for (let i = 0; i < N; i++) {
        if (i < nowIdx) {
          arr[i] = typeof meas[i] === 'number' ? meas[i] : null;
        } else {
          const fv = fc[i];
          arr[i] = typeof fv === 'number' ? fv : typeof meas[i] === 'number' ? meas[i] : null;
        }
      }
      m.set(s.key, arr);
    }
    return m;
  }, [day, forecastOn, nowIdx]);

  // kW axis max from visible power series (measured + forecast both count).
  const niceMax = useMemo(() => {
    const vals: number[] = [];
    for (const s of visible) {
      if (s.axis !== 'power') continue;
      for (const v of merged.get(s.key) ?? []) if (typeof v === 'number') vals.push(v);
    }
    return niceMaxOf(vals);
  }, [visible, merged]);

  const hasSoc = visible.some((s) => s.axis === 'soc');

  const yOf = (s: SeriesDef, v: number) =>
    s.axis === 'soc'
      ? plotTop + (1 - v / 100) * plotH
      : plotTop + (1 - v / niceMax) * plotH;

  // Build measured + forecast path strings for a series (split at nowIdx so the
  // measured part is solid and the forecast part dashed).
  function paths(s: SeriesDef) {
    const arr = merged.get(s.key) ?? [];
    const measPts: Array<[number, number]> = [];
    const fcPts: Array<[number, number]> = [];
    for (let i = 0; i < N; i++) {
      const v = arr[i];
      if (typeof v !== 'number') continue;
      const p: [number, number] = [x(i), yOf(s, v)];
      if (i <= nowIdx) measPts.push(p);
      if (forecastOn && i >= nowIdx) fcPts.push(p);
    }
    const toLine = (pts: Array<[number, number]>) =>
      pts.length
        ? pts.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
        : '';
    const measLine = toLine(measPts);
    let area = '';
    if (s.kind === 'area' && measPts.length) {
      const lastX = measPts[measPts.length - 1][0].toFixed(1);
      const firstX = measPts[0][0].toFixed(1);
      area = `${measLine} L${lastX} ${plotBottom} L${firstX} ${plotBottom} Z`;
    }
    return { measLine, fcLine: toLine(fcPts), area };
  }

  // Draw areas first so lines stay readable on top.
  const drawOrder = [...visible].sort(
    (a, b) => (a.kind === 'area' ? 0 : 1) - (b.kind === 'area' ? 0 : 1),
  );

  // Peak measured production marker.
  const peak = useMemo(() => {
    const prod = day.series.solarKw ?? [];
    let bi = -1;
    let bv = -Infinity;
    const limit = isToday ? nowIdx : N - 1;
    for (let i = 0; i <= limit && i < prod.length; i++) {
      if (typeof prod[i] === 'number' && prod[i] > bv) {
        bv = prod[i];
        bi = i;
      }
    }
    return bi >= 0 && bv > 0.05 ? { i: bi, v: bv } : null;
  }, [day, isToday, nowIdx]);

  const grids = [0, 0.25, 0.5, 0.75, 1];

  // Hover → nearest 5-min bucket.
  function onMove(e: ReactPointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(N - 1, Math.round(frac * (N - 1))));
    setHoverIdx(i);
  }

  const hoverIsForecast = hoverIdx != null && isToday && hoverIdx > nowIdx;
  const hoverX = hoverIdx != null ? x(hoverIdx) : 0;
  const hoverPct = hoverIdx != null ? (hoverIdx / (N - 1)) * 100 : 0;

  // Tooltip rows for the hovered bucket.
  const hoverRows =
    hoverIdx == null
      ? []
      : visible
          .map((s) => {
            const v = merged.get(s.key)?.[hoverIdx];
            if (typeof v !== 'number') return null;
            return {
              key: s.key,
              label: s.label,
              color: colorOf.get(s.key) ?? COLOR_FALLBACK[s.colorVar],
              text: s.axis === 'soc' ? `${Math.round(v)}%` : `${v.toFixed(2)} kW`,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r != null);

  const ariaLabel =
    `Production, consumption, battery flow and state of charge for ${day.date}` +
    (isToday ? ', measured so far plus forecast for the rest of the day' : ', measured');

  return (
    <div>
      {/* top bar: day nav + forecast toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <NavBtn label="Previous day" dir="prev" disabled={!day.hasPrev || loading} onClick={onPrev} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-1)', minWidth: 116, textAlign: 'center' }}>
            {isToday ? 'Today' : day.date}
          </span>
          <NavBtn label="Next day" dir="next" disabled={!day.hasNext || loading} onClick={onNext} />
        </div>
        {isToday && day.forecast != null && (
          <button
            type="button"
            onClick={() => setShowForecast((v) => !v)}
            aria-pressed={showForecast}
            title={showForecast ? 'Hide forecast' : 'Show forecast'}
            style={chip(showForecast)}
          >
            <span aria-hidden style={{ width: 12, height: 0, borderTop: `2px dashed var(--text-2)` }} />
            Forecast
          </button>
        )}
      </div>

      {/* legend — click a chip to show/hide that series */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
        {SERIES.map((s) => {
          const off = hidden.has(s.key);
          const c = colorOf.get(s.key) ?? COLOR_FALLBACK[s.colorVar];
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              aria-pressed={!off}
              title={off ? `Show ${s.label}` : `Hide ${s.label}`}
              style={chip(!off)}
            >
              <span
                aria-hidden
                style={{
                  width: 12,
                  height: s.kind === 'area' ? 10 : 3,
                  borderRadius: s.kind === 'area' ? 3 : 2,
                  background: s.dash
                    ? undefined
                    : c,
                  backgroundImage: s.dash
                    ? `repeating-linear-gradient(90deg, ${c} 0 4px, transparent 4px 7px)`
                    : undefined,
                }}
              />
              <span style={{ textDecoration: off ? 'line-through' : 'none' }}>{s.label}</span>
            </button>
          );
        })}
      </div>

      <div style={{ position: 'relative' }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          preserveAspectRatio="none"
          role="img"
          aria-label={ariaLabel}
          style={{ display: 'block', overflow: 'visible', touchAction: 'none' }}
          onPointerMove={onMove}
          onPointerLeave={() => setHoverIdx(null)}
        >
          <defs>
            {drawOrder
              .filter((s) => s.kind === 'area')
              .map((s) => (
                <linearGradient key={s.key} id={`${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colorOf.get(s.key)} stopOpacity="0.24" />
                  <stop offset="100%" stopColor={colorOf.get(s.key)} stopOpacity="0" />
                </linearGradient>
              ))}
          </defs>

          {/* forecast shaded panel (right of now) */}
          {forecastOn && nowX < W && (
            <rect
              x={nowX}
              y={plotTop}
              width={W - nowX}
              height={plotH}
              fill="var(--grid-line)"
            />
          )}

          {/* horizontal gridlines + axes (kW left, % right) */}
          {grids.map((g, i) => {
            const yy = plotTop + g * plotH;
            return (
              <g key={i}>
                <line x1="0" y1={yy} x2={W} y2={yy} stroke="var(--grid-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <text x="4" y={yy - 4} fill="var(--text-3)" style={{ font: '500 13px var(--font-mono)' }}>
                  {Math.round(niceMax * (1 - g))}
                </text>
                {hasSoc && (
                  <text x={W - 4} y={yy - 4} textAnchor="end" fill="var(--text-3)" style={{ font: '500 13px var(--font-mono)' }}>
                    {Math.round(100 * (1 - g))}%
                  </text>
                )}
              </g>
            );
          })}

          {/* series (measured solid + forecast dashed) */}
          {drawOrder.map((s) => {
            const { measLine, fcLine, area } = paths(s);
            const c = colorOf.get(s.key);
            return (
              <g key={s.key}>
                {s.kind === 'area' && area && <path d={area} fill={`url(#${uid}-${s.key})`} />}
                {measLine && (
                  <path
                    d={measLine}
                    fill="none"
                    stroke={c}
                    strokeWidth={s.dash ? 1.8 : 2.2}
                    strokeDasharray={s.dash ? '5 5' : undefined}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {forecastOn && fcLine && (
                  <path
                    d={fcLine}
                    fill="none"
                    stroke={c}
                    strokeWidth={1.8}
                    strokeDasharray="4 4"
                    strokeOpacity={0.85}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </g>
            );
          })}

          {/* peak-production marker */}
          {peak && !hidden.has('production') && (
            <g>
              <circle cx={x(peak.i)} cy={yOf(SERIES[0], peak.v)} r="3.2" fill={productionColor} stroke="var(--bg-1, #06090b)" strokeWidth="1.5" />
            </g>
          )}

          {/* now marker (today only) */}
          {isToday && (
            <line
              x1={nowX}
              y1={plotTop - 6}
              x2={nowX}
              y2={plotBottom}
              stroke="var(--text-2)"
              strokeWidth="1.5"
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* hover crosshair + dots */}
          {hoverIdx != null && (
            <g>
              <line x1={hoverX} y1={plotTop} x2={hoverX} y2={plotBottom} stroke="var(--text-1)" strokeOpacity="0.35" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {visible.map((s) => {
                const v = merged.get(s.key)?.[hoverIdx];
                if (typeof v !== 'number') return null;
                return <circle key={s.key} cx={hoverX} cy={yOf(s, v)} r="2.8" fill={colorOf.get(s.key)} stroke="var(--bg-1, #06090b)" strokeWidth="1.2" />;
              })}
            </g>
          )}

          {/* tariff strip along the bottom of the plot */}
          {day.tariffBands.map((seg, i) => (
            <TariffSeg key={i} seg={seg} y={plotBottom + 4} h={stripH} fill={bandColor[seg.band] ?? bandColor.P2} />
          ))}

          {/* x axis (hours) */}
          {X_TICKS.map((i, k, a) => (
            <text
              key={i}
              x={x(Math.min(i, N - 1))}
              y={H - 4}
              textAnchor={k === 0 ? 'start' : k === a.length - 1 ? 'end' : 'middle'}
              fill="var(--text-3)"
              style={{ font: '500 13px var(--font-mono)' }}
            >
              {String(Math.min(24, i / 12)).padStart(2, '0')}
            </text>
          ))}
        </svg>

        {/* FORECAST label (HTML overlay, crisp) */}
        {forecastOn && nowX < W * 0.95 && (
          <div
            style={{
              position: 'absolute',
              top: 2,
              left: `calc(${(nowIdx / (N - 1)) * 100}% + 6px)`,
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: 0.8,
              color: 'var(--text-3)',
              pointerEvents: 'none',
            }}
          >
            FORECAST
          </div>
        )}

        {/* now time label */}
        {isToday && (
          <div
            style={{
              position: 'absolute',
              top: -3,
              left: `${(nowIdx / (N - 1)) * 100}%`,
              transform: 'translateX(-50%)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-2)',
              background: 'var(--bg-1, #06090b)',
              padding: '1px 5px',
              borderRadius: 5,
              border: '1px solid var(--border-1)',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            {bucketTime(nowIdx)}
          </div>
        )}

        {/* peak label */}
        {peak && !hidden.has('production') && (
          <div
            style={{
              position: 'absolute',
              top: `calc(${(yOf(SERIES[0], peak.v) / H) * 100}% - 18px)`,
              left: `${(peak.i / (N - 1)) * 100}%`,
              transform: 'translateX(-50%)',
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              fontWeight: 600,
              color: 'var(--series-production)',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            {peak.v.toFixed(1)} kW
          </div>
        )}

        {/* hover tooltip (HTML overlay) */}
        {hoverIdx != null && hoverRows.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 6,
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
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>
                {bucketTime(hoverIdx)}
              </span>
              <span
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  textTransform: 'uppercase',
                  color: hoverIsForecast ? 'var(--grid)' : 'var(--text-3)',
                }}
              >
                {hoverIsForecast ? 'forecast' : 'measured'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {hoverRows.map((r) => (
                <div key={r.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-2)' }}>
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: r.color }} />
                    {r.label}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-1)' }}>{r.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Small pieces ----------------------------------------------------------

function TariffSeg({ seg, y, h, fill }: { seg: TariffBandSegment; y: number; h: number; fill: string }) {
  const x0 = (seg.startH / 24) * W;
  const x1 = (seg.endH / 24) * W;
  return (
    <rect
      x={x0}
      y={y}
      width={Math.max(0, x1 - x0)}
      height={h}
      rx={1.5}
      fill={fill}
      fillOpacity={0.28}
    >
      <title>{`${seg.band} · ${BAND_LABEL[seg.band] ?? ''} ${String(seg.startH).padStart(2, '0')}:00–${String(seg.endH).padStart(2, '0')}:00`}</title>
    </rect>
  );
}

function NavBtn({
  label,
  dir,
  disabled,
  onClick,
}: {
  label: string;
  dir: 'prev' | 'next';
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 7,
        border: '1px solid var(--border-1)',
        background: 'var(--surface-1, #0f1619)',
        color: disabled ? 'var(--text-3)' : 'var(--text-1)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        padding: 0,
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {dir === 'prev' ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
      </svg>
    </button>
  );
}

function chip(on: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 9px',
    borderRadius: 999,
    border: '1px solid var(--border-1)',
    background: on ? 'var(--surface-1, #0f1619)' : 'transparent',
    color: on ? 'var(--text-1)' : 'var(--text-3)',
    fontSize: 12,
    fontWeight: 500,
    lineHeight: 1.2,
    cursor: 'pointer',
    opacity: on ? 1 : 0.6,
    transition: 'opacity .12s, background .12s',
  };
}
