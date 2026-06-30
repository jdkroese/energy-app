import type { SelectHTMLAttributes } from 'react';
import { ensureDsStyles } from './dsStyles';

type Option = string | { value: string; label: string };
/** A labelled group of options → renders a native <optgroup>. */
type OptionGroup = { group: string; options: Option[] };

type Props = {
  label?: string;
  options?: Option[];
  /** Optional grouped options (rendered as <optgroup>s, after any flat `options`). */
  groups?: OptionGroup[];
  placeholder?: string;
  className?: string;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'>;

const Chevron = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

/** Select — native dropdown styled to the system. */
export function Select({ label, options = [], groups = [], placeholder, className = '', id, ...rest }: Props) {
  ensureDsStyles();
  const fid = id || (label ? 'pwr-' + Math.random().toString(36).slice(2, 8) : undefined);
  const toOpt = (o: Option) => (typeof o === 'string' ? { value: o, label: o } : o);
  const norm = options.map(toOpt);
  return (
    <div className="pwr-select-field">
      {label && (
        <label className="pwr-select-field__label" htmlFor={fid}>
          {label}
        </label>
      )}
      <div className="pwr-select-wrap">
        <select id={fid} className={['pwr-select', className].filter(Boolean).join(' ')} {...rest}>
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {norm.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {groups.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.options.map(toOpt).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="pwr-select__chev">
          <Chevron />
        </span>
      </div>
    </div>
  );
}
