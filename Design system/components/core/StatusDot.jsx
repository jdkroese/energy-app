import React from 'react';

const CSS = `
.pwr-status{ display:inline-flex; align-items:center; gap:7px;
  font-family:var(--font-sans); font-size:var(--fs-xs); font-weight:var(--fw-medium);
  color:var(--text-2); white-space:nowrap; }
.pwr-status__dot{ position:relative; width:8px; height:8px; border-radius:50%;
  background:var(--_c, var(--text-3)); flex:none; }
.pwr-status[data-tone="solar"]{ --_c:var(--solar); }
.pwr-status[data-tone="battery"]{ --_c:var(--battery); }
.pwr-status[data-tone="grid"]{ --_c:var(--grid); }
.pwr-status[data-tone="home"]{ --_c:var(--home); }
.pwr-status[data-tone="danger"]{ --_c:var(--danger); }
.pwr-status[data-tone="offline"]{ --_c:var(--text-3); }
/* pulsing halo for live states */
.pwr-status--live .pwr-status__dot::after{
  content:""; position:absolute; inset:-3px; border-radius:50%;
  background:var(--_c); opacity:0.5; animation:pwr-pulse 1.8s var(--ease-out) infinite;
}
@keyframes pwr-pulse{ 0%{ transform:scale(0.7); opacity:0.55; } 70%{ transform:scale(2.4); opacity:0; } 100%{ opacity:0; } }
@media (prefers-reduced-motion: reduce){ .pwr-status--live .pwr-status__dot::after{ animation:none; } }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'status');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * StatusDot — a small colored dot with optional label and live pulse, for
 * connection / activity states ("Producing", "Charging", "Offline").
 */
export function StatusDot({
  tone = 'offline',
  live = false,
  className = '',
  children,
  ...rest
}) {
  inject();
  const cls = ['pwr-status', live && 'pwr-status--live', className].filter(Boolean).join(' ');
  return (
    <span className={cls} data-tone={tone} {...rest}>
      <span className="pwr-status__dot" aria-hidden="true" />
      {children}
    </span>
  );
}
