import type { ReactNode } from 'react';

/** Eyebrow — uppercase overline label used above every screen/section title. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={['pwr-eyebrow', className].filter(Boolean).join(' ')}>{children}</span>;
}
