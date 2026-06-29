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
      /** Optional trailing count badge (mono). Shown when > 0 (or always, with `countAlways`). */
      count?: number;
      /** Render the count even when 0 (used for the warning "needs setup" segment). */
      countAlways?: boolean;
      /** Optional tone — `warning` gives the amber/grid framed treatment (e.g. "Needs setup"). */
      tone?: 'warning';
      /** Optional accessible title/tooltip. */
      title?: string;
    };

type Props = {
  options?: Option[];
  value?: string;
  onChange?: (value: string) => void;
  size?: 'sm' | 'md';
  block?: boolean;
  /** Allow segments to wrap onto multiple rows instead of squashing (for many tabs). */
  wrap?: boolean;
  className?: string;
};

/** SegmentedControl — pick one of a few options (ranges, view switches).
 *  Options may carry an optional leading `icon` or hue `dot`, a trailing
 *  `count` badge, and a `tone` (e.g. `warning`) so bespoke tab strips can adopt
 *  the primitive. `wrap` lets long tab sets reflow instead of squashing. */
export function SegmentedControl({ options = [], value, onChange, size = 'md', block = false, wrap = false, className = '' }: Props) {
  ensureDsStyles();
  const cls = ['pwr-seg', size === 'sm' && 'pwr-seg--sm', block && 'pwr-seg--block', wrap && 'pwr-seg--wrap', className].filter(Boolean).join(' ');
  const norm = options.map((o) =>
    typeof o === 'string'
      ? { value: o, label: o, icon: undefined, dot: undefined, count: undefined, countAlways: false, tone: undefined, title: undefined }
      : o,
  );
  return (
    <div className={cls} role="tablist">
      {norm.map((o) => {
        const selected = o.value === value;
        const optCls = ['pwr-seg__opt', o.tone === 'warning' && 'pwr-seg__opt--warning'].filter(Boolean).join(' ');
        const showCount = typeof o.count === 'number' && (o.countAlways || o.count > 0);
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={selected}
            title={o.title}
            className={optCls}
            onClick={() => onChange && onChange(o.value)}
          >
            {o.dot && <span className="pwr-seg__dot" style={{ background: o.dot, opacity: selected ? 1 : 0.6 }} />}
            {o.icon}
            <span className="pwr-seg__label">{o.label}</span>
            {showCount && <span className="pwr-seg__count">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
