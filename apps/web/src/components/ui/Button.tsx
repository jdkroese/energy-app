import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ensureDsStyles } from './dsStyles';

type Props = {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
  block?: boolean;
  children?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/** Button — primary action control. Solar fill reserved for the top action. */
export function Button({
  variant = 'primary',
  size = 'md',
  iconLeft,
  iconRight,
  loading = false,
  block = false,
  disabled = false,
  className = '',
  children,
  ...rest
}: Props) {
  ensureDsStyles();
  const cls = [
    'pwr-btn',
    `pwr-btn--${variant}`,
    size !== 'md' && `pwr-btn--${size}`,
    block && 'pwr-btn--block',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} disabled={disabled || loading} aria-disabled={disabled || loading || undefined} {...rest}>
      {loading && <span className="pwr-btn__spin" aria-hidden="true" />}
      {!loading && iconLeft && <span className="pwr-btn__ic">{iconLeft}</span>}
      {children}
      {!loading && iconRight && <span className="pwr-btn__ic">{iconRight}</span>}
    </button>
  );
}
