import { forwardRef, type InputHTMLAttributes } from 'react';
import { ensureDsStyles } from './dsStyles';

type Props = {
  label?: string;
  className?: string;
} & InputHTMLAttributes<HTMLInputElement>;

/** Input — text field matching the Power Select styling. Forwards its ref to the
 *  underlying <input> so callers (e.g. inline-edit fields) can focus it. */
export const Input = forwardRef<HTMLInputElement, Props>(function Input({ label, className = '', ...rest }, ref) {
  ensureDsStyles();
  const field = <input ref={ref} className={['pwr-input', className].filter(Boolean).join(' ')} {...rest} />;
  if (!label) return field;
  return (
    <label className="pwr-input-field">
      <span className="pwr-input-field__label">{label}</span>
      {field}
    </label>
  );
});
