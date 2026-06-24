import * as React from 'react';

/**
 * @startingPoint section="Data" subtitle="Metric readout — value, unit, delta, tone" viewport="700x200"
 */
export interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Uppercase caption above the value. */
  label?: React.ReactNode;
  /** The number/string readout (rendered in mono tabular figures). */
  value: React.ReactNode;
  /** Unit suffix (e.g. 'kW', 'kWh', '%'). */
  unit?: React.ReactNode;
  /** Energy tone — colors the value + icon chip. */
  tone?: 'solar' | 'battery' | 'grid' | 'home' | 'ev' | 'neutral';
  icon?: React.ReactNode;
  size?: 'sm' | 'md' | 'xl';
  /** Delta vs comparison period. Number → auto ±% with arrow; string → shown as-is. */
  delta?: number | string;
  /** Force the arrow direction. */
  deltaDir?: 'up' | 'down' | 'flat';
  /** Trailing caption next to the delta (e.g. 'vs yesterday'). */
  footnote?: React.ReactNode;
  /** Extra content (e.g. an inline Sparkline). */
  children?: React.ReactNode;
}

/** The core metric readout used across every dashboard. */
export function StatTile(props: StatTileProps): JSX.Element;
