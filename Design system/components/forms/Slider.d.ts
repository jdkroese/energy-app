import * as React from 'react';

export interface SliderProps {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number, e?: React.ChangeEvent<HTMLInputElement>) => void;
  /** Caption shown above-left. */
  label?: React.ReactNode;
  /** Unit appended to the value readout (e.g. '%', ' kWh'). */
  unit?: string;
  showValue?: boolean;
  /** Custom value formatter; overrides unit. */
  formatValue?: (value: number) => React.ReactNode;
  className?: string;
}

/** Continuous control for charge limits, reserve %, and thresholds. */
export function Slider(props: SliderProps): JSX.Element;
