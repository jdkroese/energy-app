import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ensureDsStyles } from './dsStyles';

type Props = {
  variant?: 'ghost' | 'solid' | 'accent';
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  children?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/** IconButton — square control wrapping a single icon. Always pass a label. */
export function IconButton({ variant = 'ghost', size = 'md', label, className = '', children, ...rest }: Props) {
  ensureDsStyles();
  const cls = [
    'pwr-iconbtn',
    variant !== 'ghost' && `pwr-iconbtn--${variant}`,
    size !== 'md' && `pwr-iconbtn--${size}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}
