import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlanAction } from '../../lib/types';

/* ============================================================================
 * PlanTimeline — the brain's next-24 h plan, top → bottom:
 *   (a) per-hour 5-bar sun-intensity meter
 *   (b) predicted-generation row (gold mono kWh per daytime hour)
 *   (c) event lane — each action a duration bar (greedy row-stacked)
 *   (d) chart — tariff tints, gridlines, solar area+line, dashed load, SoC,
 *       pulsing now-marker, hover scrubber
 *   (e) tariff strip with per-segment P1/P2/P3 labels + legend
 *
 * Responsive: one SVG (viewBox 960×416) scaled to width; hover on desktop,
 * tap on mobile. Animations gated behind prefers-reduced-motion.
 * ==========================================================================*/

const VBW = 960;
const VBH = 416;
const PADL = 44;
const PADR = 16;
const COLW = (VBW - PADL - PADR) / 24;

// vertical anchors
const STRIP_Y = 8; // sun-meter block top
const SUN_BARS = 5;
const SUN_BAR_H = 8;
const SUN_BAR_GAP = 2;
const KWH_Y = 72; // baseline for the kWh integers
const LANE_Y = 80; // event lane top
const ROW_H = 15;
const ROW_GAP = 4;
const PH = 246; // chart plot height
const SMAX = 14; // kW axis max

const BANDFILL = ['rgba(46,230,160,.05)', 'transparent', 'rgba(245,165,36,.10)'];
const BAND_LABEL = ['P3', 'P2', 'P1'];
const BAND_RATE = ['€0.078', '€0.131', '€0.209'];
const BAND_COLOR = ['var(--solar)', 'var(--text-3)', 'var(--grid)'];

// sun gradient stops (lit)
const SUN_LIT = ['#f5c518', '#ffd24a', '#ffe27a'];
const SUN_UNLIT = 'rgba(245,197,24,.10)';
const GOLD = '#ffd24a';

type Props = {
  /** 25-length (0..24) solar forecast in kW */
  solar: number[];
  /** 25-length house load in kW */
  load: number[];
  /** 25-length battery SoC plan in % */
  soc: number[];
  /** 24-length tariff band index per hour (0/1/2) */
  tariff: number[];
  /** 25-length sun-intensity % per hour (0..24) */
  sunIntensityPct: number[];
  /** 25-length predicted generation kWh per hour (0..24) */
  genKwh: number[];
  actions: PlanAction[];
  /** current time as a fractional hour, e.g. 16.8 */
  now: number;
  /** desktop vs mobile (drives hit-target sizing + hover vs tap) */
  wide?: boolean;
};

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduce(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduce;
}

/** Greedy row-stacking: place each bar in the first lane whose last bar ended. */
function stackRows(actions: PlanAction[]): number[] {
  const laneEnds: number[] = [];
  return actions.map((a) => {
    for (let r = 0; r < laneEnds.length; r++) {
      if (a.startH >= laneEnds[r] - 1e-6) {
        laneEnds[r] = a.endH;
        return r;
      }
    }
    laneEnds.push(a.endH);
    return laneEnds.length - 1;
  });
}

