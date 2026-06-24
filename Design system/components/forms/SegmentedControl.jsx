import React from 'react';

const CSS = `
.pwr-seg{ display:inline-flex; padding:3px; gap:2px; background:var(--surface-2);
  border:1px solid var(--border-1); border-radius:var(--radius-md); }
.pwr-seg--block{ display:flex; width:100%; }
.pwr-seg__opt{ flex:1; display:inline-flex; align-items:center; justify-content:center; gap:6px;
  height:30px; padding:0 14px; border:none; background:transparent; cursor:pointer;
  font-family:var(--font-sans); font-size:var(--fs-sm); font-weight:var(--fw-medium);
  color:var(--text-2); border-radius:var(--radius-sm); white-space:nowrap;
  transition:color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out); }
.pwr-seg__opt:hover{ color:var(--text-1); }
.pwr-seg__opt[aria-selected="true"]{ background:var(--surface-4); color:var(--text-1);
  box-shadow:var(--shadow-1), var(--hairline-top); }
.pwr-seg__opt:focus-visible{ outline:none; box-shadow:var(--focus-ring); }
.pwr-seg__opt svg{ width:15px; height:15px; }
.pwr-seg--sm .pwr-seg__opt{ height:26px; padding:0 10px; font-size:var(--fs-xs); }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'seg');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * SegmentedControl — pick one of a few mutually-exclusive options. Used for
 * time ranges (Day/Week/Month/Year) and view switches across the product.
 */
export function SegmentedControl({
  options = [],
  value,
  onChange,
  size = 'md',
  block = false,
  className = '',
  ...rest
}) {
  inject();
  const cls = [
    'pwr-seg',
    size === 'sm' && 'pwr-seg--sm',
    block && 'pwr-seg--block',
    className,
  ].filter(Boolean).join(' ');
  const norm = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return (
    <div className={cls} role="tablist" {...rest}>
      {norm.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className="pwr-seg__opt"
          onClick={() => onChange && onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
