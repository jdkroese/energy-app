import * as React from 'react';

/**
 * @startingPoint section="Core" subtitle="Buttons — primary, secondary, ghost, danger" viewport="700x180"
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. `primary` = solar-green fill (one per surface). */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Icon node rendered before the label (e.g. a Lucide <i>/<svg>). */
  iconLeft?: React.ReactNode;
  /** Icon node rendered after the label. */
  iconRight?: React.ReactNode;
  /** Shows a spinner and disables interaction. */
  loading?: boolean;
  /** Stretch to full container width. */
  block?: boolean;
  /** Render as a different element (e.g. 'a'). */
  as?: 'button' | 'a';
  children?: React.ReactNode;
}

/** Primary action control for the Power system. */
export function Button(props: ButtonProps): JSX.Element;
