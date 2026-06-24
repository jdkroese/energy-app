import type { InputHTMLAttributes } from 'react';
import { ensureDsStyles } from './dsStyles';

type Props = {
  label?: string;
  className?: string;
} & InputHTMLAttributes<HTMLInputElement>;

/** Input — text field matching the Power Select styling. */
export function Input({ label, className = '', ...rest }: Props) {
  ensureDsStyles();
  const field = <input className={['pwr-input', className].filter(Boolean).join(' ')} {...rest} />;
  if (!label) return field;
  return (
    <label className="pwr-input-field">
      <span className="pwr-input-field__label">{label}</span>
      {field}
    </label>
  );
}
