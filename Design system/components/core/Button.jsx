import React from 'react';

const CSS = `
.pwr-btn{
  --_h: var(--control-md);
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  height:var(--_h); padding:0 16px;
  font-family:var(--font-sans); font-size:var(--fs-sm); font-weight:var(--fw-semibold);
  letter-spacing:var(--ls-heading); line-height:1; white-space:nowrap;
  border-radius:var(--radius-md); border:1px solid transparent;
  cursor:pointer; user-select:none; text-decoration:none;
  transition:background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out),
             color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out),
             box-shadow var(--dur-fast) var(--ease-out);
}
.pwr-btn:active{ transform:translateY(1px) scale(0.99); }
.pwr-btn:focus-visible{ outline:none; box-shadow:var(--focus-ring); }
.pwr-btn[disabled],.pwr-btn[aria-disabled="true"]{ cursor:not-allowed; opacity:0.45; transform:none; box-shadow:none; }
.pwr-btn--sm{ --_h:var(--control-sm); padding:0 12px; font-size:var(--fs-xs); }
.pwr-btn--lg{ --_h:var(--control-lg); padding:0 22px; font-size:var(--fs-body); }
.pwr-btn--block{ display:flex; width:100%; }

.pwr-btn--primary{ background:var(--accent); color:var(--accent-contrast); box-shadow:var(--glow-soft); }
.pwr-btn--primary:hover{ background:#48f0b1; box-shadow:var(--glow-solar); }

.pwr-btn--secondary{ background:var(--surface-2); color:var(--text-1); border-color:var(--border-2); }
.pwr-btn--secondary:hover{ background:var(--surface-3); border-color:var(--border-3); }

.pwr-btn--ghost{ background:transparent; color:var(--text-2); }
.pwr-btn--ghost:hover{ background:var(--surface-2); color:var(--text-1); }

.pwr-btn--danger{ background:var(--danger); color:#fff; }
.pwr-btn--danger:hover{ background:#ff7575; }

.pwr-btn__spin{ width:14px;height:14px;border-radius:50%;
  border:2px solid currentColor;border-right-color:transparent;animation:pwr-btn-spin .7s linear infinite; }
@keyframes pwr-btn-spin{ to{ transform:rotate(360deg); } }
.pwr-btn__ic{ display:inline-flex; }
.pwr-btn__ic svg{ width:1em;height:1em; }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'button');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Button — primary action control. Solar-green fill is reserved for the single
 * most important action on a surface; everything else is secondary/ghost.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  iconLeft,
  iconRight,
  loading = false,
  block = false,
  disabled = false,
  as = 'button',
  className = '',
  children,
  ...rest
}) {
  inject();
  const Tag = as;
  const cls = [
    'pwr-btn',
    `pwr-btn--${variant}`,
    size !== 'md' && `pwr-btn--${size}`,
    block && 'pwr-btn--block',
    className,
  ].filter(Boolean).join(' ');

  return (
    <Tag
      className={cls}
      disabled={Tag === 'button' ? disabled || loading : undefined}
      aria-disabled={disabled || loading || undefined}
      {...rest}
    >
      {loading && <span className="pwr-btn__spin" aria-hidden="true" />}
      {!loading && iconLeft && <span className="pwr-btn__ic">{iconLeft}</span>}
      {children}
      {!loading && iconRight && <span className="pwr-btn__ic">{iconRight}</span>}
    </Tag>
  );
}
