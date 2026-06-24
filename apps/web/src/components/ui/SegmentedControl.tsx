import type { ReactNode } from 'react';
import { ensureDsStyles } from './dsStyles';

type Option = string | { value: string; label: string; icon?: ReactNode };

type Props = {
  options?: Option[];
  value?: string;
  onChange?: (value: string) => void;
  size?: 'sm' | 'md';
  block?: boolean;
  className?: string;
};

/** SegmentedControl — pick one of a few options (ranges, view switches). */
export function SegmentedControl({ options = [], value, onChange, size = 'md', block = false, className = '' }: Props) {
  ensureDsStyles();
  const cls = ['pwr-seg', size === 'sm' && 'pwr-seg--sm', block && 'pwr-seg--block', className].filter(Boolean).join(' ');
  const norm = options.map((o) => (typeof o === 'string' ? { value: o, label: o, icon: undefined } : o));
  return (
    <div className={cls} role="tablist">
      {norm.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className="pwr-seg__opt"
          onClick={() => onChange && onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
