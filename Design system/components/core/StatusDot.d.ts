import * as React from 'react';

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: 'solar' | 'battery' | 'grid' | 'home' | 'danger' | 'offline';
  /** Animate a pulsing halo for active/live states. */
  live?: boolean;
  /** Optional trailing label. */
  children?: React.ReactNode;
}

/** Small status dot with optional label + live pulse. */
export function StatusDot(props: StatusDotProps): JSX.Element;
