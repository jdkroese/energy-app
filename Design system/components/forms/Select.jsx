import React from 'react';

const CSS = `
.pwr-select-field{ display:flex; flex-direction:column; gap:6px; }
.pwr-select-field__label{ font-size:var(--fs-sm); font-weight:var(--fw-medium); color:var(--text-2); }
.pwr-select-wrap{ position:relative; display:flex; align-items:center; }
.pwr-select{ width:100%; height:var(--control-md); padding:0 38px 0 12px;
  background:var(--surface-2); color:var(--text-1); cursor:pointer;
  border:1px solid var(--border-2); border-radius:var(--radius-md);
  font-family:var(--font-sans); font-size:var(--fs-sm); line-height:1;
  -webkit-appearance:none; appearance:none;
  transition:border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
.pwr-select:hover{ border-color:var(--border-3); }
.pwr-select:focus{ outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(46,230,160,0.18); }
.pwr-select:disabled{ opacity:0.5; cursor:not-allowed; }
.pwr-select__chev{ position:absolute; right:12px; display:inline-flex; color:var(--text-3); pointer-events:none; }
.pwr-select__chev svg{ width:16px; height:16px; }
.pwr-select option{ background:var(--surface-2); color:var(--text-1); }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'select');
  s.textContent = CSS;
  document.head.appendChild(s);
}

const Chevron = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
);

/**
 * Select — native dropdown styled to the system. Options as strings or
 * {value,label} objects.
 */
export function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder,
  id,
  className = '',
  ...rest
}) {
  inject();
  const fid = id || (label ? 'pwr-' + Math.random().toString(36).slice(2, 8) : undefined);
  const norm = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return (
    <div className="pwr-select-field">
      {label && <label className="pwr-select-field__label" htmlFor={fid}>{label}</label>}
      <div className="pwr-select-wrap">
        <select
          id={fid}
          className={['pwr-select', className].filter(Boolean).join(' ')}
          value={value}
          onChange={onChange}
          {...rest}
        >
          {placeholder && <option value="" disabled>{placeholder}</option>}
          {norm.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span className="pwr-select__chev"><Chevron /></span>
      </div>
    </div>
  );
}
