import React from 'react';

const CSS = `
.pwr-badge{
  display:inline-flex; align-items:center; gap:5px;
  height:22px; padding:0 9px; border-radius:var(--radius-pill);
  font-family:var(--font-sans); font-size:var(--fs-xs); font-weight:var(--fw-semibold);
  letter-spacing:0.02em; line-height:1; white-space:nowrap;
  border:1px solid transparent;
}
.pwr-badge svg{ width:12px; height:12px; }
.pwr-badge--solid{ color:var(--text-inverse); }
.pwr-badge--soft{ background:var(--surface-3); color:var(--text-1); border-color:var(--border-1); }

.pwr-badge[data-tone="solar"].pwr-badge--soft{ background:var(--solar-wash); color:var(--solar); }
.pwr-badge[data-tone="battery"].pwr-badge--soft{ background:var(--battery-wash); color:var(--battery); }
.pwr-badge[data-tone="grid"].pwr-badge--soft{ background:var(--grid-wash); color:var(--grid); }
.pwr-badge[data-tone="home"].pwr-badge--soft{ background:var(--home-wash); color:var(--home); }
.pwr-badge[data-tone="danger"].pwr-badge--soft{ background:var(--danger-wash); color:var(--danger); }
.pwr-badge[data-tone="neutral"].pwr-badge--soft{ background:var(--surface-3); color:var(--text-2); }

.pwr-badge[data-tone="solar"].pwr-badge--solid{ background:var(--solar); }
.pwr-badge[data-tone="battery"].pwr-badge--solid{ background:var(--battery); }
.pwr-badge[data-tone="grid"].pwr-badge--solid{ background:var(--grid); }
.pwr-badge[data-tone="home"].pwr-badge--solid{ background:var(--home); }
.pwr-badge[data-tone="danger"].pwr-badge--solid{ background:var(--danger); color:#fff; }
.pwr-badge[data-tone="neutral"].pwr-badge--solid{ background:var(--surface-4); color:var(--text-1); }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'badge');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Badge / Tag — compact status or category pill. Soft (washed) by default;
 * solid for high-emphasis live states.
 */
export function Badge({
  tone = 'neutral',
  variant = 'soft',
  icon,
  className = '',
  children,
  ...rest
}) {
  inject();
  const cls = ['pwr-badge', `pwr-badge--${variant}`, className].filter(Boolean).join(' ');
  return (
    <span className={cls} data-tone={tone} {...rest}>
      {icon && icon}
      {children}
    </span>
  );
}
