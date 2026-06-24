import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { ensureDsStyles } from './dsStyles';

export type Accent = 'solar' | 'battery' | 'grid' | 'home' | 'ev' | 'danger';

type Props = {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  accent?: Accent;
  glow?: boolean;
  interactive?: boolean;
  padded?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>;

/** Card — the canonical dark panel. Glow + top accent rail are opt-in for live data. */
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
}: Props) {
  ensureDsStyles();
  const hasHeader = Boolean(title || actions || icon);
  const cls = [
    'pwr-card',
    glow && 'pwr-card--glow',
    interactive && 'pwr-card--interactive',
    (padded ?? !hasHeader) && 'pwr-card--pad',
    className,
  ]
    .filter(Boolean)
    .join(' ');

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
