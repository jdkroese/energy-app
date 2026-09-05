import type { ReactNode } from 'react';
import { ensureDsStyles } from './dsStyles';

type Props = {
  tone?: 'solar' | 'battery' | 'grid' | 'home' | 'ev' | 'water' | 'danger' | 'neutral';
  variant?: 'soft' | 'solid';
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
};

/** Badge — compact status / category pill. Soft by default. */
export function Badge({ tone = 'neutral', variant = 'soft', icon, className = '', children }: Props) {
  ensureDsStyles();
  const cls = ['pwr-badge', `pwr-badge--${variant}`, className].filter(Boolean).join(' ');
  return (
    <span className={cls} data-tone={tone}>
      {icon}
      {children}
    </span>
  );
}
