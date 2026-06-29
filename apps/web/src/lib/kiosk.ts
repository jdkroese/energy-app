import { useEffect, useState } from 'react';

/* ============================================================================
 * Wall-tablet (kiosk) mode — a device-local flag that swaps the whole app for
 * the big-button TabletShell. It lives in localStorage (per-device, survives
 * reloads) and is broadcast in-tab via a CustomEvent so the app reacts without
 * a hard reload; the `storage` event covers other tabs. Mirrors the RAIL_KEY
 * try/catch pattern in AppShell.tsx (localStorage can throw in private mode).
 * ==========================================================================*/

const KIOSK_KEY = 'power.kiosk.enabled';
/** In-tab broadcast so a toggle re-renders the app without reloading. */
export const KIOSK_EVENT = 'power:kiosk';

/** Whether wall-tablet mode is enabled on this device. */
export function isKioskEnabled(): boolean {
  try {
    return localStorage.getItem(KIOSK_KEY) === '1';
  } catch {
    return false;
  }
}

/** Enable/disable wall-tablet mode + broadcast so the app reacts live. */
export function setKioskEnabled(v: boolean): void {
  try {
    localStorage.setItem(KIOSK_KEY, v ? '1' : '0');
  } catch {
    /* ignore — private mode / storage disabled */
  }
  try {
    window.dispatchEvent(new CustomEvent(KIOSK_EVENT, { detail: v }));
  } catch {
    /* ignore */
  }
}

/** Reactive read of the kiosk flag — re-renders on the in-tab event + storage. */
export function useKiosk(): boolean {
  const [enabled, setEnabled] = useState<boolean>(isKioskEnabled);
  useEffect(() => {
    const sync = () => setEnabled(isKioskEnabled());
    window.addEventListener(KIOSK_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(KIOSK_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return enabled;
}
