export interface BarDatum {
  l: string;
  p: number;
  c: number;
  /** per-bucket autonomy / self-sufficiency %, optional */
  a?: number;
}

/* ============================================================================
 * BarChart (V2, docs/53) — production vs consumption, grouped.
 *
 * Two 46 %-wide bars per bucket. Production carries a soft solar glow (it is the
 * energy the house made); consumption is flat home-purple. No y-axis and no
 * hover readout: this chart answers "did we make more than we used, and when",
 * and the exact kWh live in the KPI row above and in each column's title.
 * ==========================================================================*/

export function BarChart({ data, height = 180, gap = 4 }: { data: BarDatum[]; height?: number; gap?: number }) {
  const max = Math.max(0.1, ...data.flatMap((d) => [d.p, d.c])) * 1.1;
  const n = data.length;
  const axis = n === 0 ? [] : [0, 1, 2, 3, 4].map((k) => data[Math.round((k / 4) * (n - 1))].l);

  return (
    <div role="img" aria-label="Production versus consumption by period (kWh)">
      <div style={{ display: 'flex', alignItems: 'flex-end', gap, height }}>
        {data.map((d, i) => (
          <div
            key={i}
            title={`${d.l} · prod ${d.p.toFixed(1)} / used ${d.c.toFixed(1)} kWh${d.a != null ? ` · ${d.a}% autonomy` : ''}`}
            style={{
              flex: 1,
              minWidth: 0,
              height: '100%',
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
              gap: 2,
              animation: 'v2grow .6s var(--ease-out)',
              transformOrigin: 'bottom',
            }}
          >
            <i style={{ width: '46%', height: `${((d.p / max) * 100).toFixed(1)}%`, background: 'var(--solar)', borderRadius: '2px 2px 0 0', boxShadow: '0 0 8px color-mix(in srgb, var(--solar) 45%, transparent)' }} />
            <i style={{ width: '46%', height: `${((d.c / max) * 100).toFixed(1)}%`, background: 'var(--home)', borderRadius: '2px 2px 0 0' }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-3)' }}>
        {axis.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </div>
  );
}
