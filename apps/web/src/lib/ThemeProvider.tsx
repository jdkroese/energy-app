/* ============================================================================
 * ThemeProvider — React context over the theme store (lib/theme.ts).
 *
 * Exposes { theme, resolved, setTheme }. Mount once near the app root; it keeps
 * <html data-theme> in sync and, while `system` is selected, reacts to live OS
 * colour-scheme changes. The inline bootstrap in index.html has already applied
 * the correct theme before this mounts, so there is no flash on load.
 * ==========================================================================*/

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  type Theme,
  type ResolvedTheme,
  getStoredTheme,
  resolveTheme,
  setStoredTheme,
  applyResolvedTheme,
  watchSystemTheme,
} from './theme';

interface ThemeCtx {
  /** the user's choice: dark | light | system */
  theme: Theme;
  /** the concrete theme currently painting: dark | light */
  resolved: ResolvedTheme;
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(theme));
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    setResolved(setStoredTheme(t));
  }, []);

  // Ensure <html> matches React's view on mount (bootstrap already ran, but this
  // covers the persisted-state path and keeps the .dark class authoritative).
  useEffect(() => {
    applyResolvedTheme(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While in `system`, follow live OS changes.
  useEffect(() => {
    return watchSystemTheme((sys) => {
      if (themeRef.current !== 'system') return;
      setResolved(sys);
      applyResolvedTheme(sys);
    });
  }, []);

  const value = useMemo<ThemeCtx>(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read + control the theme. Throws if used outside ThemeProvider. */
export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme must be used within ThemeProvider');
  return v;
}
