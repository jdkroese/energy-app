import { useState } from 'react';
import type { Band } from '../../lib/types';
import { BAND_RATE } from '../../lib/dayMetrics';

/* ============================================================================
 * GridBandChart (V2, docs/53) — "Grid import, priced by band".
 *
 * One stacked column per bucket, P1 on top → P3 at the bottom, so the expensive
 * band is the one the eye lands on. Detail lives in a fixed-height READOUT ROW
 * above the plot rather than in a floating tooltip: hovering a bar can then never
 * reflow the card, and the default state still carries the number that matters
 * (what the grid cost this period).
 * ==========================================================================*/

/** Stack order, top → bottom. P1 rides on top because it is what costs money. */
const STACK: Band[] = ['P1', 'P2', 'P3'];
const COLOR: Record<Band, string> = { P1: 'var(--band-p1)', P2: 'var(--band-p2)', P3: 'var(--band-p3)' };

export interface GridBandChartProps {
  labels: string[];
  bandKwh: { P1: number[]; P2: number[]; P3: number[] };
  /** Fixed power (capacity) term for the period — shown as an honest footnote. */
  powerTermEur?: number;
  /** Plot height: 180 desktop / 160 narrow / 130 phone. */
  height?: number;
  /** Column gap: 4 desktop / 2 phone. */
  gap?: number;
}

const costOf = (p1: number, p2: number, p3: number) => p1 * BAND_RATE.P1 + p2 * BAND_RATE.P2 + p3 * BAND_RATE.P3;

export function GridBandChart({ labels, bandKwh, powerTermEur, height = 180, gap = 4 }: GridBandChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;

  const at = (b: Band, i: number) => bandKwh[b][i] ?? 0;
  const total = (i: number) => at('P1', i) + at('P2', i) + at('P3', i);
  const max = Math.max(0.1, ...labels.map((_, i) => total(i))) * 1.1;

  const periodEur = labels.reduce((s, _, i) => s + costOf(at('P1', i), at('P2', i), at('P3', i)), 0);

  const h = hover != null && hover < n ? hover : null;
  const readout =
    h == null
      ? 'Hover a bar for the band split and what it cost.'
      : `Imported ${total(h).toFixed(1)} kWh on ${labels[h]} — P1 ${at('P1', h).toFixed(1)} · P2 ${at('P2', h).toFixed(1)} · P3 ${at('P3', h).toFixed(1)}`;
  const readoutCost =
    h == null ? `€${periodEur.toFixed(2)} total` : `€${costOf(at('P1', h), at('P2', h), at('P3', h)).toFixed(2)}`;

  // Five evenly-sampled axis labels — dense ranges (28 days, 12 months) can't
  // print every bucket without collapsing into a smear.
  const axis = n === 0 ? [] : [0, 1, 2, 3, 4].map((k) => labels[Math.round((k / 4) * (n - 1))]);

  return (
    <div role="img" aria-label={`Grid import by tariff band — €${periodEur.toFixed(2)} over the period`}>
      {/* Fixed min-height: the hover readout must never reflow the card. */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10, minHeight: 20 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{readout}</span>
        <span className="pwr-mono" style={{ fontSize: 12.5, color: 'var(--grid)', whiteSpace: 'nowrap' }}>{readoutCost}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap, height }}>
        {labels.map((l, i) => {
          const on = hover === i;
          return (
            <div
              key={i}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((v) => (v === i ? null : v))}
              title={`${l} · ${total(i).toFixed(1)} kWh imported`}
              style={{
                flex: 1,
                minWidth: 0,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                gap: 1,
                cursor: 'crosshair',
                borderRadius: 3,
                overflow: 'hidden',
                background: on ? 'var(--surface-2)' : 'transparent',
                animation: 'v2grow .5s var(--ease-out)',
                transformOrigin: 'bottom',
              }}
            >
              {STACK.map((b) => (
                <i
                  key={b}
                  style={{
                    display: 'block',
                    width: '100%',
                    height: `${((at(b, i) / max) * 100).toFixed(2)}%`,
                    background: COLOR[b],
                    opacity: on ? 1 : 0.72,
                    transition: 'opacity .15s var(--ease-out)',
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-3)' }}>
        {axis.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>

      {powerTermEur != null && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)' }}>
          + fixed power term €{powerTermEur.toFixed(2)} (14 kW) — charged whether or not a kWh moves.
        </div>
      )}
    </div>
  );
}
