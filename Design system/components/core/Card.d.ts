import * as React from 'react';

/**
 * @startingPoint section="Core" subtitle="Panel surface — header, accent rail, glow" viewport="700x260"
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Optional header title. When set, a header row with a divider renders. */
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Icon node shown at the start of the header. */
  icon?: React.ReactNode;
  /** Header action nodes (e.g. IconButtons) pinned to the right. */
  actions?: React.ReactNode;
  /** Tints a 2px rail along the top edge to an energy node. */
  accent?: 'solar' | 'battery' | 'grid' | 'home' | 'ev';
  /** Adds a soft solar glow — reserve for live / active panels. */
  glow?: boolean;
  /** Hover lift + border highlight, for clickable cards. */
  interactive?: boolean;
  /** Force body padding on/off (defaults: on when no header). */
  padded?: boolean;
  children?: React.ReactNode;
}

/** The canonical dark surface panel. */
export function Card(props: CardProps): JSX.Element;
