import React from 'react';

const CSS = `
.pwr-card{
  position:relative; display:flex; flex-direction:column;
  background:var(--surface-card); border:1px solid var(--border-1);
  border-radius:var(--radius-card); box-shadow:var(--shadow-2), var(--hairline-top);
  overflow:hidden;
}
.pwr-card--pad{ padding:var(--space-5); }
.pwr-card--interactive{ cursor:pointer; transition:border-color var(--dur) var(--ease-out),
  transform var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out); }
.pwr-card--interactive:hover{ border-color:var(--border-3); transform:translateY(-2px);
  box-shadow:var(--shadow-card), var(--hairline-top); }
.pwr-card--glow{ box-shadow:var(--shadow-2), var(--glow-soft), var(--hairline-top);
  border-color:rgba(46,230,160,0.28); }
/* accent rail along the top edge, tinted to the energy node */
.pwr-card[data-accent]::before{
  content:""; position:absolute; inset:0 0 auto 0; height:2px;
  background:var(--_rail, var(--accent)); opacity:0.9;
}
.pwr-card[data-accent="solar"]{ --_rail:var(--solar); }
.pwr-card[data-accent="battery"]{ --_rail:var(--battery); }
.pwr-card[data-accent="grid"]{ --_rail:var(--grid); }
.pwr-card[data-accent="home"]{ --_rail:var(--home); }
.pwr-card[data-accent="ev"]{ --_rail:var(--ev); }

.pwr-card__head{ display:flex; align-items:center; gap:var(--space-3);
  padding:var(--space-4) var(--space-5); border-bottom:1px solid var(--border-1); }
.pwr-card__title{ font-size:var(--fs-h4); font-weight:var(--fw-semibold);
  letter-spacing:var(--ls-heading); color:var(--text-1); margin:0; }
.pwr-card__sub{ font-size:var(--fs-xs); color:var(--text-2); margin:2px 0 0; }
.pwr-card__head-actions{ margin-left:auto; display:flex; align-items:center; gap:var(--space-1); }
.pwr-card__head-ic{ display:inline-flex; color:var(--text-2); }
.pwr-card__head-ic svg{ width:18px; height:18px; }
.pwr-card__body{ padding:var(--space-5); flex:1; }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'card');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Card — the canonical dark panel. A flat surface with a hairline border and
 * deep soft shadow; glow and the top accent rail are opt-in for live data.
 */
export function Card({
  title,
  subtitle,
  icon,
  actions,
  accent,
  glow = false,
  interactive = false,
  padded,
  className = '',
  children,
  ...rest
}) {
  inject();
  const hasHeader = title || actions || icon;
  const cls = [
    'pwr-card',
    glow && 'pwr-card--glow',
    interactive && 'pwr-card--interactive',
    (padded ?? !hasHeader) && 'pwr-card--pad',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} data-accent={accent || undefined} {...rest}>
      {hasHeader && (
        <div className="pwr-card__head">
          {icon && <span className="pwr-card__head-ic">{icon}</span>}
          {(title || subtitle) && (
            <div>
              {title && <p className="pwr-card__title">{title}</p>}
              {subtitle && <p className="pwr-card__sub">{subtitle}</p>}
            </div>
          )}
          {actions && <div className="pwr-card__head-actions">{actions}</div>}
        </div>
      )}
      {hasHeader ? <div className="pwr-card__body">{children}</div> : children}
    </div>
  );
}
