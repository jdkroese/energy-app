import * as React from 'react';

export interface RadialGaugeProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  min?: number;
  max?: number;
  /** Diameter in px. */
  size?: number;
  /** Arc stroke width in px. */
  thickness?: number;
  tone?: 'solar' | 'battery' | 'grid' | 'home' | 'ev' | 'accent';
  /** Uppercase caption below the value. */
  label?: React.ReactNode;
  unit?: React.ReactNode;
  showValue?: boolean;
  /** Override the centered value text. */
  valueText?: React.ReactNode;
}

/** 270° arc gauge for bounded values (battery %, charge level, self-sufficiency). */
export function RadialGauge(props: RadialGaugeProps): JSX.Element;
