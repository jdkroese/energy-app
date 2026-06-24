import * as React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
  /** Leading icon node. */
  icon?: React.ReactNode;
  /** Trailing unit/suffix (e.g. 'kWh', '€'). */
  suffix?: React.ReactNode;
  hint?: React.ReactNode;
  /** Error message; turns the field red and overrides hint. */
  error?: React.ReactNode;
  /** Monospace tabular figures, for numeric config values. */
  mono?: boolean;
}

/** Single-line text/number field with label, icon, suffix, hint & error. */
export function Input(props: InputProps): JSX.Element;
