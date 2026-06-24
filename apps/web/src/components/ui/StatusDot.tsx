import type { ReactNode } from 'react';
import { ensureDsStyles } from './dsStyles';

type Props = {
  tone?: 'solar' | 'battery' | 'grid' | 'home' | 'danger' | 'offline';
  live?: boolean;
  className?: string;
  children?: ReactNode;
};

/** StatusDot — colored dot + optional label and live pulse. */
export function StatusDot({ tone = 'offline', live = false, className = '', children }: Props) {
  ensureDsStyles();
  const cls = ['pwr-status', live && 'pwr-status--live', className].filter(Boolean).join(' ');
  return (
    <span className={cls} data-tone={tone}>
      <span className="pwr-status__dot" aria-hidden="true" />
      {children}
    </span>
  );
}
