import * as React from 'react';

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  /** Optional trailing text label. */
  label?: React.ReactNode;
}

/** Boolean toggle for settings & automation rules; solar fill = on. */
export function Switch(props: SwitchProps): JSX.Element;
