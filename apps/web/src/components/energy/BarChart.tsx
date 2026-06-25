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

/** BarChart — grouped production-vs-consumption bars with a hover readout. */
export function BarChart({ data, height = 150, size = 'sm' }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.ceil(Math.max(...data.flatMap((d) => [d.p, d.c]), 1));
  const lg = size === 'lg';
  const gap = lg ? 16 : 10;
  const barW = lg ? 16 : 11;
  const innerGap = lg ? 5 : 3;
  // Thin x-axis labels when there are many buckets (e.g. 25 days) so they don't collide.
  const stride = Math.max(1, Math.ceil(data.length / (lg ? 16 : 8)));
  const h = hover != null ? data[hover] : null;

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
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap,
          height,
          borderBottom: '1px solid var(--border-1)',
          padding: lg ? '0 6px' : '0 2px',
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

      <div style={{ display: 'flex', gap, padding: lg ? '0 6px' : '0 2px' }}>
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
