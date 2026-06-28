import type { ReactNode } from 'react';
import { ensureDsStyles } from './dsStyles';

type Option =
  | string
  | {
      value: string;
      label: string;
      /** Optional leading icon, rendered before the label. */
      icon?: ReactNode;
      /** Optional leading hue dot (any CSS color, e.g. `var(--solar)`). Rendered before the label. */
      dot?: string;
      /** Optional trailing count badge (mono). Shown when > 0. */
      count?: number;
    };

type Props = {
  options?: Option[];
  value?: string;
  onChange?: (value: string) => void;
  size?: 'sm' | 'md';
  block?: boolean;
  className?: string;
};

/** SegmentedControl — pick one of a few options (ranges, view switches).
 *  Options may carry an optional leading `icon` or hue `dot` and a trailing
 *  `count` badge so bespoke tab strips can adopt the primitive. */
export function SegmentedControl({ options = [], value, onChange, size = 'md', block = false, className = '' }: Props) {
  ensureDsStyles();
  const cls = ['pwr-seg', size === 'sm' && 'pwr-seg--sm', block && 'pwr-seg--block', className].filter(Boolean).join(' ');
  const norm = options.map((o) =>
    typeof o === 'string' ? { value: o, label: o, icon: undefined, dot: undefined, count: undefined } : o,
  );
  return (
    <div className={cls} role="tablist">
      {norm.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={selected}
            className="pwr-seg__opt"
            onClick={() => onChange && onChange(o.value)}
          >
            {o.dot && <span className="pwr-seg__dot" style={{ background: o.dot, opacity: selected ? 1 : 0.6 }} />}
            {o.icon}
            <span className="pwr-seg__label">{o.label}</span>
            {typeof o.count === 'number' && o.count > 0 && <span className="pwr-seg__count">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
