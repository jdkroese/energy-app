import { useEffect, useRef } from 'react';
import { Button, Icon } from './ui';

/* ============================================================================
 * ConfirmDialog — a minimal, accessible confirm modal in the Power style. Used
 * for safety-critical actions (locks, sirens, garage/gate opens) where the owner
 * decision requires a confirm tap before firing. Centered overlay on both
 * desktop and mobile; Escape / backdrop click cancels; focus moves to the
 * confirm button on open.
 * ==========================================================================*/

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' tints the confirm button red (locks/sirens); default solar. */
  tone?: 'danger' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'danger', onConfirm, onCancel,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLButtonElement>('[data-confirm]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center',
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', padding: 16,
      }}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 380, background: 'var(--surface-1)', border: '1px solid var(--border-2)',
          borderRadius: 'var(--radius-lg)', padding: 20, boxShadow: '0 18px 50px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--danger-wash, rgba(255,90,90,0.12))', color: 'var(--danger)', flex: 'none' }}>
            <Icon name="shield-alert" size={18} />
          </span>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>{title}</div>
        </div>
        {body && <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>{body}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <Button variant="ghost" size="sm" onClick={onCancel}>{cancelLabel}</Button>
          <Button data-confirm variant={tone === 'danger' ? 'danger' : 'primary'} size="sm" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
