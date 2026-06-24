// Power desktop kit — charts (SVG). Exposes window.PWRCharts.
const PWRCharts = (function () {
  const TONE = { solar: 'var(--solar)', battery: 'var(--battery)', grid: 'var(--grid)', home: 'var(--home)', ev: 'var(--ev)' };
  let gid = 0;

  function buildPath(data, w, h, padY) {
    const max = Math.max(...data, 1);
    const stepX = w / (data.length - 1);
    const pts = data.map((d, i) => [i * stepX, h - padY - (d / max) * (h - padY * 2)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    return { line, pts, max };
  }

  // Multi-series area/line chart with hour axis + y gridlines.
  function AreaChart({ series, height = 220, unit = 'kW', labels }) {
    const w = 1000;
    const h = height;
    const padY = 16;
    const id0 = React.useMemo(() => 'pwrc' + (gid++), []);
    const allMax = Math.max(...series.flatMap((s) => s.data), 1);
    const stepX = w / (series[0].data.length - 1);

    const gridY = [0, 0.25, 0.5, 0.75, 1];
    const niceMax = Math.ceil(allMax);

    return (
      <div style={{ width: '100%' }}>
        <svg viewBox={`0 0 ${w} ${h + 26}`} width="100%" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={i} id={`${id0}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={TONE[s.tone] || s.tone} stopOpacity="0.28" />
                <stop offset="100%" stopColor={TONE[s.tone] || s.tone} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {/* gridlines */}
          {gridY.map((g, i) => (
            <g key={i}>
              <line x1="0" y1={padY + g * (h - padY * 2)} x2={w} y2={padY + g * (h - padY * 2)}
                stroke="var(--grid-line)" strokeWidth="1" />
              <text x="6" y={padY + g * (h - padY * 2) - 5} fill="var(--text-3)"
                style={{ font: '500 16px var(--font-mono)' }}>
                {Math.round(niceMax * (1 - g))}
              </text>
            </g>
          ))}
          {/* areas + lines, draw consumption first (under) */}
          {series.map((s, i) => {
            const max = niceMax;
            const pts = s.data.map((d, j) => [j * stepX, padY + (1 - d / max) * (h - padY * 2)]);
            const line = pts.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
            const fill = `${line} L${w} ${h - padY} L0 ${h - padY} Z`;
            return (
              <g key={i}>
                {s.fill !== false && <path d={fill} fill={`url(#${id0}-${i})`} />}
                <path d={line} fill="none" stroke={TONE[s.tone] || s.tone}
                  strokeWidth={s.dash ? 2 : 2.5} strokeDasharray={s.dash ? '5 5' : undefined}
                  strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
          {/* x labels */}
          {(labels || ['00','06','12','18','24']).map((lb, i, arr) => (
            <text key={i} x={(i / (arr.length - 1)) * w} y={h + 18}
              textAnchor={i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle'}
              fill="var(--text-3)" style={{ font: '500 15px var(--font-mono)' }}>{lb}</text>
          ))}
        </svg>
      </div>
    );
  }

  // Vertical bar chart (e.g. weekly production vs consumption).
  function BarChart({ groups, height = 220, labels }) {
    const max = Math.max(...groups.flatMap((g) => g.values), 1);
    const niceMax = Math.ceil(max);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, height, padding: '0 4px',
          borderBottom: '1px solid var(--border-1)' }}>
          {groups.map((g, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, height: '100%' }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 5, width: '100%', justifyContent: 'center' }}>
                {g.values.map((v, j) => (
                  <div key={j} title={`${v} kWh`} style={{
                    width: 16, height: `${(v / niceMax) * 100}%`, minHeight: 3,
                    background: g.tones[j], borderRadius: '4px 4px 0 0',
                    boxShadow: j === 0 ? '0 0 10px color-mix(in srgb,' + g.tones[j] + ' 40%, transparent)' : 'none',
                  }} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 18, padding: '0 4px' }}>
          {(labels || groups.map((g) => g.label)).map((lb, i) => (
            <div key={i} style={{ flex: 1, textAlign: 'center', font: '500 13px var(--font-mono)', color: 'var(--text-3)' }}>{lb}</div>
          ))}
        </div>
      </div>
    );
  }

  return { AreaChart, BarChart };
})();
Object.assign(window, { PWRCharts });
