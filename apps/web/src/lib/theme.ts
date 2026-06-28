/* ============================================================================
 * Theme — Dark / Light / System.
 *
 * The whole UI is token-driven (Power design tokens in index.css). A theme is
 * just a value on <html data-theme="…">: `:root` holds the dark palette and
 * `:root[data-theme="light"]` overrides every colour token for light. So
 * switching themes is a single attribute write — everything cascades.
 *
 * `system` resolves to the OS preference (prefers-color-scheme) and tracks live
 * OS changes while selected. A tiny inline bootstrap in index.html applies the
 * resolved theme before React mounts, so there's no dark→light flash (FOUC).
 *
 * Keep this framework-light: a plain store + a thin React context on top.
 * ==========================================================================*/

export type Theme = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_KEY = 'power.theme';
const DEFAULT: Theme = 'dark';

/** theme-color <meta> values per resolved theme (PWA / mobile status bar). */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  dark: '#06090B',
  light: '#FAFBFC',
};

function isTheme(v: unknown): v is Theme {
  return v === 'dark' || v === 'light' || v === 'system';
}

/** Read the stored preference (defaults to dark). */
export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isTheme(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

/** Current OS preference. */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Collapse a Theme to the concrete dark|light that paints. */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return theme;
}

/** Write the resolved theme to <html> (+ keep the .dark class & theme-color in sync). */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.dataset.theme = resolved;
  html.classList.toggle('dark', resolved === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[resolved]);
}

/** Persist + apply a theme choice. Returns the resolved theme that was applied. */
export function setStoredTheme(theme: Theme): ResolvedTheme {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  const resolved = resolveTheme(theme);
  applyResolvedTheme(resolved);
  return resolved;
}

/**
 * Subscribe to OS colour-scheme changes. Only meaningful while the chosen theme
 * is `system`; the caller passes a getter so we always read the live choice.
 * Returns an unsubscribe fn.
 */
export function watchSystemTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => onChange(mq.matches ? 'dark' : 'light');
  // addEventListener('change') is the modern API; older Safari uses addListener.
  if (mq.addEventListener) mq.addEventListener('change', handler);
  else mq.addListener(handler);
  return () => {
    if (mq.removeEventListener) mq.removeEventListener('change', handler);
    else mq.removeListener(handler);
  };
}
