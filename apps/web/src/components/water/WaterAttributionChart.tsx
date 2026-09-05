import { useState, type CSSProperties } from 'react';
import type { WaterHourBucket } from '../../lib/types';

/* ============================================================================
 * WaterAttributionChart (V2, docs/53) — "Every litre, accounted for".
 *
 * WHY THIS WAS REBUILT: the original smoothed stacked AREA put a ~210 L/h
 * irrigation pulse and a 3–14 L/h leak on one linear scale. The leak — the only
 * actionable signal on the screen — was a two-pixel sliver, and smoothing the top
 * of each band against the straight bottom of the next left visible gaps.
 *
 * The replacement has two registers:
 *
 *  1. STACKED HOURLY COLUMNS, irrigation (bottom) → household → unexplained
 *     (top). That order is load-bearing: it keeps danger-red away from
 *     irrigation-green (indistinguishable under deuteranopia — see the
 *     --series-water-* comment in index.css) AND puts the unattributed band
 *     where the eye lands. A segment never falls below 1.6 % so a thin band
 *     cannot vanish.
 *  2. OVERNIGHT, MAGNIFIED — the unexplained series alone on its own 0–16 L/h
 *     scale, labelled as such. A broken axis is honest only if it says so.
 * ==========================================================================*/

type BandKey = 'irr' | 'hh' | 'un';

