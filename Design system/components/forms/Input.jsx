import React from 'react';

const CSS = `
.pwr-field{ display:flex; flex-direction:column; gap:6px; }
.pwr-field__label{ font-size:var(--fs-sm); font-weight:var(--fw-medium); color:var(--text-2); }
.pwr-input-wrap{ position:relative; display:flex; align-items:center; }
.pwr-input{ width:100%; height:var(--control-md); padding:0 12px;
  background:var(--surface-2); color:var(--text-1);
  border:1px solid var(--border-2); border-radius:var(--radius-md);
  font-family:var(--font-sans); font-size:var(--fs-sm); line-height:1;
  transition:border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out),
             background var(--dur-fast) var(--ease-out); }
.pwr-input::placeholder{ color:var(--text-3); }
.pwr-input:hover{ border-color:var(--border-3); }
.pwr-input:focus{ outline:none; border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(46,230,160,0.18); background:var(--surface-1); }
.pwr-input:disabled{ opacity:0.5; cursor:not-allowed; }
.pwr-input--mono{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
.pwr-input--has-icon{ padding-left:38px; }
.pwr-input--has-suffix{ padding-right:44px; }
.pwr-input--err{ border-color:var(--danger); }
.pwr-input--err:focus{ box-shadow:0 0 0 3px var(--danger-wash); }
.pwr-input__icon{ position:absolute; left:12px; display:inline-flex; color:var(--text-3); pointer-events:none; }
.pwr-input__icon svg{ width:16px; height:16px; }
.pwr-input__suffix{ position:absolute; right:12px; font-family:var(--font-mono);
  font-size:var(--fs-xs); color:var(--text-3); pointer-events:none; }
.pwr-field__hint{ font-size:var(--fs-xs); color:var(--text-3); }
.pwr-field__hint--err{ color:var(--danger); }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'input');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Input — single-line text/number field. Use `mono` for numeric config values.
 */
export function Input({
  label,
  icon,
  suffix,
  hint,
  error,
  mono = false,
  id,
  className = '',
  ...rest
}) {
  inject();
  const fid = id || (label ? 'pwr-' + Math.random().toString(36).slice(2, 8) : undefined);
  const cls = [
    'pwr-input',
    mono && 'pwr-input--mono',
    icon && 'pwr-input--has-icon',
    suffix && 'pwr-input--has-suffix',
    error && 'pwr-input--err',
    className,
  ].filter(Boolean).join(' ');
  return (
    <div className="pwr-field">
      {label && <label className="pwr-field__label" htmlFor={fid}>{label}</label>}
      <div className="pwr-input-wrap">
        {icon && <span className="pwr-input__icon">{icon}</span>}
        <input id={fid} className={cls} aria-invalid={!!error} {...rest} />
        {suffix && <span className="pwr-input__suffix">{suffix}</span>}
      </div>
      {(hint || error) && (
        <span className={['pwr-field__hint', error && 'pwr-field__hint--err'].filter(Boolean).join(' ')}>
          {error || hint}
        </span>
      )}
    </div>
  );
}
