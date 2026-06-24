import * as React from 'react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'ghost' | 'solid' | 'accent';
  size?: 'sm' | 'md' | 'lg';
  /** Accessible label (also used as tooltip title). Required. */
  label: string;
  /** A single icon node. */
  children: React.ReactNode;
}

/** Square single-icon control for toolbars and compact actions. */
export function IconButton(props: IconButtonProps): JSX.Element;