export interface WaterAttributionChartProps {
  hours: WaterHourBucket[];
  /** Upper-register height: 230 desktop / 190 phone. */
  height?: number;
  /** L/h above which an unexplained hour reads as an alarm rather than baseline. */
  floorLph?: number;
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

export function WaterAttributionChart({ hours, height = 230, floorLph = 8 }: WaterAttributionChartProps) {
  const [band, setBand] = useState<BandKey | null>(null);
  const [hour, setHour] = useState<number | null>(null);

  const cols = hours.slice(0, 24);
  const totIrr = Math.round(cols.reduce((s, c) => s + c.irrigationL, 0));
  const totHh = Math.round(cols.reduce((s, c) => s + c.householdL, 0));
  const totUn = Math.round(cols.reduce((s, c) => s + c.unexplainedL, 0));

  const peak = Math.max(...cols.map((c) => c.irrigationL + c.householdL + c.unexplainedL), 1);
  const peakHour = cols.reduce((best, c) => (c.irrigationL + c.householdL + c.unexplainedL > best.v ? { v: c.irrigationL + c.householdL + c.unexplainedL, h: c.h } : best), { v: -1, h: 0 });
  // A little headroom above the tallest column, with a floor so a quiet day
  // doesn't magnify household noise into a skyline.
  const scale = Math.max(60, peak * 1.08);

  // The leak window = the longest run of overnight hours above the floor.
  const leak = longestRun(cols, floorLph);

  // The magnified scale must always contain the baseline it draws — otherwise a
  // high quiet-hour floor pushes the dashed line clean out of its own register.
  const magMax = Math.max(16, floorLph * 1.6, ...cols.map((c) => c.unexplainedL * 1.05));
  const worstNight = Math.max(0, ...cols.filter((c) => c.h < 6).map((c) => c.unexplainedL));

  const opacityOf = (k: BandKey) => (band == null ? (k === 'un' ? 1 : 0.9) : band === k ? 1 : 0.16);

  const seg = (v: number, k: BandKey): CSSProperties => ({
    display: 'block',
    width: '100%',
    height: v > 0 ? `${Math.max(1.6, (v / scale) * 100).toFixed(2)}%` : '0',
    background:
      k === 'irr'
        ? 'var(--series-water-irrigation)'
        : k === 'hh'
          ? 'var(--series-water-household)'
          : v > floorLph
            ? 'var(--series-water-unexplained)'
            : 'color-mix(in srgb, var(--series-water-unexplained) 40%, transparent)',
    opacity: opacityOf(k),
    boxShadow: k === 'un' && v > floorLph ? '0 0 9px color-mix(in srgb, var(--series-water-unexplained) 75%, transparent)' : 'none',
    transition: 'opacity .2s var(--ease-out)',
  });

  const readout =
    hour == null
      ? 'Hover an hour for its split. The unattributed band always sits on top.'
      : `${hh(hour)} — irrigation ${Math.round(cols[hour].irrigationL)} L · household ${Math.round(cols[hour].householdL)} L · unexplained ${Math.round(cols[hour].unexplainedL)} L`;

  const legend: { k: BandKey; label: string; total: number; color: string }[] = [
    { k: 'irr', label: 'Irrigation', total: totIrr, color: 'var(--series-water-irrigation)' },
    { k: 'hh', label: 'Household', total: totHh, color: 'var(--series-water-household)' },
    { k: 'un', label: 'Unexplained', total: totUn, color: 'var(--series-water-unexplained)' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {legend.map((l) => (
          <button
            key={l.k}
            type="button"
            onMouseEnter={() => setBand(l.k)}
            onMouseLeave={() => setBand((v) => (v === l.k ? null : v))}
            onFocus={() => setBand(l.k)}
            onBlur={() => setBand((v) => (v === l.k ? null : v))}
            onClick={() => setBand((v) => (v === l.k ? null : l.k))}
            aria-pressed={band === l.k}
            style={{
              all: 'unset',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 9px',
              borderRadius: 999,
              fontFamily: 'var(--font-sans)',
              fontSize: 11.5,
              whiteSpace: 'nowrap',
              color: 'var(--text-2)',
              background: band === l.k ? 'var(--surface-3)' : 'transparent',
              border: `1px solid ${band === l.k ? 'var(--border-2)' : 'transparent'}`,
              transition: 'all .14s var(--ease-out)',
            }}
          >
            <i style={{ width: 9, height: 9, borderRadius: 2, background: l.color }} />
            {l.label} <span className="pwr-mono" style={{ opacity: 0.7 }}>{l.total.toLocaleString()} L</span>
          </button>
        ))}
      </div>

      {/* Fixed min-height so hovering a column can't reflow the card. */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', minHeight: 19 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>{readout}</span>
        <span className="pwr-mono" style={{ flex: 'none', marginLeft: 14, fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
          peak {Math.round(peak)} L/h · {hh(peakHour.h)}
        </span>
      </div>

      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 3, height, borderBottom: '1px solid var(--border-1)' }}>
        {leak && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: `${((leak.from / 24) * 100).toFixed(2)}%`,
              width: `${(((leak.to - leak.from) / 24) * 100).toFixed(2)}%`,
              top: 0,
              bottom: 0,
              border: '1px dashed var(--border-danger)',
              borderRadius: 4,
              background: 'var(--danger-wash)',
              pointerEvents: 'none',
            }}
          />
        )}
        {cols.map((c, i) => {
          const on = hour === i;
          return (
            <div
              key={c.h}
              onMouseEnter={() => setHour(i)}
              onMouseLeave={() => setHour((v) => (v === i ? null : v))}
              title={`${hh(c.h)} · ${Math.round(c.totalL)} L`}
              style={{
                flex: 1,
                minWidth: 0,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                cursor: 'crosshair',
                borderRadius: '3px 3px 0 0',
                overflow: 'hidden',
                background: on ? 'var(--surface-2)' : 'transparent',
                outline: on ? '1px solid var(--border-2)' : 'none',
              }}
            >
              <i style={seg(c.unexplainedL, 'un')} />
              <i style={seg(c.householdL, 'hh')} />
              <i style={seg(c.irrigationL, 'irr')} />
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-3)' }}>
        {['00', '04', '08', '12', '16', '20', '24'].map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>

      {/* ---- lower register: the unexplained series on its own scale ---- */}
      <div style={{ marginTop: 6, paddingTop: 12, borderTop: '1px solid var(--border-1)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, gap: 10 }}>
          <span className="pwr-eyebrow" style={{ color: 'var(--danger)' }}>Overnight, magnified</span>
          <span className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
            0–{Math.round(magMax)} L/h · own scale
          </span>
        </div>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 3, height: 76 }}>
          <div
            aria-hidden
            style={{ position: 'absolute', left: 0, right: 0, bottom: `${((floorLph / magMax) * 100).toFixed(1)}%`, height: 0, borderTop: '1px dashed var(--water)', opacity: 0.85, pointerEvents: 'none' }}
          />
          <span
            aria-hidden
            style={{ position: 'absolute', right: 2, bottom: `calc(${((floorLph / magMax) * 100).toFixed(1)}% + 3px)`, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--water)', pointerEvents: 'none' }}
          >
            baseline {floorLph} L/h
          </span>
          {cols.map((c) => {
            const bad = c.unexplainedL > floorLph;
            return (
              <div key={c.h} title={`${hh(c.h)} · unexplained ${Math.round(c.unexplainedL)} L/h`} style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                <i
                  style={{
                    width: '100%',
                    height: `${((Math.min(c.unexplainedL, magMax) / magMax) * 100).toFixed(1)}%`,
                    background: bad ? 'var(--series-water-unexplained)' : 'var(--water-dim)',
                    borderRadius: '3px 3px 0 0',
                    boxShadow: bad ? '0 0 10px color-mix(in srgb, var(--series-water-unexplained) 65%, transparent)' : 'none',
                  }}
                />
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 9, fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55, textWrap: 'pretty' }}>
          {leak
            ? `${leak.to - leak.from} hour${leak.to - leak.from === 1 ? '' : 's'} overnight at up to ${Math.round(worstNight)} L/h — ${Math.round(worstNight - floorLph)} L/h above the ${floorLph} L/h baseline. A step, not a drift: that reads as a valve, not evaporation.`
            : `Nothing unattributed overnight held above the ${floorLph} L/h baseline. A house that reaches its floor every night is a house without a leak.`}
        </div>
      </div>
    </div>
  );
}

/** Longest run of consecutive hours whose unexplained flow sits above the floor. */
function longestRun(cols: WaterHourBucket[], floorLph: number): { from: number; to: number } | null {
  let best: { from: number; to: number } | null = null;
  let start: number | null = null;
  for (let i = 0; i <= cols.length; i++) {
    const over = i < cols.length && cols[i].unexplainedL > floorLph;
    if (over && start == null) start = i;
    if (!over && start != null) {
      const run = { from: start, to: i };
      if (!best || run.to - run.from > best.to - best.from) best = run;
      start = null;
    }
  }
  return best && best.to - best.from >= 2 ? best : null;
}
