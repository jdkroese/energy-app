import type { ComponentType } from 'react';
import { icons, type LucideProps } from 'lucide-react';

type Props = LucideProps & {
  /** lucide icon name in kebab-case, e.g. "battery-charging" */
  name: string;
};

/**
 * Lucide renamed a batch of icons (alert-triangle → triangle-alert, home → house,
 * bar-chart-3 → chart-column, …) and an unknown name renders nothing at all, so the
 * old spellings go silently invisible. Call sites are fixed, but names also reach us
 * from persisted data — room icons and alert rows are stored strings — so alias the
 * dropped spellings too. Add an entry here whenever lucide retires a name.
 */
export const ALIASES: Record<string, string> = {
  'alert-circle': 'circle-alert',
  'alert-octagon': 'octagon-alert',
  'alert-triangle': 'triangle-alert',
  'bar-chart-2': 'chart-no-axes-column',
  'bar-chart-3': 'chart-column',
  'check-circle': 'circle-check',
  'home': 'house',
  'line-chart': 'chart-line',
  'pie-chart': 'chart-pie',
  'wash-machine': 'washing-machine',
  'x-circle': 'circle-x',
};

/** Convert kebab-case lucide name → PascalCase export key. */
function pascal(name: string): string {
  return name
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/**
 * Resolve a kebab-case name (or a retired alias) to a lucide component, or null when
 * lucide has no such icon. Exported for Icon.test.ts, which sweeps the source for icon
 * names and fails on any that don't resolve — otherwise they just render blank.
 */
export function resolveIcon(name: string): ComponentType<LucideProps> | null {
  const all = icons as Record<string, ComponentType<LucideProps>>;
  const alias = ALIASES[name];
  return all[pascal(name)] ?? (alias ? all[pascal(alias)] : undefined) ?? null;
}

/** Names already warned about, so a bad icon in a list doesn't spam the console. */
const warned = new Set<string>();

/**
 * Icon — thin wrapper over lucide-react that accepts the kebab-case names used
 * across the mockups (data-lucide). Falls back to a no-op span if unknown.
 */
export function Icon({ name, size = 18, ...rest }: Props) {
  const Cmp = resolveIcon(name);
  if (!Cmp) {
    // A blank span is invisible in review, so make the miss loud in dev. `import.meta.env`
    // isn't typed in this project's tsconfig (types: []); read DEV through a safe cast.
    // Vite statically replaces it at build time, so this drops from the production bundle.
    const isDev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
    if (isDev && !warned.has(name)) {
      warned.add(name);
      console.warn(`[Icon] unknown lucide icon "${name}" — nothing rendered. Check the kebab-case spelling, or add an alias in Icon.tsx if lucide renamed it.`);
    }
    return <span style={{ width: size, height: size, display: 'inline-block' }} />;
  }
  return <Cmp size={size} {...rest} />;
}
