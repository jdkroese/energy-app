import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/* ============================================================================
 * HoverPanel — shared "pill expands into a detail panel" interaction, used by
 * both the TopBar weather pill and the water pill (they're the same pattern
 * twice over, so it lives once here instead of diverging).
 *
 *  - Desktop: opens on mouseenter/focus of the trigger, closes on mouseleave,
 *    Escape, or a click outside.
 *  - Mobile (no hover): tap the trigger to toggle it open/closed.
 *  - The trigger is a real <button> (keyboard-reachable, no focus trap); the
 *    panel is `role="dialog"` with an accessible label.
 *  - Anchored to the trigger's right edge by default so it opens away from the
 *    viewport's right edge (both pills live in the header's trailing cluster).
 *  - Motion is a plain CSS transition — the app's global
 *    `prefers-reduced-motion` rule (index.css) collapses it to ~0 automatically.
 * ==========================================================================*/

export function HoverPanel({
  trigger,
  triggerLabel,
  panelLabel,
  children,
  align = 'right',
  width = 300,
  triggerStyle,
}: {
  /** Content of the trigger pill (icon + headline text). */
  trigger: ReactNode;
  /** Accessible name for the trigger button. */
  triggerLabel: string;
  /** Accessible name for the panel (role="dialog"). */
  panelLabel: string;
  children: ReactNode;
  /** Which edge of the trigger the panel hangs from. Default 'right' (safe near
   *  the header's right edge, where both pills live). */
  align?: 'left' | 'right';
  width?: number;
  triggerStyle?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Move focus off the panel back to the trigger so Escape doesn't strand
      // keyboard focus inside content that's about to disappear.
      const root = rootRef.current;
      const btn = root?.querySelector('button');
      (btn as HTMLElement | null)?.focus();
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        onClick={(e) => {
          // A real mouse/touch click (detail >= 1) toggles — the only way a
          // touch device (no hover) can open/close this. A keyboard-activated
          // click (Enter/Space; detail === 0) is a no-op here because focus
          // already opened the panel above — toggling too would immediately
          // close what the keyboard user just opened.
          if (e.detail === 0) return;
          setOpen((v) => !v);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderRadius: 'var(--radius-pill)',
          background: 'var(--surface-1)',
          border: '1px solid var(--border-1)',
          fontSize: 'var(--fs-sm)',
          color: 'var(--text-2)',
          cursor: 'pointer',
          font: 'inherit',
          ...triggerStyle,
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={panelLabel}
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            [align === 'right' ? 'right' : 'left']: 0,
            width,
            maxWidth: 'min(92vw, 340px)',
            zIndex: 60,
            background: 'var(--surface-pop)',
            border: '1px solid var(--border-2)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-pop)',
            padding: 14,
            animation: 'pwrHoverPanelIn 140ms var(--ease-out)',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// Module-level <style> injection (once per bundle load) rather than per-render —
// the keyframe used by the panel's mount animation above.
if (typeof document !== 'undefined' && !document.getElementById('pwr-hover-panel-kf')) {
  const style = document.createElement('style');
  style.id = 'pwr-hover-panel-kf';
  style.textContent = `
    @keyframes pwrHoverPanelIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}
