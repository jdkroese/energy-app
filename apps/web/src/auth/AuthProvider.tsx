import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { auth, setUnauthorizedHandler, AUTH_UNAUTHORIZED_EVENT } from '../lib/api';
import type { AuthUser } from '../lib/types';

export type AuthStatus = 'loading' | 'authed' | 'anon';

interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  /** Re-fetch /api/auth/me and update status. Used after login/setup. */
  refresh: () => Promise<void>;
  /** POST /logout then flip to anon. */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const { user } = await auth.me();
      if (!mounted.current) return;
      setUser(user);
      setStatus('authed');
    } catch {
      if (!mounted.current) return;
      // 401 or any failure (incl. network) → treat as anonymous so we never
      // spin on the splash forever.
      setUser(null);
      setStatus('anon');
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await auth.logout();
    } catch {
      /* best-effort; flip to anon regardless */
    }
    if (!mounted.current) return;
    setUser(null);
    setStatus('anon');
  }, []);

  // Initial session probe.
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  // Global 401 → drop to anonymous (registered both as a callback and a DOM event).
  useEffect(() => {
    const flip = () => {
      if (!mounted.current) return;
      setUser(null);
      setStatus('anon');
    };
    setUnauthorizedHandler(flip);
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, flip);
    return () => {
      setUnauthorizedHandler(null);
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, flip);
    };
  }, []);

  return <AuthContext.Provider value={{ user, status, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
