import { useState, type ReactNode } from 'react';
import { usePrefersReducedMotion } from '../../lib/usePrefersReducedMotion';

/**
 * PageTransition — one shared route-render wrapper (Track D · Motion I).
 *
 * Wraps the routed screen content so that on navigation between top-level
 * screens the new body animates in with a short fade + small rise instead of
 * hard-snapping. Applied once at the content boundary inside AppShell, so EVERY
 * screen inherits it from a single place. Only the body is wrapped — the
 * persistent shell (Rail / TabBar / TopBar / ScreenHeader chrome) stays steady.
 *
 * Keying: the caller passes the route key (`useLocation().pathname`) as the
 * React `key`, so the element fully re-mounts on navigation and the CSS
 * animation re-triggers each time. Because the wrapper lives INSIDE the
 * persistent scroll container, animating translateY does not move the scroll
 * position and there is no layout shift (the animation is transform/opacity
 * only — both compositor-friendly, neither participates in layout).
 *
 * IMPORTANT — the animation is DROPPED once it completes. Fill-mode `both`
 * retains an (identity) transform forever, and a transformed ancestor becomes
 * the containing block for every `position: fixed` descendant — which used to
 * shrink/offset modal backdrops, toasts and sticky overlays rendered inside
 * screens (the Kitchen Preferences modal clipped its header/footer). Clearing
 * the animation on `animationend` returns the computed transform to 'none' so
 * fixed-position descendants anchor to the real viewport again.
 *
 * Reduced motion: when usePrefersReducedMotion() is true we render the content
 * with NO animation and NO extra wrapper styling — an instant swap. (The global
 * reduced-motion CSS gate in index.css would already collapse the keyframe to a
 * near-instant pass via !important; skipping it in JS is belt-and-suspenders so
 * there is provably zero motion.)
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const reduce = usePrefersReducedMotion();
  // Re-mount per route (keyed by pathname in AppShell) resets this to false, so
  // every navigation still animates; it flips true when the enter run finishes.
  const [entered, setEntered] = useState(false);

  // Reduced motion: hand the content straight through, untouched.
  if (reduce) return <>{children}</>;

  return (
    <div
      className="pwr-page-enter"
      // The wrapper is display:contents-free (a plain block) so it never alters
      // the screens' own layout/width; screens already size themselves to the
      // scroll container's padding box.
      style={entered ? undefined : { animation: 'pwrPageEnter var(--dur) var(--ease-out) both' }}
      onAnimationEnd={(e) => {
        // Only our own enter animation — children's animation events bubble here too.
        if (e.target === e.currentTarget && e.animationName === 'pwrPageEnter') setEntered(true);
      }}
    >
      {children}
    </div>
  );
}
