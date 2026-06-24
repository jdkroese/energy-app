import type { ChangeEvent, CSSProperties } from 'react';
import { ensureDsStyles } from './dsStyles';

type Props = {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number, e: ChangeEvent<HTMLInputElement>) => void;
  label?: string;
  unit?: string;
  showValue?: boolean;
  formatValue?: (v: number) => string;
  className?: string;
};

/** Slider — continuous value control (reserve %, thresholds). Solar fill to value. */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  unit = '',
  showValue = true,
  formatValue,
  className = '',
}: Props) {
  ensureDsStyles();
  const v = value ?? min;
  const pct = ((v - min) / (max - min)) * 100;
  const display = formatValue ? formatValue(v) : `${v}${unit}`;
  return (
    <div className={['pwr-slider', className].filter(Boolean).join(' ')}>
      {(label || showValue) && (
        <div className="pwr-slider__top">
          {label && <span className="pwr-slider__label">{label}</span>}
          {showValue && <span className="pwr-slider__val">{display}</span>}
        </div>
      )}
      <input
        className="pwr-slider__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => onChange && onChange(Number(e.target.value), e)}
        style={{ '--_pct': pct + '%' } as CSSProperties}
      />
    </div>
  );
}
