import type { ReactNode } from 'react';
import { ensureDsStyles } from './dsStyles';
import { usePrefersReducedMotion } from '../../lib/usePrefersReducedMotion';

type Props = {
  /** When true the content expands to its natural height; when false it collapses to 0. */
  open: boolean;
  children: ReactNode;
  className?: string;
};

/**
 * InlineReveal — a clean, jank-free expand/collapse for inline editors (rename
 * fields, inline setpoint editors). Uses the CSS grid-rows `0fr → 1fr` trick so
 * height animates without measuring; the inner wrapper clips overflow and fades.
 * Honours `prefers-reduced-motion` (snaps instantly, no transition). The content
 * stays mounted so focus/state survive the toggle.
 */
export function InlineReveal({ open, children, className = '' }: Props) {
  ensureDsStyles();
  const reduce = usePrefersReducedMotion();
  const cls = [
    'pwr-reveal',
    open && 'pwr-reveal--open',
    reduce && 'pwr-reveal--instant',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} aria-hidden={!open}>
      <div className="pwr-reveal__inner">{children}</div>
    </div>
  );
}
