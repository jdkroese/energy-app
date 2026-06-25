export interface BarDatum {
  l: string;
  p: number;
  c: number;
}

type Props = {
  data: BarDatum[];
  height?: number;
  /** larger gaps + bar widths for desktop */
  size?: 'sm' | 'lg';
};

/** BarChart — grouped production-vs-consumption bars (ported from the mockups). */
export function BarChart({ data, height = 150, size = 'sm' }: Props) {
  const max = Math.ceil(Math.max(...data.flatMap((d) => [d.p, d.c]), 1));
  const lg = size === 'lg';
  const gap = lg ? 22 : 14;
  const barW = lg ? 20 : 14;
  const innerGap = lg ? 7 : 4;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: lg ? 10 : 8 }} role="img" aria-label="Production versus consumption by period (kWh)">
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
            style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: innerGap, justifyContent: 'center', height: '100%' }}
          >
            <div
              title={g.p + ' kWh'}
              style={{
                width: barW,
                height: `${(g.p / max) * 100}%`,
                background: 'var(--solar)',
                borderRadius: '4px 4px 0 0',
                boxShadow: '0 0 10px color-mix(in srgb,var(--solar) 40%,transparent)',
              }}
            />
            <div
              title={g.c + ' kWh'}
              style={{ width: barW, height: `${(g.c / max) * 100}%`, background: 'var(--home)', borderRadius: '4px 4px 0 0' }}
            />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap, padding: lg ? '0 6px' : '0 2px' }}>
        {data.map((g, i) => (
          <div key={i} style={{ flex: 1, textAlign: 'center', font: '500 12px var(--font-mono)', color: 'var(--text-3)' }}>
            {g.l}
          </div>
        ))}
      </div>
    </div>
  );
}