export function PlanTimeline({
  solar,
  load,
  soc,
  tariff,
  sunIntensityPct,
  genKwh,
  actions,
  now,
  wide = true,
}: Props) {
  const reduce = usePrefersReducedMotion();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverH, setHoverH] = useState<number | null>(null);
  const [activeEvent, setActiveEvent] = useState<number | null>(null);

  const X = (h: number) => PADL + h * COLW;
  const colCenter = (i: number) => PADL + (i + 0.5) * COLW;

  // chart plot region
  const rows = useMemo(() => stackRows(actions), [actions]);
  const rowCount = rows.length ? Math.max(...rows) + 1 : 1;
  const laneH = rowCount * ROW_H + (rowCount - 1) * ROW_GAP;
  const PT = LANE_Y + laneH + 16; // chart top, below the event lane
  const Yp = (v: number) => PT + (1 - v / SMAX) * PH;
  const Ys = (v: number) => PT + (1 - v / 100) * PH; // SoC right scale 0..100

  const lineFrom = (arr: number[], Y: (v: number) => number) =>
    arr.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
  const solarArea = `${lineFrom(solar, Yp)} L${X(solar.length - 1).toFixed(1)} ${Yp(0).toFixed(1)} L${X(0)} ${Yp(0).toFixed(1)} Z`;

  const nowIdx = Math.min(soc.length - 1, Math.max(0, Math.round(now)));

  // pointer → nearest hour
  const onMove = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xVB = ((clientX - rect.left) / rect.width) * VBW;
    const h = Math.round((xVB - PADL) / COLW);
    setHoverH(Math.max(0, Math.min(23, h)));
  };

  // active scrub/event windows for chart shading
  const scrubH = hoverH;
  const activeAction = activeEvent != null ? actions[activeEvent] : null;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VBW} ${VBH}`}
        width="100%"
        style={{ display: 'block', overflow: 'visible', touchAction: 'none' }}
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHoverH(null)}
        onTouchStart={(e) => e.touches[0] && onMove(e.touches[0].clientX)}
        onTouchMove={(e) => e.touches[0] && onMove(e.touches[0].clientX)}
      >
        <defs>
          <linearGradient id="pt-sa" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--solar)" stopOpacity="0.26" />
            <stop offset="100%" stopColor="var(--solar)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="pt-sun" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor={SUN_LIT[0]} />
            <stop offset="55%" stopColor={SUN_LIT[1]} />
            <stop offset="100%" stopColor={SUN_LIT[2]} />
          </linearGradient>
          <style>{`
            @keyframes pt-pulse { 0%,100%{opacity:.55;r:5} 50%{opacity:0;r:11} }
            @keyframes pt-bar-in { from{transform:scaleY(0)} to{transform:scaleY(1)} }
            @keyframes pt-grow { from{transform:scaleX(0)} to{transform:scaleX(1)} }
            .pt-sunbar{ transform-box:fill-box; transform-origin:center bottom; }
            .pt-evbar{ transform-box:fill-box; transform-origin:left center; }
            ${reduce ? '' : `
            .pt-sunbar{ animation:pt-bar-in .5s var(--ease-out,ease-out) both; }
            .pt-evbar{ animation:pt-grow .55s var(--ease-out,ease-out) both; }
            .pt-curve{ stroke-dasharray:1; stroke-dashoffset:1; pathLength:1; animation:pt-draw 1.1s var(--ease-out,ease-out) forwards; }
            @keyframes pt-draw { to{stroke-dashoffset:0} }
            .pt-now-ring{ animation:pt-pulse 1.8s ease-in-out infinite; }
            `}
          `}</style>
        </defs>

        {/* ---- gutter labels ---- */}
        <text x={PADL - 8} y={STRIP_Y + (SUN_BARS * (SUN_BAR_H + SUN_BAR_GAP)) / 2} textAnchor="end" fill="var(--text-3)" style={{ font: '500 10px var(--font-mono)' }}>sun</text>
        <text x={PADL - 8} y={KWH_Y + 3} textAnchor="end" fill={GOLD} style={{ font: '600 10px var(--font-mono)', opacity: 0.8 }}>kWh</text>

        {/* ---- (a) sun-intensity 5-bar meter ---- */}
        {Array.from({ length: 24 }, (_, i) => {
          const pct = sunIntensityPct[i] ?? 0;
          const lit = Math.round(pct / 20);
          const cx = colCenter(i);
          const bw = Math.min(COLW - 6, 22);
          return (
            <g key={`sun-${i}`}>
              {Array.from({ length: SUN_BARS }, (_, b) => {
                const isLit = b < lit;
                // bar 0 = bottom row
                const y = STRIP_Y + (SUN_BARS - 1 - b) * (SUN_BAR_H + SUN_BAR_GAP);
                return (
                  <rect
                    key={b}
                    className={isLit ? 'pt-sunbar' : undefined}
                    x={cx - bw / 2}
                    y={y}
                    width={bw}
                    height={SUN_BAR_H}
                    rx={1.5}
                    fill={isLit ? 'url(#pt-sun)' : SUN_UNLIT}
                    style={reduce ? undefined : { animationDelay: `${i * 18 + b * 30}ms` }}
                  />
                );
              })}
            </g>
          );
        })}

        {/* ---- (b) predicted-kWh row ---- */}
        {Array.from({ length: 24 }, (_, i) => {
          const g = genKwh[i] ?? 0;
          if (g < 0.5) return null;
          return (
            <text key={`g-${i}`} x={colCenter(i)} y={KWH_Y + 3} textAnchor="middle" fill={GOLD} style={{ font: '600 11px var(--font-mono)' }}>
              {Math.round(g)}
            </text>
          );
        })}

        {/* ---- (c) event lane — duration bars, row-stacked ---- */}
        {actions.map((a, i) => {
          const x0 = X(a.startH);
          const x1 = X(a.endH);
          const w = Math.max(6, x1 - x0);
          const y = LANE_Y + rows[i] * (ROW_H + ROW_GAP);
          const showLabel = w > 92;
          const isActive = activeEvent === i;
          const clip = `pt-clip-${i}`;
          return (
            <g
              key={`ev-${i}`}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setActiveEvent(i)}
              onMouseLeave={() => setActiveEvent((p) => (p === i ? null : p))}
              onClick={() => setActiveEvent((p) => (p === i ? null : i))}
            >
              <clipPath id={clip}><rect x={x0} y={y} width={w} height={ROW_H} rx={4} /></clipPath>
              <rect
                className="pt-evbar"
                x={x0}
                y={y}
                width={w}
                height={ROW_H}
                rx={4}
                fill={`color-mix(in srgb, var(--${a.tone}) 17%, transparent)`}
                stroke={isActive ? `var(--${a.tone})` : 'transparent'}
                strokeWidth={isActive ? 1 : 0}
                style={{ filter: isActive ? `brightness(1.35)` : undefined, ...(reduce ? {} : { animationDelay: `${i * 70}ms` }) }}
              />
              <rect x={x0} y={y} width={3.5} height={ROW_H} rx={1.75} fill={`var(--${a.tone})`} />
              <g clipPath={`url(#${clip})`}>
                <text x={x0 + 9} y={y + ROW_H / 2 + 3.5} fill={`var(--${a.tone})`} style={{ font: '700 10px var(--font-mono)' }}>{i + 1}</text>
                {showLabel && (
                  <text x={x0 + 22} y={y + ROW_H / 2 + 3.5} fill="var(--text-1)" style={{ font: '600 10.5px var(--font-sans, inherit)' }}>{a.title}</text>
                )}
              </g>
            </g>
          );
        })}

        {/* ---- (d) chart ---- */}
        {/* tariff tints */}
        {tariff.map((b, i) => (
          <rect key={`tt-${i}`} x={X(i)} y={PT} width={COLW} height={PH} fill={BANDFILL[b]} />
        ))}
        {/* active-event / scrub shading */}
        {activeAction && (
          <rect x={X(activeAction.startH)} y={PT} width={X(activeAction.endH) - X(activeAction.startH)} height={PH} fill={`var(--${activeAction.tone})`} opacity={0.08} />
        )}
        {/* gridlines + axis */}
        {[0, 0.5, 1].map((g, i) => (
          <g key={`gl-${i}`}>
            <line x1={PADL} y1={PT + g * PH} x2={VBW - PADR} y2={PT + g * PH} stroke="var(--grid-line)" strokeWidth="1" />
            <text x={PADL - 8} y={PT + g * PH + 3} textAnchor="end" fill="var(--text-3)" style={{ font: '500 10px var(--font-mono)' }}>{Math.round(SMAX * (1 - g))}</text>
          </g>
        ))}
        {/* SoC right scale */}
        {[0, 50, 100].map((p) => (
          <text key={`soc-${p}`} x={VBW - PADR + 4} y={Ys(p) + 3} textAnchor="start" fill="var(--battery)" style={{ font: '500 9px var(--font-mono)', opacity: 0.7 }}>{p}</text>
        ))}

        <path d={solarArea} fill="url(#pt-sa)" />
        <path className="pt-curve" d={lineFrom(solar, Yp)} fill="none" stroke="var(--solar)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <path className="pt-curve" d={lineFrom(load, Yp)} fill="none" stroke="var(--home)" strokeWidth="2" strokeDasharray="5 5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <path className="pt-curve" d={lineFrom(soc, Ys)} fill="none" stroke="var(--battery)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />

        {/* now marker */}
        <line x1={X(now)} y1={PT} x2={X(now)} y2={PT + PH} stroke="var(--text-1)" strokeWidth="1.5" />
        <circle className="pt-now-ring" cx={X(now)} cy={Ys(soc[nowIdx])} r="5" fill="none" stroke="var(--battery)" strokeWidth="2" />
        <circle cx={X(now)} cy={Ys(soc[nowIdx])} r="4.5" fill="var(--battery)" stroke="var(--bg-0)" strokeWidth="2" />
        <text x={X(now) + 5} y={PT + 11} fill="var(--text-1)" style={{ font: '600 10px var(--font-mono)' }}>now</text>

        {/* scrubber */}
        {scrubH != null && (
          <line x1={colCenter(scrubH)} y1={PT} x2={colCenter(scrubH)} y2={PT + PH} stroke="var(--text-2)" strokeWidth="1" strokeDasharray="3 3" />
        )}

        {/* ---- (e) tariff strip + per-segment labels ---- */}
        {(() => {
          const stripY = PT + PH + 10;
          const segs: { start: number; end: number; band: number }[] = [];
          for (let i = 0; i < 24; i++) {
            const b = tariff[i];
            const last = segs[segs.length - 1];
            if (last && last.band === b) last.end = i + 1;
            else segs.push({ start: i, end: i + 1, band: b });
          }
          return (
            <g>
              {tariff.map((b, i) => (
                <rect key={`s-${i}`} x={X(i) + 0.5} y={stripY} width={COLW - 1} height={7} rx={2} fill={BAND_COLOR[b]} opacity={b === 1 ? 0.4 : 0.85} />
              ))}
              {segs.filter((s) => s.end - s.start >= 2).map((s, i) => (
                <text key={`sl-${i}`} x={X((s.start + s.end) / 2)} y={stripY + 22} textAnchor="middle" fill={BAND_COLOR[s.band]} style={{ font: '600 10px var(--font-mono)' }}>{BAND_LABEL[s.band]}</text>
              ))}
              {[0, 6, 12, 18, 24].map((h, i, arr) => (
                <text key={`ax-${h}`} x={X(h)} y={stripY + 36} textAnchor={i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle'} fill="var(--text-3)" style={{ font: '500 11px var(--font-mono)' }}>{String(h % 24).padStart(2, '0')}</text>
              ))}
            </g>
          );
        })()}
      </svg>

      {/* ---- hover tooltips (HTML overlay) ---- */}
      {scrubH != null && activeEvent == null && (
        <ScrubTooltip
          h={scrubH}
          tariff={tariff}
          sunIntensityPct={sunIntensityPct}
          genKwh={genKwh}
          load={load}
          soc={soc}
          xPct={(colCenter(scrubH) / VBW) * 100}
          wide={wide}
        />
      )}
      {activeAction && (
        <EventTooltip action={activeAction} index={activeEvent! + 1} xPct={((X(activeAction.startH) + X(activeAction.endH)) / 2 / VBW) * 100} />
      )}
    </div>
  );
}

