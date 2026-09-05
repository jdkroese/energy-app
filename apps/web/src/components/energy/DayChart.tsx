import { useMemo, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { Band, HistoryDayResponse } from '../../lib/types';
import { BAND_RATE, DAY_BUCKETS, bandAtHour, bucketTime, peakProduction } from '../../lib/dayMetrics';

/* ============================================================================
 * DayChart (V2, docs/53) — "The day, measured and forecast".
 *
 * One SVG, `viewBox="0 0 1000 300"`, `preserveAspectRatio="none"`, so the plot
 * stretches to the card. Every stroke carries `vector-effect="non-scaling-stroke"`
 * so the non-uniform scale doesn't distort line weights; the axis labels live in
 * HTML BELOW the SVG rather than inside it, for the same reason.
 *
 * Layer order, back to front: tariff-band grounds · grid lines · forecast veil ·
 * consumption area · production area · forecast production area · forecast lines ·
 * measured lines (draw in on mount) · SoC track · now line · crosshair.
 *
 * The headline interaction is the SCRUB: a transparent crosshair overlay reports
 * the moment under the pointer to the parent, which retargets the KPI row to that
 * timestamp. Cause and effect across two components — that is the whole point, so
 * the scrub index is owned by the screen, not by this chart.
 *
 * The API delivers 288 five-minute buckets; the curves are drawn at the design's
 * 15-minute resolution (96 points, each the mean of three buckets) — dense enough
 * to read as a continuous line, small enough that a 10 s poll doesn't rebuild
 * four 12 kB path strings every tick.
 * ==========================================================================*/

const W = 1000;
const H = 300;
/** Drawn points (15-min); 3 API buckets each. */
const P = 96;
const PER_POINT = DAY_BUCKETS / P;

/** Midpoint-cubic smoothing — the same curve shape the design prototype used. */
function smooth(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const cx = ((a[0] + b[0]) / 2).toFixed(1);
    d += ` C${cx} ${a[1].toFixed(1)} ${cx} ${b[1].toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  }
  return d;
}

/** Close a curve down to the baseline so it can be filled as an area. */
function close(d: string, x0: number, x1: number): string {
  return d ? `${d} L${x1.toFixed(1)} ${H} L${x0.toFixed(1)} ${H} Z` : '';
}

/** Mean of a 5-min series over the three buckets behind drawn point `k`. */
function meanAt(series: readonly (number | null)[] | undefined, k: number): number {
  if (!series) return 0;
  let sum = 0;
  let n = 0;
  for (let i = k * PER_POINT; i < (k + 1) * PER_POINT; i++) {
    const v = series[i];
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : 0;
}

const X = (k: number) => (k / P) * W;

export interface DayChartProps {
  day: HistoryDayResponse;
  /** Plot height in px — 300 desktop / 240 narrow / 190 phone. */
  height?: number;
  /** Scrubbed 5-minute bucket index, or null when reading live. */
  scrub: number | null;
  /** Reports the 5-minute bucket under the pointer (null on leave). */
  onScrub: (index: number | null) => void;
}

export function DayChart({ day, height = 300, scrub, onScrub }: DayChartProps) {
  const overlay = useRef<HTMLDivElement>(null);
  const nowIndex = day.nowIndex;
  const hasNow = nowIndex != null;
  // Drawn-point index of "now"; a past day is entirely measured.
  const nowK = hasNow ? Math.max(0, Math.min(P, Math.round(nowIndex / PER_POINT))) : P;

  const model = useMemo(() => {
    const s = day.series;
    const f = day.forecast;

    // Measured up to now, forecast after. A past day has no forecast at all.
    const prod: number[] = [];
    const cons: number[] = [];
    const soc: number[] = [];
    for (let k = 0; k < P; k++) {
      const measured = k <= nowK;
      prod.push(measured ? meanAt(s.solarKw, k) : meanAt(f?.solarKw, k));
      cons.push(measured ? meanAt(s.homeKw, k) : meanAt(f?.homeKw, k));
      soc.push(measured ? meanAt(s.combinedSoc, k) : meanAt(f?.combinedSoc, k));
    }

    const yMax = Math.max(1, ...prod, ...cons) * 1.16;
    const Y = (v: number) => H - (v / yMax) * (H - 14) - 6;
    const socY = (v: number) => H - 62 - (v / 100) * 178;

    const mPts = (arr: number[], to: number) =>
      arr.slice(0, to + 1).map((v, k) => [X(k), Y(v)] as [number, number]);
    const fPts = (arr: number[], from: number) =>
      arr.slice(from).map((v, i) => [X(from + i), Y(v)] as [number, number]);

    const prodLine = smooth(mPts(prod, nowK));
    const consLine = smooth(mPts(cons, nowK));
    const prodFcLine = nowK < P - 1 ? smooth(fPts(prod, nowK)) : '';
    const consFcLine = nowK < P - 1 ? smooth(fPts(cons, nowK)) : '';

    // Contiguous tariff runs become one <rect> each (P2 draws as nothing).
    const bands: { x: number; w: number; fill: string }[] = [];
    let start = 0;
    for (let h = 1; h <= 24; h++) {
      if (h === 24 || bandAtHour(day.tariffBands, h) !== bandAtHour(day.tariffBands, start)) {
        const b = bandAtHour(day.tariffBands, start);
        bands.push({
          x: (start / 24) * W,
          w: ((h - start) / 24) * W,
          fill: b === 'P1' ? 'var(--band-p1-fill)' : b === 'P3' ? 'var(--band-p3-fill)' : 'transparent',
        });
        start = h;
      }
    }

    return {
      prod,
      cons,
      soc,
      Y,
      bands,
      prodLine,
      consLine,
      prodFcLine,
      consFcLine,
      prodArea: close(prodLine, 0, X(nowK)),
      consArea: close(consLine, 0, X(nowK)),
      prodFcArea: close(prodFcLine, X(nowK), W),
      socLine: smooth(soc.map((v, k) => [X(k), socY(v)] as [number, number])),
    };
  }, [day, nowK]);

  // The tooltip reads the scrubbed sample; with no scrub it sits at "now".
  const scrubK = scrub == null ? null : Math.max(0, Math.min(P - 1, Math.round(scrub / PER_POINT)));
  const tipK = scrubK ?? Math.min(P - 1, nowK);
  const tipIndex = scrub ?? (nowIndex ?? (P - 1) * PER_POINT);
  const tipBand: Band = bandAtHour(day.tariffBands, (tipIndex * 5) / 60);
  const gridKw =
    (day.series.gridImportKw[tipIndex] ?? 0) - (day.series.gridExportKw[tipIndex] ?? 0);
  const peak = peakProduction(day);

  const move = (e: ReactMouseEvent<HTMLDivElement>) => {
    const r = overlay.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const frac = (e.clientX - r.left) / r.width;
    onScrub(Math.max(0, Math.min(DAY_BUCKETS - 1, Math.round(frac * (DAY_BUCKETS - 1)))));
  };

  const tipStyle: CSSProperties = {
    position: 'absolute',
    top: 6,
    left: `clamp(0px, calc(${((tipK / P) * 100).toFixed(2)}% - 86px), calc(100% - 172px))`,
    width: 172,
    padding: '9px 11px',
    borderRadius: 'var(--radius-md)',
    background: 'var(--surface-pop)',
    border: '1px solid var(--border-2)',
    boxShadow: 'var(--shadow-pop)',
    pointerEvents: 'none',
    opacity: scrubK == null ? 0 : 1,
    transform: scrubK == null ? 'translateY(-4px)' : 'none',
    transition: 'opacity .15s var(--ease-out), transform .15s var(--ease-out)',
  };

  const rows: { label: string; value: string; dot: CSSProperties }[] = [
    { label: 'Solar', value: `${model.prod[tipK].toFixed(1)} kW`, dot: sq('var(--solar)') },
    { label: 'Load', value: `${model.cons[tipK].toFixed(1)} kW`, dot: sq('var(--home)') },
    { label: 'Storage', value: `${Math.round(model.soc[tipK])} %`, dot: { width: 8, height: 2, borderRadius: 2, background: 'var(--series-soc-combined)', flex: 'none' } },
    { label: gridKw >= 0 ? 'Import' : 'Export', value: `${Math.abs(gridKw).toFixed(1)} kW`, dot: sq('var(--grid)') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ position: 'relative', flex: 1 }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ display: 'block', width: '100%', height }}
          role="img"
          aria-label="Production and consumption across the day, measured then forecast"
        >
          <defs>
            <linearGradient id="v2prod" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--solar)" stopOpacity=".45" />
              <stop offset="100%" stopColor="var(--solar)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="v2cons" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--home)" stopOpacity=".22" />
              <stop offset="100%" stopColor="var(--home)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {model.bands.map((b, i) => (
            <rect key={i} x={b.x} y={0} width={b.w} height={H} fill={b.fill} />
          ))}
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={0} y1={H * f} x2={W} y2={H * f} stroke="var(--grid-line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {hasNow && nowK < P && (
            <rect x={X(nowK)} y={0} width={W - X(nowK)} height={H} fill="var(--chart-forecast-veil)" />
          )}

          <path d={model.consArea} fill="url(#v2cons)" />
          <path d={model.prodArea} fill="url(#v2prod)" />
          {model.prodFcArea && <path d={model.prodFcArea} fill="url(#v2prod)" opacity=".28" />}
          {model.prodFcLine && (
            <path d={model.prodFcLine} fill="none" stroke="var(--solar)" strokeWidth={2} strokeDasharray="5 5" opacity=".6" vectorEffect="non-scaling-stroke" />
          )}
          {model.consFcLine && (
            <path d={model.consFcLine} fill="none" stroke="var(--home)" strokeWidth={1.6} strokeDasharray="4 5" opacity=".55" vectorEffect="non-scaling-stroke" />
          )}
          <path
            d={model.prodLine}
            fill="none"
            stroke="var(--solar)"
            strokeWidth={2.4}
            vectorEffect="non-scaling-stroke"
            style={{ filter: 'drop-shadow(0 0 5px color-mix(in srgb, var(--solar) 60%, transparent))', strokeDasharray: 3000, animation: 'v2draw 1.5s var(--ease-out)' }}
          />
          <path
            d={model.consLine}
            fill="none"
            stroke="var(--home)"
            strokeWidth={1.9}
            vectorEffect="non-scaling-stroke"
            style={{ strokeDasharray: 3000, animation: 'v2draw 1.7s var(--ease-out) .1s' }}
          />
          <path
            d={model.socLine}
            fill="none"
            stroke="var(--series-soc-combined)"
            strokeWidth={1.6}
            strokeDasharray="1 6"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            opacity=".95"
          />
          {hasNow && (
            <line x1={X(nowK)} y1={0} x2={X(nowK)} y2={H} stroke="var(--solar)" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity=".55" />
          )}
          {scrubK != null && (
            <line x1={X(scrubK)} y1={0} x2={X(scrubK)} y2={H} stroke="var(--text-1)" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity=".55" />
          )}
        </svg>

        {/* "now" dot, pinned to the production curve. HTML so the ping ring stays
            circular under the SVG's non-uniform scale. */}
        {hasNow && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: `${((nowK / P) * 100).toFixed(2)}%`,
              top: `calc(${((model.Y(model.prod[Math.min(P - 1, nowK)]) / H) * 100).toFixed(2)}% - 5px)`,
              width: 10,
              height: 10,
              marginLeft: -5,
              borderRadius: '50%',
              background: 'var(--solar)',
              boxShadow: '0 0 12px var(--solar)',
              pointerEvents: 'none',
            }}
          >
            <i style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--solar)', animation: 'v2ping 2.4s var(--ease-out) infinite' }} />
          </div>
        )}

        <div style={tipStyle}>
          <div className="pwr-mono" style={{ fontSize: 12, color: 'var(--text-1)', marginBottom: 5 }}>
            {bucketTime(tipIndex)} · {tipBand} · €{BAND_RATE[tipBand].toFixed(3)}
          </div>
          {rows.map((r) => (
            <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, marginTop: 3 }}>
              <i style={r.dot} />
              <span style={{ color: 'var(--text-2)' }}>{r.label}</span>
              <span className="pwr-mono" style={{ marginLeft: 'auto', color: 'var(--text-1)' }}>{r.value}</span>
            </div>
          ))}
        </div>

        <div
          ref={overlay}
          onMouseMove={move}
          onMouseLeave={() => onScrub(null)}
          style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-3)' }}>
        {['00', '04', '08', '12', '16', '20', '24'].map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingTop: 6, borderTop: '1px solid var(--border-1)' }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
          {scrub == null
            ? 'Drag across the chart to read any moment of the day.'
            : `Reading ${bucketTime(scrub)} — release to return to live.`}
        </span>
        {peak && (
          <span className="pwr-badge pwr-badge--soft" data-tone="grid" style={{ marginLeft: 'auto' }}>
            Peak {peak.kw.toFixed(1)} kW at {peak.at}
          </span>
        )}
      </div>
    </div>
  );
}

const sq = (c: string): CSSProperties => ({ width: 8, height: 8, borderRadius: 2, background: c, flex: 'none' });
