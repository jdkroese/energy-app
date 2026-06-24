import * as React from 'react';

export interface SegmentOption {
  value: string;
  label?: React.ReactNode;
  icon?: React.ReactNode;
}

export interface SegmentedControlProps {
  /** Options as strings or {value,label,icon} objects. */
  options: Array<string | SegmentOption>;
  /** Currently selected value. */
  value?: string;
  onChange?: (value: string) => void;
  size?: 'sm' | 'md';
  block?: boolean;
  className?: string;
}

/** One-of-many selector for time ranges & view switches. */
export function SegmentedControl(props: SegmentedControlProps): JSX.Element;
