import React from 'react';

const TONE = {
  solar: 'var(--solar)', battery: 'var(--battery)', grid: 'var(--grid)',
  home: 'var(--home)', ev: 'var(--ev)', accent: 'var(--accent)', danger: 'var(--danger)',
};

const CSS = `
.pwr-bar{ display:flex; flex-direction:column; gap:6px; width:100%; }
.pwr-bar__top{ display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.pwr-bar__label{ font-size:var(--fs-sm); color:var(--text-2); }
.pwr-bar__val{ font-family:var(--font-mono); font-variant-numeric:tabular-nums;
  font-size:var(--fs-sm); color:var(--text-1); font-weight:var(--fw-medium); }
.pwr-bar__track{ position:relative; width:100%; background:var(--surface-4);
  border-radius:var(--radius-pill); overflow:hidden; }
.pwr-bar__fill{ height:100%; border-radius:var(--radius-pill); background:var(--_c, var(--accent));
  transition:width var(--dur-slow) var(--ease-out); }
.pwr-bar--glow .pwr-bar__fill{ box-shadow:0 0 12px var(--_c, var(--accent)); }
/* multi-segment (stacked) bar */
.pwr-bar__seg{ height:100%; }
.pwr-bar__seg:first-child{ border-radius:var(--radius-pill) 0 0 var(--radius-pill); }
.pwr-bar__seg:last-child{ border-radius:0 var(--radius-pill) var(--radius-pill) 0; }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'bar');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * ProgressBar — linear level/progress indicator. Single value, or a `segments`
 * array for a stacked energy-mix bar (e.g. solar vs battery vs grid share).
 */
export function ProgressBar({
  value = 0,
  max = 100,
  tone = 'accent',
  height = 8,
  label,
  valueText,
  showValue = false,
  glow = false,
  segments,
  className = '',
  ...rest
}) {
  inject();
  const cls = ['pwr-bar', glow && 'pwr-bar--glow', className].filter(Boolean).join(' ');
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={cls} style={{ '--_c': TONE[tone] || TONE.accent }} {...rest}>
      {(label || showValue) && (
        <div className="pwr-bar__top">
          {label && <span className="pwr-bar__label">{label}</span>}
          {showValue && <span className="pwr-bar__val">{valueText != null ? valueText : `${Math.round(pct)}%`}</span>}
        </div>
      )}
      <div className="pwr-bar__track" style={{ height }}>
        {segments ? (
          <div style={{ display: 'flex', height: '100%', width: '100%' }}>
            {segments.map((s, i) => (
              <div key={i} className="pwr-bar__seg"
                style={{ width: `${s.value}%`, background: TONE[s.tone] || s.tone || 'var(--accent)' }}
                title={s.label} />
            ))}
          </div>
        ) : (
          <div className="pwr-bar__fill" style={{ width: `${pct}%` }} />
        )}
      </div>
    </div>
  );
}
