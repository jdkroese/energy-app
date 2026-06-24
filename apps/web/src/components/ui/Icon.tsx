import type { ComponentType } from 'react';
import { icons, type LucideProps } from 'lucide-react';

export type IconName = keyof typeof icons;

type Props = LucideProps & {
  /** lucide icon name in kebab-case, e.g. "battery-charging" */
  name: string;
};

/** Convert kebab-case lucide name → PascalCase export key. */
function pascal(name: string): string {
  return name
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/**
 * Icon — thin wrapper over lucide-react that accepts the kebab-case names used
 * across the mockups (data-lucide). Falls back to a no-op span if unknown.
 */
export function Icon({ name, size = 18, ...rest }: Props) {
  const Cmp = (icons as Record<string, ComponentType<LucideProps>>)[pascal(name)];
  if (!Cmp) return <span style={{ width: size, height: size, display: 'inline-block' }} />;
  return <Cmp size={size} {...rest} />;
}
