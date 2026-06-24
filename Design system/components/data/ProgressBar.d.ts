import * as React from 'react';

export interface ProgressSegment {
  /** Width as a percentage of the full track. */
  value: number;
  /** Energy tone keyword or any CSS color. */
  tone?: 'solar' | 'battery' | 'grid' | 'home' | 'ev' | 'accent' | 'danger' | string;
  label?: string;
}

export interface ProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
  tone?: 'solar' | 'battery' | 'grid' | 'home' | 'ev' | 'accent' | 'danger';
  /** Track height in px. */
  height?: number;
  label?: React.ReactNode;
  valueText?: React.ReactNode;
  showValue?: boolean;
  glow?: boolean;
  /** Stacked segments for an energy-mix bar; overrides `value`. */
  segments?: ProgressSegment[];
}

/** Linear level/progress bar; supports a stacked energy-mix mode. */
export function ProgressBar(props: ProgressBarProps): JSX.Element;