/* ---------- HTML tooltip overlays ---------- */

function hhmm(h: number): string {
  return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
}

function MiniSun({ pct }: { pct: number }) {
  const lit = Math.round(pct / 20);
  return (
    <span style={{ display: 'inline-flex', gap: 1.5, alignItems: 'flex-end', height: 12 }}>
      {Array.from({ length: 5 }, (_, b) => (
        <span key={b} style={{ width: 3, height: 4 + b * 2, borderRadius: 1, background: b < lit ? GOLD : SUN_UNLIT }} />
      ))}
    </span>
  );
}

function ScrubTooltip({
  h,
  tariff,
  sunIntensityPct,
  genKwh,
  load,
  soc,
  xPct,
  wide,
}: {
  h: number;
  tariff: number[];
  sunIntensityPct: number[];
  genKwh: number[];
  load: number[];
  soc: number[];
  xPct: number;
  wide: boolean;
}) {
  const band = tariff[h];
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: `${xPct}%`,
        transform: `translateX(${xPct > 70 ? '-100%' : xPct < 30 ? '0' : '-50%'})`,
        background: 'var(--surface-1)',
        border: '1px solid var(--border-2)',
        borderRadius: 'var(--radius-md, 10px)',
        boxShadow: 'var(--shadow-2)',
        padding: '8px 10px',
        pointerEvents: 'none',
        zIndex: 5,
        minWidth: wide ? 150 : 134,
        fontSize: 11.5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-1)' }}>{String(h).padStart(2, '0')}:00</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: BAND_COLOR[band] }}>{BAND_LABEL[band]} · {BAND_RATE[band]}</span>
      </div>
      <Row label="Sun" value={<span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><MiniSun pct={sunIntensityPct[h] ?? 0} />{Math.round(sunIntensityPct[h] ?? 0)}%</span>} />
      <Row label="Predicted gen" value={`${(genKwh[h] ?? 0).toFixed(1)} kWh`} color={GOLD} />
      <Row label="Load" value={`${(load[h] ?? 0).toFixed(1)} kW`} color="var(--home)" />
      <Row label="SoC" value={`${Math.round(soc[h] ?? 0)}%`} color="var(--battery)" />
    </div>
  );
}

