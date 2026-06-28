import { useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { AlarmStatus } from '../../lib/types';
import { Icon } from '../ui/Icon';
import { ConfirmDialog } from '../ConfirmDialog';
import { useAuth } from '../../auth/AuthProvider';

/* ============================================================================
 * Nav-level HOUSE ALARM access — a dedicated panic control pinned in the
 * navigation so it's reachable from ANY screen, not just the Speakers tab.
 *
 *  - useNavAlarm():    shared status-poll + confirm-gated trigger / stop wiring,
 *                      reused by both the desktop Rail button and the mobile FAB.
 *  - RailAlarmButton:  prominent danger button pinned at the bottom of the Rail
 *                      (icon-only when collapsed, label when expanded).
 *  - MobileAlarmFab:   a floating panic button anchored above the TabBar.
 *
 * Both reuse ConfirmDialog and api.alarm.* exactly like the Speakers screen, and
 * flip to a pulsing STOP state while the alarm is active. Admin-only writes.
 * ==========================================================================*/

/** Shared alarm state + actions. One 5 s poll mirrors the active banner cadence. */
export function useNavAlarm() {
  const { user } = useAuth();
  const canControl = user?.role === 'admin';
  const { data: alarm, refetch } = usePolling<AlarmStatus>(api.alarm.status, 5_000);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = alarm?.active ?? false;

  const trigger = async () => {
    setBusy(true);
    try {
      await api.alarm.trigger(); // server defaults: all lights, all speakers, configured volume
      refetch();
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await api.alarm.stop();
      refetch();
    } finally {
      setBusy(false);
    }
  };

  return { canControl, active, busy, confirm, setConfirm, trigger, stop };
}

/** The shared confirm dialog (same copy on desktop + mobile). */
function AlarmConfirm({ open, onConfirm, onCancel }: { open: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <ConfirmDialog
      open={open}
      title="Trigger house alarm?"
      body="Siren on all speakers + blinking lights until you stop it."
      confirmLabel="Trigger alarm"
      cancelLabel="Cancel"
      tone="danger"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

const PULSE_KEYFRAMES = `@keyframes pwrNavAlarmPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,90,90,0.55) } 50% { box-shadow: 0 0 0 6px rgba(255,90,90,0) } }`;

/* ---- Desktop Rail button (pinned bottom) --------------------------------- */

export function RailAlarmButton({ expanded }: { expanded: boolean }) {
  const { canControl, active, busy, confirm, setConfirm, trigger, stop } = useNavAlarm();
  if (!canControl) return null;

  const label = active ? 'STOP ALARM' : 'ALARM';
  const onClick = () => {
    if (active) void stop();
    else setConfirm(true);
  };

  return (
    <>
      <style>{PULSE_KEYFRAMES}</style>
      <button
        type="button"
        disabled={busy}
        onClick={onClick}
        title={active ? 'Stop the house alarm' : 'Trigger the house alarm'}
        aria-label={label}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 44,
          minHeight: 44,
          border: '1px solid var(--danger)',
          background: active ? 'var(--danger)' : 'var(--danger-wash, rgba(255,90,90,0.12))',
          color: active ? '#fff' : 'var(--danger)',
          cursor: busy ? 'default' : 'pointer',
          borderRadius: 'var(--radius-md)',
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: '0.04em',
          justifyContent: expanded ? 'flex-start' : 'center',
          gap: expanded ? 11 : 0,
          padding: expanded ? '0 12px' : '0',
          opacity: busy ? 0.7 : 1,
          animation: active ? 'pwrNavAlarmPulse 1s ease-in-out infinite' : 'none',
        }}
      >
        <Icon name="siren" size={18} />
        {expanded && <span>{label}</span>}
      </button>
      <AlarmConfirm open={confirm} onConfirm={() => void trigger()} onCancel={() => setConfirm(false)} />
    </>
  );
}

/* ---- Mobile floating action button (anchored above the TabBar) ------------ */

export function MobileAlarmFab() {
  const { canControl, active, busy, confirm, setConfirm, trigger, stop } = useNavAlarm();
  if (!canControl) return null;

  const onClick = () => {
    if (active) void stop();
    else setConfirm(true);
  };

  return (
    <>
      <style>{PULSE_KEYFRAMES}</style>
      <button
        type="button"
        disabled={busy}
        onClick={onClick}
        aria-label={active ? 'Stop the house alarm' : 'Trigger the house alarm'}
        style={{
          position: 'fixed',
          right: 16,
          // Sit clear of the TabBar (~64px + safe area).
          bottom: 'calc(74px + env(safe-area-inset-bottom))',
          zIndex: 950,
          width: 56,
          height: 56,
          borderRadius: '50%',
          border: '1px solid var(--danger)',
          background: 'var(--danger)',
          color: '#fff',
          display: 'grid',
          placeItems: 'center',
          cursor: busy ? 'default' : 'pointer',
          boxShadow: '0 8px 22px rgba(0,0,0,0.4)',
          opacity: busy ? 0.7 : 1,
          animation: active ? 'pwrNavAlarmPulse 1s ease-in-out infinite' : 'none',
        }}
      >
        <Icon name={active ? 'square' : 'siren'} size={24} color="#fff" />
      </button>
      <AlarmConfirm open={confirm} onConfirm={() => void trigger()} onCancel={() => setConfirm(false)} />
    </>
  );
}
