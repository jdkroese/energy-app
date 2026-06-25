import { useState } from 'react';

export interface BarDatum {
  l: string;
  p: number;
  c: number;
  /** per-bucket autonomy / self-sufficiency %, optional */
  a?: number;
}

type Props = {
  data: BarDatum[];
  height?: number;
  /** larger gaps + bar widths for desktop */
  size?: 'sm' | 'lg';
};

/** Round the axis to a nice max with ~4 evenly-spaced, human-friendly ticks. */
function niceTicks(rawMax: number): { max: number; ticks: number[]; decimals: number } {
  const step0 = Math.max(rawMax, 1) / 4;
  const pow = 10 ** Math.floor(Math.log10(step0));
  const n = step0 / pow;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
  const max = Math.ceil(Math.max(rawMax, 1) / step) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 1000; v += step) ticks.push(v);
  return { max, ticks, decimals };
}

/** BarChart — grouped production-vs-consumption bars with a kWh y-axis + hover readout. */
export function BarChart({ data, height = 150, size = 'sm' }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const rawMax = Math.max(...data.flatMap((d) => [d.p, d.c]), 1);
  const { max, ticks, decimals } = niceTicks(rawMax);
  const lg = size === 'lg';
  const gap = lg ? 16 : 10;
  const barW = lg ? 16 : 11;
  const innerGap = lg ? 5 : 3;
  const yAxisW = lg ? 40 : 32;
  const barPad = lg ? 6 : 2;
  // Thin x-axis labels when there are many buckets (e.g. 25 days) so they don't collide.
  const stride = Math.max(1, Math.ceil(data.length / (lg ? 16 : 8)));
  const h = hover != null ? data[hover] : null;
  const fmt = (v: number) => v.toFixed(decimals);

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: lg ? 10 : 8 }}
      role="img"
      aria-label="Production versus consumption by period (kWh)"
    >
      {/* hover readout — keeps detail off the bars themselves */}
      <div
        style={{
          minHeight: 18,
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-2)',
        }}
      >
        {h ? (
          <>
            <span style={{ color: 'var(--text-1)' }}>{h.l}</span>
            <span style={{ color: 'var(--solar)' }}>↑ {h.p} kWh</span>
            <span style={{ color: 'var(--home)' }}>↓ {h.c} kWh</span>
            {h.a != null && <span style={{ color: 'var(--battery)' }}>{h.a}% autonomy</span>}
          </>
        ) : (
          <span style={{ color: 'var(--text-3)' }}>Hover a bar for detail</span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 10, letterSpacing: '.04em' }}>kWh</span>
      </div>

      {/* plot: kWh y-axis + bars */}
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ width: yAxisW, height, position: 'relative', flex: 'none' }}>
          {ticks.map((t) => (
            <span
              key={t}
              style={{
                position: 'absolute',
                right: 0,
                bottom: `calc(${(t / max) * 100}% - 6px)`,
                fontSize: 10,
                color: 'var(--text-3)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {fmt(t)}
            </span>
          ))}
        </div>

        <div style={{ flex: 1, position: 'relative', height, borderBottom: '1px solid var(--border-1)' }}>
          {/* gridlines */}
          {ticks.map((t) => (
            <div
              key={t}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: `${(t / max) * 100}%`,
                height: 1,
                background: 'var(--border-1)',
                opacity: t === 0 ? 0 : 0.45,
              }}
            />
          ))}
          {/* bars */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'flex-end',
              gap,
              padding: `0 ${barPad}px`,
            }}
          >
            {data.map((g, i) => (
              <div
                key={i}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((x) => (x === i ? null : x))}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: innerGap,
                  justifyContent: 'center',
                  height: '100%',
                  borderRadius: 5,
                  background: hover === i ? 'var(--surface-2)' : 'transparent',
                  transition: 'background .12s',
                }}
              >
                <div
                  style={{
                    width: barW,
                    height: `${(g.p / max) * 100}%`,
                    background: 'var(--solar)',
                    borderRadius: '4px 4px 0 0',
                    boxShadow: '0 0 10px color-mix(in srgb,var(--solar) 40%,transparent)',
                  }}
                />
                <div
                  style={{
                    width: barW,
                    height: `${(g.c / max) * 100}%`,
                    background: 'var(--home)',
                    borderRadius: '4px 4px 0 0',
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* x-axis labels — offset to align under the bars (past the y-axis gutter) */}
      <div style={{ display: 'flex', gap, paddingLeft: yAxisW + 6 + barPad, paddingRight: barPad }}>
        {data.map((g, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              textAlign: 'center',
              font: '500 11px var(--font-mono)',
              color: 'var(--text-3)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {i % stride === 0 ? g.l : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
