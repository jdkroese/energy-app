import React from 'react';

const CSS = `
.pwr-switch{ display:inline-flex; align-items:center; gap:10px; cursor:pointer; user-select:none; }
.pwr-switch input{ position:absolute; opacity:0; width:0; height:0; }
.pwr-switch__track{ position:relative; width:42px; height:24px; flex:none;
  background:var(--surface-4); border:1px solid var(--border-2); border-radius:var(--radius-pill);
  transition:background var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out),
             box-shadow var(--dur) var(--ease-out); }
.pwr-switch__thumb{ position:absolute; top:50%; left:3px; width:16px; height:16px; border-radius:50%;
  background:var(--text-2); transform:translateY(-50%);
  transition:transform var(--dur) var(--ease-spring), background var(--dur) var(--ease-out); }
.pwr-switch input:checked + .pwr-switch__track{ background:var(--accent); border-color:transparent; box-shadow:var(--glow-soft); }
.pwr-switch input:checked + .pwr-switch__track .pwr-switch__thumb{ transform:translate(18px,-50%); background:var(--accent-contrast); }
.pwr-switch input:focus-visible + .pwr-switch__track{ box-shadow:var(--focus-ring); }
.pwr-switch input:disabled + .pwr-switch__track{ opacity:0.4; }
.pwr-switch:has(input:disabled){ cursor:not-allowed; }
.pwr-switch__label{ font-size:var(--fs-sm); color:var(--text-1); }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'switch');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Switch — boolean toggle for settings & automation. Solar fill = on.
 */
export function Switch({
  checked,
  defaultChecked,
  onChange,
  disabled = false,
  label,
  className = '',
  ...rest
}) {
  inject();
  return (
    <label className={['pwr-switch', className].filter(Boolean).join(' ')}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        defaultChecked={defaultChecked}
        onChange={onChange}
        disabled={disabled}
        {...rest}
      />
      <span className="pwr-switch__track"><span className="pwr-switch__thumb" /></span>
      {label && <span className="pwr-switch__label">{label}</span>}
    </label>
  );
}