function EventTooltip({ action, index, xPct }: { action: PlanAction; index: number; xPct: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: LANE_Y_PX,
        left: `${xPct}%`,
        transform: `translateX(${xPct > 70 ? '-100%' : xPct < 30 ? '0' : '-50%'})`,
        background: 'var(--surface-1)',
        border: `1px solid var(--${action.tone})`,
        borderRadius: 'var(--radius-md, 10px)',
        boxShadow: 'var(--shadow-2)',
        padding: '9px 11px',
        pointerEvents: 'none',
        zIndex: 6,
        maxWidth: 240,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
        <span style={{ width: 20, height: 20, borderRadius: 6, display: 'grid', placeItems: 'center', flex: 'none', background: `color-mix(in srgb, var(--${action.tone}) 20%, transparent)`, color: `var(--${action.tone})`, fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700 }}>{index}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{action.title}</span>
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: `var(--${action.tone})`, marginBottom: 5 }}>{hhmm(action.startH)}–{hhmm(action.endH)}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.45 }}>{action.why}</div>
    </div>
  );
}

// approximate pixel offset of the event lane for the HTML tooltip anchor
const LANE_Y_PX = 30;

function Row({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '1.5px 0' }}>
      <span style={{ color: 'var(--text-3)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: color ?? 'var(--text-1)' }}>{value}</span>
    </div>
  );
}
