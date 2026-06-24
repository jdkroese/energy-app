import React from 'react';

const CSS = `
.pwr-slider{ display:flex; flex-direction:column; gap:8px; width:100%; }
.pwr-slider__top{ display:flex; align-items:baseline; justify-content:space-between; }
.pwr-slider__label{ font-size:var(--fs-sm); color:var(--text-2); }
.pwr-slider__val{ font-family:var(--font-mono); font-variant-numeric:tabular-nums;
  font-size:var(--fs-sm); color:var(--text-1); font-weight:var(--fw-medium); }
.pwr-slider__input{ -webkit-appearance:none; appearance:none; width:100%; height:22px;
  background:transparent; cursor:pointer; margin:0; }
.pwr-slider__input::-webkit-slider-runnable-track{ height:6px; border-radius:var(--radius-pill);
  background:linear-gradient(to right, var(--accent) var(--_pct,50%), var(--surface-4) var(--_pct,50%)); }
.pwr-slider__input::-moz-range-track{ height:6px; border-radius:var(--radius-pill); background:var(--surface-4); }
.pwr-slider__input::-moz-range-progress{ height:6px; border-radius:var(--radius-pill); background:var(--accent); }
.pwr-slider__input::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none;
  width:16px; height:16px; margin-top:-5px; border-radius:50%; background:#eafff6;
  border:3px solid var(--accent); box-shadow:var(--glow-soft);
  transition:transform var(--dur-fast) var(--ease-out); }
.pwr-slider__input::-moz-range-thumb{ width:16px; height:16px; border-radius:50%; background:#eafff6;
  border:3px solid var(--accent); box-shadow:var(--glow-soft); }
.pwr-slider__input:active::-webkit-slider-thumb{ transform:scale(1.18); }
.pwr-slider__input:focus-visible{ outline:none; }
.pwr-slider__input:focus-visible::-webkit-slider-thumb{ box-shadow:var(--focus-ring); }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'slider');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Slider — continuous value control (charge limits, reserve %, thresholds).
 * Tracks fill with solar accent up to the current value.
 */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  unit = '',
  showValue = true,
  formatValue,
  className = '',
  ...rest
}) {
  inject();
  const v = value ?? min;
  const pct = ((v - min) / (max - min)) * 100;
  const display = formatValue ? formatValue(v) : `${v}${unit}`;
  return (
    <div className={['pwr-slider', className].filter(Boolean).join(' ')}>
      {(label || showValue) && (
        <div className="pwr-slider__top">
          {label && <span className="pwr-slider__label">{label}</span>}
          {showValue && <span className="pwr-slider__val">{display}</span>}
        </div>
      )}
      <input
        className="pwr-slider__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => onChange && onChange(Number(e.target.value), e)}
        style={{ '--_pct': pct + '%' }}
        {...rest}
      />
    </div>
  );
}
