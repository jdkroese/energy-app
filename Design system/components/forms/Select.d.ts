import * as React from 'react';

export interface SelectOption {
  value: string;
  label?: React.ReactNode;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  label?: React.ReactNode;
  options: Array<string | SelectOption>;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  placeholder?: string;
}

/** Native dropdown styled to the Power system. */
export function Select(props: SelectProps): JSX.Element;
