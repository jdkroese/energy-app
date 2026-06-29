/**
 * Add-to-Home-Screen (PWA install) helpers.
 *
 * iOS has NO programmatic install — Safari requires the manual
 * Share → Add to Home Screen flow — so we detect the platform and guide the
 * user. Chromium (Android / desktop Chrome / Edge) fires `beforeinstallprompt`,
 * which we capture at startup and replay on demand from the install sheet.
 *
 * This module registers its listeners as a side effect on first import, so it
 * must be imported early (see main.tsx) to avoid missing the event.
 */

export type InstallPlatform =
  | 'standalone' // already installed / running as an installed PWA
  | 'ios-safari' // iPhone/iPad Safari → manual Add to Home Screen
  | 'ios-other' // iOS Chrome/Firefox/Edge → must use Safari
  | 'chromium-prompt' // Android/desktop Chromium with a captured install prompt
  | 'chromium-manual' // Chromium but no prompt available → browser-menu install
  | 'unsupported'; // desktop Safari/Firefox etc. — no install affordance

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Stop Chromium's mini-infobar; we present our own install affordance.
    e.preventDefault();
    deferred = e;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
  });
}

/** True when launched from the Home Screen / installed app (no browser chrome). */
export function isStandalone(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    installed ||
    nav.standalone === true ||
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  );
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ masquerades as macOS — treat a touch-capable Mac as an iPad.
  return /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** iOS, in Safari (only Safari can Add to Home Screen reliably). */
function isIosSafari(): boolean {
  if (!isIos()) return false;
  // CriOS = Chrome, FxiOS = Firefox, EdgiOS = Edge, OPiOS = Opera (all on iOS).
  return !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/i.test(navigator.userAgent);
}

/** Replay the captured Chromium install prompt. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  await deferred.prompt();
  const choice = await deferred.userChoice;
  deferred = null;
  return choice.outcome;
}

/** Classify the current environment so the UI can show the right guidance. */
export function detectInstall(): InstallPlatform {
  if (isStandalone()) return 'standalone';
  if (isIos()) return isIosSafari() ? 'ios-safari' : 'ios-other';
  if (deferred) return 'chromium-prompt';
  if (/Chrome|Chromium|Edg|SamsungBrowser/i.test(navigator.userAgent)) return 'chromium-manual';
  return 'unsupported';
}
