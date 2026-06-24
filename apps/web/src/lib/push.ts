/**
 * Web Push enablement. iOS reality: push only works inside the *installed* PWA
 * (Add to Home Screen) on iOS 16.4+. We surface that as a precise status so the
 * Settings/Alerts UI can guide the user instead of silently failing.
 */
import { api } from './api';

export type PushStatus =
  | 'unsupported' // browser lacks Push / Notification / SW
  | 'needs-install' // iOS Safari, not yet installed as a PWA
  | 'default' // supported, permission not yet requested
  | 'granted' // permission granted (subscribed)
  | 'denied'; // permission denied by the user

/** VAPID keys are base64url; the browser wants a Uint8Array. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Explicit ArrayBuffer backing so the result satisfies BufferSource (not SharedArrayBuffer).
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** True when the browser exposes the Push + Notification + SW trio. */
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Detect iOS standalone (installed PWA) vs. in-browser. */
function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function isStandalone(): boolean {
  // iOS exposes navigator.standalone; others use the display-mode media query.
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
  );
}

/** Current push status without prompting the user. */
export function getPushStatus(): PushStatus {
  if (!pushSupported()) {
    // On iOS the trio only appears inside the installed PWA — guide to install.
    if (isIos() && !isStandalone()) return 'needs-install';
    return 'unsupported';
  }
  if (isIos() && !isStandalone()) return 'needs-install';
  const perm = Notification.permission;
  if (perm === 'granted') return 'granted';
  if (perm === 'denied') return 'denied';
  return 'default';
}

/**
 * Request permission, subscribe via the SW push manager, and POST the
 * subscription to the backend. Returns the resulting status.
 */
export async function enablePush(): Promise<PushStatus> {
  if (!pushSupported()) return getPushStatus();
  if (isIos() && !isStandalone()) return 'needs-install';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'default';

  const reg = await navigator.serviceWorker.ready;

  // Reuse an existing subscription if present; otherwise create a fresh one.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api.vapidPublic();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  await api.pushSubscribe(sub.toJSON());
  return 'granted';
}
