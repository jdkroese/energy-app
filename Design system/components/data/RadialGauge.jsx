import React from 'react';

const TONE = {
  solar: 'var(--solar)',
  battery: 'var(--battery)',
  grid: 'var(--grid)',
  home: 'var(--home)',
  ev: 'var(--ev)',
  accent: 'var(--accent)',
};

const CSS = `
.pwr-gauge{ display:inline-grid; place-items:center; position:relative; }
.pwr-gauge svg{ display:block; transform:rotate(135deg); }
.pwr-gauge__arc{ transition:stroke-dashoffset var(--dur-slow) var(--ease-out); }
.pwr-gauge__center{ position:absolute; inset:0; display:flex; flex-direction:column;
  align-items:center; justify-content:center; text-align:center; gap:2px; }
.pwr-gauge__val{ font-family:var(--font-mono); font-variant-numeric:tabular-nums;
  font-weight:var(--fw-medium); color:var(--text-1); line-height:1; }
.pwr-gauge__unit{ font-family:var(--font-mono); font-size:0.42em; color:var(--text-2); }
.pwr-gauge__cap{ font-size:var(--fs-xs); font-weight:var(--fw-semibold); letter-spacing:0.06em;
  text-transform:uppercase; color:var(--text-2); }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'gauge');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * RadialGauge — a 270° arc gauge for bounded values (battery %, charge level,
 * self-sufficiency). The arc fills with the energy tone over the track.
 */
export function RadialGauge({
  value = 0,
  min = 0,
  max = 100,
  size = 132,
  thickness = 10,
  tone = 'battery',
  label,
  unit = '%',
  showValue = true,
  valueText,
  className = '',
  ...rest
}) {
  inject();
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const sweep = 0.75; // 270 degrees
  const track = c * sweep;
  const dash = track * pct;
  const color = TONE[tone] || TONE.battery;
  const fs = Math.round(size * 0.26);
  return (
    <div className={['pwr-gauge', className].filter(Boolean).join(' ')} style={{ width: size, height: size }} {...rest}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="var(--surface-4)" strokeWidth={thickness} strokeLinecap="round"
          strokeDasharray={`${track} ${c}`} />
        <circle className="pwr-gauge__arc" cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth={thickness} strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
      </svg>
      <div className="pwr-gauge__center">
        {showValue && (
          <div className="pwr-gauge__val" style={{ fontSize: fs }}>
            {valueText != null ? valueText : Math.round(value)}
            {unit && <span className="pwr-gauge__unit">{unit}</span>}
          </div>
        )}
        {label && <div className="pwr-gauge__cap">{label}</div>}
      </div>
    </div>
  );
}
