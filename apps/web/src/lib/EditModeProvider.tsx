/* ============================================================================
 * EditModeProvider — the header's pencil-button state (mirrors ThemeProvider's
 * shape: a small context so the toggle can live in both the desktop TopBar and
 * the mobile header without prop-drilling through every screen).
 *
 * Scoped to whatever page you turned it on for — navigating away resets it, so
 * it never silently follows you to an unrelated screen.
 * ==========================================================================*/

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

interface EditModeCtx {
  editMode: boolean;
  toggleEditMode: () => void;
}

const Ctx = createContext<EditModeCtx | null>(null);

export function EditModeProvider({ children }: { children: ReactNode }) {
  const [editMode, setEditMode] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    setEditMode(false);
  }, [pathname]);

  const value = useMemo<EditModeCtx>(() => ({ editMode, toggleEditMode: () => setEditMode((v) => !v) }), [editMode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read + control the current page's edit-mode toggle. Throws if used outside EditModeProvider. */
export function useEditMode(): EditModeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useEditMode must be used within EditModeProvider');
  return v;
}
