import * as React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Color tone, tied to energy nodes + semantics. */
  tone?: 'solar' | 'battery' | 'grid' | 'home' | 'danger' | 'neutral';
  /** `soft` = washed tint (default), `solid` = filled. */
  variant?: 'soft' | 'solid';
  /** Optional leading icon node. */
  icon?: React.ReactNode;
  children?: React.ReactNode;
}

/** Compact status / category pill. */
export function Badge(props: BadgeProps): JSX.Element;
