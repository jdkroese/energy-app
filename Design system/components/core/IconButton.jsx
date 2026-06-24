import React from 'react';

const CSS = `
.pwr-iconbtn{
  --_s: var(--control-md);
  display:inline-flex; align-items:center; justify-content:center;
  width:var(--_s); height:var(--_s); padding:0;
  border-radius:var(--radius-md); border:1px solid transparent;
  background:transparent; color:var(--text-2); cursor:pointer;
  transition:background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out),
             border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.pwr-iconbtn:hover{ background:var(--surface-2); color:var(--text-1); }
.pwr-iconbtn:active{ transform:scale(0.92); }
.pwr-iconbtn:focus-visible{ outline:none; box-shadow:var(--focus-ring); }
.pwr-iconbtn[disabled]{ opacity:0.4; cursor:not-allowed; }
.pwr-iconbtn svg{ width:18px; height:18px; }
.pwr-iconbtn--sm{ --_s:var(--control-sm); }
.pwr-iconbtn--sm svg{ width:15px; height:15px; }
.pwr-iconbtn--lg{ --_s:var(--control-lg); }
.pwr-iconbtn--lg svg{ width:20px; height:20px; }
.pwr-iconbtn--solid{ background:var(--surface-2); border-color:var(--border-2); }
.pwr-iconbtn--solid:hover{ background:var(--surface-3); border-color:var(--border-3); }
.pwr-iconbtn--accent{ background:var(--accent); color:var(--accent-contrast); box-shadow:var(--glow-soft); }
.pwr-iconbtn--accent:hover{ background:#48f0b1; box-shadow:var(--glow-solar); }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'iconbtn');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * IconButton — square control wrapping a single icon. Used for toolbar actions,
 * card overflow menus, and compact controls. Always pass an aria-label.
 */
export function IconButton({
  variant = 'ghost',
  size = 'md',
  label,
  className = '',
  children,
  ...rest
}) {
  inject();
  const cls = [
    'pwr-iconbtn',
    variant !== 'ghost' && `pwr-iconbtn--${variant}`,
    size !== 'md' && `pwr-iconbtn--${size}`,
    className,
  ].filter(Boolean).join(' ');
  return (
    <button className={cls} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}
