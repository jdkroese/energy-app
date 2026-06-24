import React from 'react';

const CSS = `
.pwr-stat{ display:flex; flex-direction:column; gap:10px; min-width:0; }
.pwr-stat__top{ display:flex; align-items:center; gap:8px; }
.pwr-stat__icon{ display:inline-flex; width:26px; height:26px; align-items:center; justify-content:center;
  border-radius:var(--radius-sm); color:var(--_tone, var(--text-2)); background:var(--_wash, var(--surface-3)); }
.pwr-stat__icon svg{ width:15px; height:15px; }
.pwr-stat__label{ font-size:var(--fs-xs); font-weight:var(--fw-semibold); letter-spacing:0.06em;
  text-transform:uppercase; color:var(--text-2); }
.pwr-stat__value{ display:flex; align-items:baseline; gap:6px;
  font-family:var(--font-mono); font-variant-numeric:tabular-nums; letter-spacing:var(--ls-mono);
  font-weight:var(--fw-medium); color:var(--_tone, var(--text-1)); line-height:1; }
.pwr-stat__num{ font-size:var(--fs-metric-lg); }
.pwr-stat--sm .pwr-stat__num{ font-size:var(--fs-metric-md); }
.pwr-stat--xl .pwr-stat__num{ font-size:var(--fs-metric-xl); }
.pwr-stat__unit{ font-family:var(--font-mono); font-size:0.42em; color:var(--text-2); font-weight:var(--fw-regular); }
.pwr-stat__foot{ display:flex; align-items:center; gap:6px; font-size:var(--fs-xs); color:var(--text-2); }
.pwr-stat__delta{ display:inline-flex; align-items:center; gap:3px; font-family:var(--font-mono);
  font-variant-numeric:tabular-nums; font-weight:var(--fw-medium); }
.pwr-stat__delta svg{ width:12px; height:12px; }
.pwr-stat__delta--up{ color:var(--success); }
.pwr-stat__delta--down{ color:var(--danger); }
.pwr-stat__delta--flat{ color:var(--text-3); }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'stat');
  s.textContent = CSS;
  document.head.appendChild(s);
}

const TONE = {
  solar: ['var(--solar)', 'var(--solar-wash)'],
  battery: ['var(--battery)', 'var(--battery-wash)'],
  grid: ['var(--grid)', 'var(--grid-wash)'],
  home: ['var(--home)', 'var(--home-wash)'],
  ev: ['var(--ev)', 'rgba(139,140,255,0.12)'],
  neutral: [null, null],
};

const Arrow = ({ dir }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
    strokeLinecap="round" strokeLinejoin="round">
    {dir === 'up' && <><line x1="7" y1="17" x2="17" y2="7" /><polyline points="9 7 17 7 17 15" /></>}
    {dir === 'down' && <><line x1="7" y1="7" x2="17" y2="17" /><polyline points="17 9 17 17 9 17" /></>}
    {dir === 'flat' && <line x1="6" y1="12" x2="18" y2="12" />}
  </svg>
);

/**
 * StatTile — the core readout: a big mono value with unit, an uppercase label,
 * an optional energy-tone icon, and a delta vs a comparison period.
 */
export function StatTile({
  label,
  value,
  unit,
  tone = 'neutral',
  icon,
  size = 'md',
  delta,
  deltaDir,
  footnote,
  children,
  className = '',
  ...rest
}) {
  inject();
  const [c, wash] = TONE[tone] || TONE.neutral;
  const dir = deltaDir || (typeof delta === 'number' ? (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat') : 'flat');
  const style = { '--_tone': tone === 'neutral' ? undefined : c, '--_wash': wash };
  return (
    <div className={['pwr-stat', size !== 'md' && `pwr-stat--${size}`, className].filter(Boolean).join(' ')} style={style} {...rest}>
      {(label || icon) && (
        <div className="pwr-stat__top">
          {icon && <span className="pwr-stat__icon">{icon}</span>}
          {label && <span className="pwr-stat__label">{label}</span>}
        </div>
      )}
      <div className="pwr-stat__value">
        <span className="pwr-stat__num">{value}</span>
        {unit && <span className="pwr-stat__unit">{unit}</span>}
      </div>
      {(delta != null || footnote) && (
        <div className="pwr-stat__foot">
          {delta != null && (
            <span className={`pwr-stat__delta pwr-stat__delta--${dir}`}>
              <Arrow dir={dir} />{typeof delta === 'number' ? `${Math.abs(delta)}%` : delta}
            </span>
          )}
          {footnote && <span>{footnote}</span>}
        </div>
      )}
      {children}
    </div>
  );
}
