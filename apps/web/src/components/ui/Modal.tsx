import { useCallback, useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { usePrefersReducedMotion } from '../../lib/usePrefersReducedMotion';

/* ============================================================================
 * Modal / Overlay — the ONE shared overlay primitive (Track C).
 *
 * Replaces the 5+ ad-hoc overlay shells that had drifted apart (ConfirmDialog,
 * EditRuleOverlay, VoltageHistoryOverlay, SetupSheet, ScenesAndSchedules,
 * Autopilot's nested confirm, …). Each of those re-implemented: a fixed backdrop,
 * a fade/rise keyframe, Escape + backdrop-click close, an aria-labelled dialog,
 * and a hand-rolled z-index — with subtle differences (z-60 vs z-1000, blur
 * amounts, focus behaviour). This unifies the shell while letting callers keep
 * their own body content.
 *
 * Features:
 *  - Backdrop + dialog fade+rise built on the motion tokens (--dur / --ease-out),
 *    gated by prefers-reduced-motion (the global reduced-motion CSS gate also
 *    collapses the keyframes as a belt-and-braces).
 *  - A single z-index hierarchy: overlay 1000 / nested 1010 / toast 1020. Fixes
 *    the ScenesAndSchedules z-60 bug and Autopilot's 60/70 nesting so a nested
 *    confirm always paints above its parent overlay.
 *  - Focus trap + auto-focus of the primary/close control on open; focus is
 *    restored to the previously-focused element on close.
 *  - Escape + backdrop-click to close (guarded — pass onClose={undefined-ish} via
 *    a no-op to make it non-dismissable while busy).
 *  - role="dialog" + aria-modal + an aria-label/labelledby wired to the title.
 *  - Theme-agnostic: colours come from tokens only, so it renders in light + dark.
 *
 * Layout: centered by default; `placement="sheet"` makes it a bottom sheet on
 * mobile / right rail on desktop (the SetupSheet pattern). The shell is the same
 * primitive either way.
 * ==========================================================================*/

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';
export type ModalZLayer = 'overlay' | 'nested' | 'toast';
export type ModalTone = 'default' | 'danger' | 'solar' | 'battery' | 'grid';
export type ModalPlacement = 'center' | 'sheet';

const Z_INDEX: Record<ModalZLayer, number> = {
  overlay: 1000,
  nested: 1010,
  toast: 1020,
};

const MAX_W: Record<ModalSize, number> = {
  sm: 380,
  md: 460,
  lg: 560,
  xl: 640,
};

const TONE_WASH: Record<ModalTone, { wash: string; fg: string }> = {
  default: { wash: 'var(--surface-3)', fg: 'var(--text-2)' },
  danger: { wash: 'var(--danger-wash)', fg: 'var(--danger)' },
  solar: { wash: 'var(--solar-wash)', fg: 'var(--solar)' },
  battery: { wash: 'var(--battery-wash)', fg: 'var(--battery)' },
  grid: { wash: 'var(--grid-wash)', fg: 'var(--grid)' },
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Title in the standard header. Omit to render a header-less shell (body owns its own header). */
  title?: ReactNode;
  /** Optional sub-line under the title. */
  subtitle?: ReactNode;
  /** Optional leading icon (renders in a tinted wash keyed off `tone`). */
  icon?: string;
  children: ReactNode;
  /** Footer actions row (rendered with a divider above). */
  footer?: ReactNode;
  /** Width preset. `wide` is a back-compat alias for size="lg". */
  size?: ModalSize;
  wide?: boolean;
  /** Tints the header icon wash. */
  tone?: ModalTone;
  /** Stacking layer. Use 'nested' for a confirm opened from inside another Modal. */
  zLayer?: ModalZLayer;
  /** 'center' (default) or 'sheet' (mobile bottom sheet / desktop right rail). */
  placement?: ModalPlacement;
  /** For sheet placement: true => desktop right rail, false => mobile bottom sheet. */
  wideViewport?: boolean;
  /** When true, backdrop-click + Escape are ignored (e.g. an in-flight action). */
  dismissable?: boolean;
  /** Accessible label when no visible `title` is provided. */
  ariaLabel?: string;
}

/** Focusable selector for the focus trap. */
const FOCUSABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  size,
  wide,
  tone = 'default',
  zLayer = 'overlay',
  placement = 'center',
  wideViewport,
  dismissable = true,
  ariaLabel,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const reduce = usePrefersReducedMotion();
  const labelId = useId();

  const effSize: ModalSize = size ?? (wide ? 'lg' : 'md');
  const z = Z_INDEX[zLayer];
  const isSheet = placement === 'sheet';

  const close = useCallback(() => {
    if (dismissable) onClose();
  }, [dismissable, onClose]);

  // Escape to close + body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      // Focus trap: keep Tab within the dialog.
      if (e.key === 'Tab') {
        const root = dialogRef.current;
        if (!root) return;
        const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (n) => n.offsetParent !== null || n === document.activeElement,
        );
        if (nodes.length === 0) {
          e.preventDefault();
          root.focus();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement as HTMLElement;
        if (e.shiftKey && (active === first || active === root)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      // Restore focus to the trigger.
      prevFocus.current?.focus?.();
    };
  }, [open, close]);

  // Auto-focus the primary / close control (or the dialog itself) on open.
  useEffect(() => {
    if (!open) return;
    const root = dialogRef.current;
    if (!root) return;
    const target =
      root.querySelector<HTMLElement>('[data-autofocus]') ??
      root.querySelector<HTMLElement>('[data-confirm]') ??
      root.querySelector<HTMLElement>(FOCUSABLE) ??
      root;
    // rAF so the element exists + is laid out before focusing.
    const id = requestAnimationFrame(() => target.focus?.());
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  const fadeAnim = reduce ? undefined : 'pwrModalFade var(--dur) var(--ease-out)';
  const riseAnim = reduce ? undefined : 'pwrModalRise var(--dur) var(--ease-out)';

  const backdropStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: z,
    background: 'rgba(4,8,10,0.62)',
    backdropFilter: 'blur(3px)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: isSheet ? (wideViewport ? 'stretch' : 'flex-end') : 'center',
    padding: isSheet && !wideViewport ? 0 : 16,
    overflowY: 'auto',
    animation: fadeAnim,
  };

  const panelStyle: CSSProperties = isSheet
    ? {
        width: '100%',
        maxWidth: wideViewport ? 440 : 560,
        maxHeight: wideViewport ? '100%' : '92vh',
        overflowY: 'auto',
        background: 'var(--surface-1)',
        border: '1px solid var(--border-2)',
        borderLeft: wideViewport ? '1px solid var(--border-2)' : undefined,
        borderRadius: wideViewport ? 0 : '18px 18px 0 0',
        boxShadow: 'var(--shadow-pop, 0 -8px 40px rgba(0,0,0,0.5))',
        display: 'flex',
        flexDirection: 'column',
        animation: riseAnim,
      }
    : {
        width: '100%',
        maxWidth: MAX_W[effSize],
        maxHeight: '90vh',
        background: 'var(--surface-1)',
        border: '1px solid var(--border-2)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-pop, 0 18px 50px rgba(0,0,0,0.5))',
        display: 'flex',
        flexDirection: 'column',
        animation: riseAnim,
      };

  const toneStyle = TONE_WASH[tone];

  // Portal to document.body: a `position: fixed` backdrop rendered inline is sized
  // against the nearest TRANSFORMED ancestor, not the viewport — PageTransition's
  // enter animation used to make every screen such an ancestor, clipping tall
  // modals (header/footer out of view). Escape/focus-trap/scroll-lock are already
  // document-level, and the design tokens live on :root, so portaling is safe.
  // Nested modals portal too; their zLayer ('nested' 1010 > 'overlay' 1000) keeps
  // the stacking order now that both are siblings on <body>.
  return createPortal(
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      style={backdropStyle}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? labelId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        style={panelStyle}
      >
        {isSheet && !wideViewport && (
          <div style={{ width: 38, height: 4, borderRadius: 999, background: 'var(--border-3)', margin: '10px auto 2px', flex: 'none' }} />
        )}

        {title != null && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 11,
              padding: '15px 18px',
              borderBottom: '1px solid var(--border-1)',
              flex: 'none',
            }}
          >
            {icon && (
              <span
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  display: 'grid',
                  placeItems: 'center',
                  background: toneStyle.wash,
                  color: toneStyle.fg,
                  flex: 'none',
                }}
              >
                <Icon name={icon} size={18} />
              </span>
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div id={labelId} style={{ fontSize: 15.5, fontWeight: 600, color: 'var(--text-1)', lineHeight: 1.2 }}>
                {title}
              </div>
              {subtitle && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{subtitle}</div>}
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              style={{
                display: 'grid',
                placeItems: 'center',
                width: 32,
                height: 32,
                flex: 'none',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-2)',
                background: 'var(--surface-2)',
                color: 'var(--text-2)',
                cursor: 'pointer',
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        )}

        <div style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>{children}</div>

        {footer && (
          <div
            style={{
              display: 'flex',
              gap: 10,
              justifyContent: 'flex-end',
              alignItems: 'center',
              padding: '14px 18px',
              borderTop: '1px solid var(--border-1)',
              flex: 'none',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
