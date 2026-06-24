import * as React from 'react';

export interface SparklineProps extends React.SVGAttributes<SVGSVGElement> {
  /** Series of values. */
  data: number[];
  width?: number;
  height?: number;
  tone?: 'solar' | 'battery' | 'grid' | 'home' | 'ev' | 'accent';
  /** Render the gradient area under the line. */
  area?: boolean;
  strokeWidth?: number;
  /** Dot on the last point. */
  showDot?: boolean;
}

/** Compact axis-less trend chart for tiles and table rows. */
export function Sparkline(props: SparklineProps): JSX.Element;
