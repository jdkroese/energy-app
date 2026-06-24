import type { InputHTMLAttributes } from 'react';
import { ensureDsStyles } from './dsStyles';

type Props = {
  label?: string;
  className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/** Switch — boolean toggle. Solar fill = on. */
export function Switch({ label, className = '', ...rest }: Props) {
  ensureDsStyles();
  return (
    <label className={['pwr-switch', className].filter(Boolean).join(' ')}>
      <input type="checkbox" role="switch" {...rest} />
      <span className="pwr-switch__track">
        <span className="pwr-switch__thumb" />
      </span>
      {label && <span className="pwr-switch__label">{label}</span>}
    </label>
  );
}
