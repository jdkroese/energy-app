import { useState, type CSSProperties } from 'react';
import type { PlanAction } from '../../lib/types';
import { Eyebrow } from '../ui';

/* ============================================================================
 * PlanRibbon (V2, docs/53) — the next 24 h as one 54 px track.
 *
 * The 2.0TD bands are the GROUND (24 flex cells behind everything), each planned
 * move is an absolutely-positioned capsule over them, and a glowing now-line cuts
 * the track at the current hour. Hovering a capsule fills the detail line below,
 * which carries a fixed min-height so the hover never reflows the card.
 *
 * This replaces the old full-height plan timeline on Live: the hero answers "is
 * the coordinator doing the right thing?", and the ribbon answers "and what is it
 * lined up to do next?" — in a strip, not a chart.
 * ==========================================================================*/

/** 24-length band index per hour, as the brain sends it: 0 = P3, 1 = P2, 2 = P1. */
const BAND_BG = ['var(--band-p3)', 'var(--band-p2)', 'var(--band-p1)'];
const BAND_OPACITY = [0.2, 0.16, 0.3];

const hhmm = (h: number) =>
  `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;

export function PlanRibbon({ actions, tariff, now }: { actions: PlanAction[]; tariff: number[]; now: number }) {
  const [hovered, setHovered] = useState<number | null>(null);

  // A move that spans the whole day (e.g. "hold 20% reserve") would paper over
  // every other capsule, so it is drawn but never wins the label.
  const moves = actions.map((a, i) => ({ ...a, i, span: Math.max(0, a.endH - a.startH) }));
  const active = moves.find((m) => now >= m.startH && now < m.endH && m.span < 24) ?? null;
  const shown = hovered != null ? moves.find((m) => m.i === hovered) ?? null : null;

  return (
    <div style={{ marginTop: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 7 }}>
        <Eyebrow>Plan · next 24 h</Eyebrow>
        <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {active ? `now · ${active.title.toLowerCase()}` : 'now · idle'}
        </span>
      </div>

      <div
        style={{
          position: 'relative',
          height: 54,
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-1)',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, display: 'flex' }} aria-hidden>
          {Array.from({ length: 24 }).map((_, h) => {
            const b = tariff[h] ?? 0;
            return <i key={h} style={{ flex: 1, background: BAND_BG[b], opacity: BAND_OPACITY[b] }} />;
          })}
        </div>

        {moves.map((m) => {
          const on = hovered === m.i;
          const wPct = (m.span / 24) * 100;
          const style: CSSProperties = {
            all: 'unset',
            cursor: 'pointer',
            boxSizing: 'border-box',
            position: 'absolute',
            left: `${((m.startH / 24) * 100).toFixed(2)}%`,
            width: `${wPct.toFixed(2)}%`,
            top: 8 + (m.i % 2) * 21,
            height: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            fontFamily: 'var(--font-sans)',
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: '.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            padding: '0 6px',
            color: on ? 'var(--accent-contrast)' : `var(--${m.tone})`,
            background: on ? `var(--${m.tone})` : `var(--${m.tone}-wash)`,
            border: `1px solid var(--${m.tone})`,
            boxShadow: on ? `0 0 14px var(--${m.tone})` : 'none',
            transform: on ? 'translateY(-1px)' : 'none',
            transition: 'all .16s var(--ease-out)',
          };
          return (
            <button
              key={m.i}
              type="button"
              onMouseEnter={() => setHovered(m.i)}
              onMouseLeave={() => setHovered((v) => (v === m.i ? null : v))}
              onFocus={() => setHovered(m.i)}
              onBlur={() => setHovered((v) => (v === m.i ? null : v))}
              onClick={() => setHovered((v) => (v === m.i ? null : m.i))}
              title={`${m.title} · ${hhmm(m.startH)}–${hhmm(m.endH)}`}
              style={style}
            >
              {wPct < 9 ? '' : m.title}
            </button>
          );
        })}

        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${((Math.max(0, Math.min(24, now)) / 24) * 100).toFixed(2)}%`,
            width: 2,
            background: 'var(--solar)',
            boxShadow: '0 0 10px var(--solar)',
            pointerEvents: 'none',
          }}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-3)' }}>
        <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
      </div>

      {/* Fixed min-height: hovering a capsule must not reflow the hero. */}
      <div style={{ marginTop: 8, minHeight: 34, fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5, textWrap: 'pretty' }}>
        {shown ? (
          <>
            <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{shown.title}</span>
            {' · '}
            <span className="pwr-mono">{hhmm(shown.startH)}–{hhmm(shown.endH)}</span>
            {' — '}
            {shown.why}
          </>
        ) : (
          'Hover a move to see why the coordinator chose it. Bands behind are the 2.0TD tariff.'
        )}
      </div>
    </div>
  );
}
