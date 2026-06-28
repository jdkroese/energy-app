import { useEffect } from 'react';
import { Button, Modal } from './ui';

/* ============================================================================
 * ConfirmDialog — a minimal, accessible confirm modal in the Power style. Used
 * for safety-critical actions (locks, sirens, garage/gate opens) where the owner
 * decision requires a confirm tap before firing. Built on the shared <Modal>
 * primitive (Track C): centered on both viewports, Escape / backdrop cancels,
 * focus moves to the confirm button on open, single z-index hierarchy.
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
  /** Stack above a parent overlay when opened from inside one. */
  zLayer?: 'overlay' | 'nested';
}

export function ConfirmDialog({
  open, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'danger', onConfirm, onCancel, zLayer = 'overlay',
}: ConfirmDialogProps) {
  // Enter = confirm (the Modal already wires Escape → onClose/cancel).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm]);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      icon="shield-alert"
      tone={tone === 'danger' ? 'danger' : 'default'}
      size="sm"
      zLayer={zLayer}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>{cancelLabel}</Button>
          <Button data-confirm variant={tone === 'danger' ? 'danger' : 'primary'} size="sm" onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {body && <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5, padding: '16px 18px' }}>{body}</div>}
    </Modal>
  );
}
