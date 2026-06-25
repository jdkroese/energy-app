import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';
import type {
  ControlCommandValue,
  ControlDevice,
  ControlLever,
  ControlMode,
  ControlStatus,
} from '../lib/types';
import { Button, Switch, SegmentedControl, Slider, Badge, Eyebrow, Icon } from '../components/ui';

/* ============================================================================
 * Autopilot — the live battery-control panel.
 *
 * This commands REAL Sonnen + Tesla hardware, so the design leans hard on
 * unmistakable state (armed banner + pulse), deliberate actions (every arm,
 * kill, and manual command runs through a confirm dialog) and a visible audit
 * trail (the command log + always-on guardrails).
 * ==========================================================================*/

const POLL_MS = 5_000;

/* ---- small toast bus (local to this screen) ------------------------------ */
type Toast = { id: number; kind: 'ok' | 'err'; text: string };

/* ---- confirm dialog ------------------------------------------------------ */
interface Confirm {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
}

function Modal({
  confirm,
  busy,
  onClose,
}: {
  confirm: Confirm;
  busy: boolean;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(4,8,10,0.66)',
        backdropFilter: 'blur(3px)',
        display: 'grid',
        placeItems: 'center',
        padding: 18,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'var(--surface-1)',
          border: '1px solid var(--border-2)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-2)',
          padding: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 10 }}>
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
              background: confirm.danger ? 'var(--danger-wash)' : 'var(--battery-wash)',
              color: confirm.danger ? 'var(--danger)' : 'var(--battery)',
            }}
          >
            <Icon name={confirm.danger ? 'alert-triangle' : 'send'} size={18} />
          </span>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{confirm.title}</div>
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.5 }}>{confirm.body}</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={confirm.danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={() => void confirm.onConfirm()}
          >
            {confirm.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ---- status banner ------------------------------------------------------- */
type BannerTone = { c: string; wash: string; label: string; icon: string };

function bannerTone(s: ControlStatus): BannerTone {
  if (!s.armed || s.mode === 'off')
    return { c: 'var(--text-3)', wash: 'var(--surface-2)', label: 'DISARMED', icon: 'power-off' };
  if (s.mode === 'manual')
    return { c: 'var(--battery)', wash: 'var(--battery-wash)', label: 'MANUAL — armed', icon: 'hand' };
  return { c: 'var(--solar)', wash: 'var(--solar-wash)', label: 'AUTO — running', icon: 'sparkles' };
}

function StatusBanner({ s }: { s: ControlStatus }) {
  const t = bannerTone(s);
  const live = s.armed && s.mode !== 'off';
  return (
    <div
      style={{
        borderRadius: 'var(--radius-card)',
        border: `1px solid ${t.c}`,
        background: t.wash,
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        boxShadow: live ? `0 0 0 1px ${t.c}, 0 0 24px -6px ${t.c}` : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
        <span style={{ position: 'relative', width: 14, height: 14, flex: 'none' }}>
          <span
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              background: t.c,
              boxShadow: live ? `0 0 10px ${t.c}` : 'none',
            }}
          />
          {live && (
            <span
              style={{
                position: 'absolute',
                inset: -4,
                borderRadius: '50%',
                background: t.c,
                opacity: 0.5,
                animation: 'pwr-pulse 1.8s var(--ease-out) infinite',
              }}
            />
          )}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name={t.icon} size={18} color={t.c} />
          <span
            style={{
              fontSize: 17,
              fontWeight: 700,
              letterSpacing: '.04em',
              color: t.c,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {t.label}
          </span>
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>
          {live ? 'Power can send real commands to your batteries' : 'No commands will reach your batteries'}
        </span>
      </div>
      {s.lastError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 11px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--danger-wash)',
            color: 'var(--danger)',
            fontSize: 12.5,
          }}
        >
          <Icon name="alert-octagon" size={15} />
          <span>
            <strong>Last error:</strong> {s.lastError}
          </span>
        </div>
      )}
    </div>
  );
}

/* ---- target/current row helpers ------------------------------------------ */
function TargetRow({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '9px 0',
        borderTop: '1px solid var(--border-1)',
      }}
    >
      <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{label}</span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-1)',
          fontFamily: mono ? 'var(--font-mono)' : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

const panelCard: CSSProperties = {
  background: 'var(--surface-1)',
  border: '1px solid var(--border-1)',
  borderRadius: 'var(--radius-card)',
  padding: 16,
};

const TESLA_MODES = [
  { value: 'self_consumption', label: 'Self' },
  { value: 'autonomous', label: 'Auto' },
  { value: 'backup', label: 'Backup' },
];
const SONNEN_MODES = [
  { value: 'self_consumption', label: 'Self-use' },
  { value: 'manual', label: 'Manual' },
  { value: 'time_of_use', label: 'Time-of-use' },
];

function prettyMode(m: string): string {
  return m.replace(/_/g, ' ');
}

function fmtVal(v: string | number | boolean | null): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string') return prettyMode(v);
  return String(v);
}

/* ============================================================================
 * The screen
 * ==========================================================================*/
export function Autopilot({ wide }: { wide: boolean }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [status, setStatus] = useState<ControlStatus | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  // pending command targets (so a spinner shows on the exact control)
  const [pending, setPending] = useState<string | null>(null);

  // local draft for the reserve slider (so it doesn't jump while polling)
  const [reserveDraft, setReserveDraft] = useState<number | null>(null);

  const pushToast = useCallback((kind: 'ok' | 'err', text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  // --- poll status (~5s) ---
  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const s = await api.control.status();
        if (alive) setStatus(s);
      } catch {
        /* keep last-good; banner stays as-is */
      }
    };
    void run();
    const t = setInterval(run, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // keep the reserve draft synced to the device while idle
  useEffect(() => {
    if (status && reserveDraft === null) setReserveDraft(status.current.tesla.reservePct);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const closeConfirm = () => {
    if (!confirmBusy) setConfirm(null);
  };

  const armed = !!status?.armed && status.mode !== 'off';
  const canControl = isAdmin && armed;

  /* --- arm / mode / kill ------------------------------------------------- */
  const doArm = async (nextArmed: boolean, mode: ControlMode) => {
    setConfirmBusy(true);
    try {
      const s = await api.control.arm(nextArmed, mode);
      setStatus(s);
      setConfirm(null);
      pushToast('ok', nextArmed ? `Armed · ${mode}` : 'Disarmed — devices reverted to self-consumption');
    } catch (e) {
      pushToast('err', e instanceof ApiError ? e.message : 'Arm request failed');
    } finally {
      setConfirmBusy(false);
    }
  };

  const onToggleArm = () => {
    if (!status) return;
    if (!status.armed) {
      // arming → confirm
      setConfirm({
        title: 'Arm Autopilot?',
        body: (
          <>
            This lets Power send <strong>real commands</strong> to your Sonnen + Tesla. Guardrails
            (SoC floor, reserve min, 14 kW cap) stay enforced at all times.
          </>
        ),
        confirmLabel: 'Arm',
        onConfirm: () => doArm(true, status.mode === 'off' ? 'manual' : status.mode),
      });
    } else {
      void doArm(false, 'off');
    }
  };

  const onMode = (mode: string) => {
    if (!status) return;
    const m = mode as ControlMode;
    if (m === status.mode) return;
    if (m === 'off') {
      void doArm(false, 'off');
      return;
    }
    // switching into an active mode arms if needed
    setConfirm({
      title: m === 'auto' ? 'Hand control to Autopilot?' : 'Switch to manual control?',
      body:
        m === 'auto' ? (
          <>
            <strong>Auto</strong> lets the brain command your batteries continuously to follow the
            active scenario. Guardrails stay enforced; the kill switch reverts everything instantly.
          </>
        ) : (
          <>
            <strong>Manual</strong> arms the link so your explicit commands below reach the
            batteries. The brain won't act on its own.
          </>
        ),
      confirmLabel: m === 'auto' ? 'Go Auto' : 'Go Manual',
      onConfirm: () => doArm(true, m),
    });
  };

  const onKill = () => {
    setConfirm({
      title: 'Kill switch — disarm now?',
      body: (
        <>
          Immediately disarms Autopilot and reverts your Sonnen + Tesla to safe{' '}
          <strong>self-consumption</strong>. Use this if anything looks wrong.
        </>
      ),
      confirmLabel: 'Disarm now',
      danger: true,
      onConfirm: () => doArm(false, 'off'),
    });
  };

  /* --- manual commands --------------------------------------------------- */
  const sendCommand = async (
    key: string,
    device: ControlDevice,
    lever: ControlLever,
    value: ControlCommandValue,
    label: string,
  ) => {
    setConfirmBusy(true);
    setPending(key);
    try {
      const s = await api.control.command(device, lever, value);
      setStatus(s);
      setConfirm(null);
      // The command response carries the guardrail outcome; show the real reason
      // when a write was rejected (e.g. clamped) instead of a misleading "sent".
      const r = (s as { result?: { ok?: boolean; reason?: string } }).result;
      if (r && r.ok === false) {
        pushToast('err', r.reason ? `${label}: ${r.reason}` : `${label} was rejected`);
      } else {
        pushToast('ok', `${label} sent to your ${device === 'tesla' ? 'Tesla' : 'Sonnen'}`);
      }
    } catch (e) {
      pushToast('err', e instanceof ApiError ? e.message : `${label} failed`);
    } finally {
      setConfirmBusy(false);
      setPending(null);
    }
  };

  const confirmCommand = (
    key: string,
    device: ControlDevice,
    lever: ControlLever,
    value: ControlCommandValue,
    label: string,
  ) => {
    setConfirm({
      title: 'Send command?',
      body: (
        <>
          Send <strong>{label}</strong> to your {device === 'tesla' ? 'Tesla Powerwall' : 'Sonnen'}{' '}
          now?
        </>
      ),
      confirmLabel: 'Send now',
      onConfirm: () => sendCommand(key, device, lever, value, label),
    });
  };

  const onApplyScenario = () => {
    setConfirm({
      title: 'Apply active scenario?',
      body: (
        <>
          Push the active scenario's full strategy (reserve, modes, export rule) to both batteries
          now?
        </>
      ),
      confirmLabel: 'Apply to devices',
      onConfirm: async () => {
        setConfirmBusy(true);
        setPending('apply');
        try {
          const s = await api.control.applyScenario();
          setStatus(s);
          setConfirm(null);
          pushToast('ok', 'Active scenario applied to your batteries');
        } catch (e) {
          pushToast('err', e instanceof ApiError ? e.message : 'Apply failed');
        } finally {
          setConfirmBusy(false);
          setPending(null);
        }
      },
    });
  };

  /* --- loading / not-yet ------------------------------------------------- */
  if (!status) {
    return (
      <div style={{ ...panelCard, padding: 22, color: 'var(--text-3)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="loader" size={16} /> Connecting to control plane…
      </div>
    );
  }

  const g = status.guardrails;
  const cur = status.current;
  const reserveMin = g.teslaReserveMinPct;
  const disabledHint = !isAdmin
    ? 'View-only — admin access required'
    : !armed
      ? 'Arm Autopilot (Manual or Auto) to send commands'
      : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* live-control header — visually distinct from the shadow plan below */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--danger-wash)',
            color: 'var(--danger)',
          }}
        >
          <Icon name="radio-tower" size={18} />
        </span>
        <div style={{ flex: 1 }}>
          <Eyebrow>Live control</Eyebrow>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-.01em' }}>Autopilot — real device control</div>
        </div>
        {!isAdmin && (
          <Badge tone="neutral" icon={<Icon name="eye" size={12} />}>
            View-only
          </Badge>
        )}
      </div>

      <StatusBanner s={status} />

      {/* admin: master + manual controls; member: read-only notice */}
      {isAdmin ? (
        <>
          {/* master controls */}
          <div style={panelCard}>
            <Eyebrow>Master</Eyebrow>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 16,
                marginTop: 12,
                justifyContent: 'space-between',
              }}
            >
              {/* big arm/disarm */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                <Switch checked={status.armed} onChange={onToggleArm} />
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{status.armed ? 'Armed' : 'Disarmed'}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                    {status.armed ? 'Power can command devices' : 'Flip to let Power act'}
                  </div>
                </div>
              </label>

              {/* mode */}
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6, textAlign: 'right' }}>Mode</div>
                <SegmentedControl
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'manual', label: 'Manual' },
                    { value: 'auto', label: 'Auto' },
                  ]}
                  value={status.armed ? status.mode : 'off'}
                  onChange={onMode}
                />
              </div>
            </div>

            {/* kill switch */}
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-1)' }}>
              <Button
                variant="danger"
                block
                size="lg"
                iconLeft={<Icon name="power-off" />}
                disabled={!status.armed}
                onClick={onKill}
              >
                Kill switch — disarm &amp; revert to self-consumption
              </Button>
            </div>
          </div>

          {/* current vs target */}
          <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1fr' : '1fr', gap: 12 }}>
            <div style={panelCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Icon name="car" size={16} color="var(--ev)" />
                <span style={{ fontSize: 14, fontWeight: 600 }}>Tesla Powerwall</span>
              </div>
              <TargetRow label="Mode" value={prettyMode(String(cur.tesla.mode))} mono={false} />
              <TargetRow label="Backup reserve" value={`${cur.tesla.reservePct}%`} />
              <TargetRow label="Grid charge" value={cur.tesla.gridChargeAllowed ? 'allowed' : 'solar only'} mono={false} />
              <TargetRow label="Export rule" value={prettyMode(cur.tesla.exportRule)} mono={false} />
            </div>
            <div style={panelCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Icon name="battery-charging" size={16} color="var(--battery)" />
                <span style={{ fontSize: 14, fontWeight: 600 }}>Sonnen</span>
              </div>
              <TargetRow label="Mode" value={prettyMode(String(cur.sonnen.mode))} mono={false} />
              <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
                Sonnen is the fast actuator for self-consumption; Tesla holds the backup policy.
              </div>
            </div>
          </div>

          {/* manual controls */}
          <div style={panelCard}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <Eyebrow>Manual controls</Eyebrow>
              {disabledHint && (
                <span style={{ fontSize: 11.5, color: 'var(--grid)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="lock" size={13} /> {disabledHint}
                </span>
              )}
            </div>

            <fieldset
              disabled={!canControl}
              style={{
                border: 'none',
                padding: 0,
                margin: '12px 0 0',
                opacity: canControl ? 1 : 0.45,
                pointerEvents: canControl ? 'auto' : 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
              }}
            >
              {/* tesla reserve */}
              <div>
                <Slider
                  label="Tesla backup reserve"
                  unit="%"
                  min={reserveMin}
                  max={100}
                  value={reserveDraft ?? cur.tesla.reservePct}
                  onChange={(v) => setReserveDraft(v)}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                    Floor {reserveMin}% · device now {cur.tesla.reservePct}%
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    style={{ marginLeft: 'auto' }}
                    loading={pending === 'reserve'}
                    disabled={(reserveDraft ?? cur.tesla.reservePct) === cur.tesla.reservePct}
                    onClick={() =>
                      confirmCommand(
                        'reserve',
                        'tesla',
                        'reserve',
                        reserveDraft ?? cur.tesla.reservePct,
                        `backup reserve → ${reserveDraft ?? cur.tesla.reservePct}%`,
                      )
                    }
                  >
                    Set
                  </Button>
                </div>
              </div>

              {/* tesla mode */}
              <div>
                <div style={{ fontSize: 13, marginBottom: 7 }}>Tesla mode</div>
                <SegmentedControl
                  block
                  options={TESLA_MODES}
                  value={String(cur.tesla.mode)}
                  onChange={(v) =>
                    v !== cur.tesla.mode &&
                    confirmCommand('tesla-mode', 'tesla', 'mode', v, `Tesla mode → ${prettyMode(v)}`)
                  }
                />
              </div>

              {/* tesla grid charge */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border-1)',
                }}
              >
                <div>
                  <div style={{ fontSize: 13.5 }}>Tesla grid charging</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                    {cur.tesla.gridChargeAllowed ? 'Allowed (cheap P3 only)' : 'Solar only — never buy to store'}
                  </div>
                </div>
                <Switch
                  checked={cur.tesla.gridChargeAllowed}
                  onChange={() =>
                    confirmCommand(
                      'gridCharge',
                      'tesla',
                      'gridCharge',
                      !cur.tesla.gridChargeAllowed,
                      `grid charging → ${!cur.tesla.gridChargeAllowed ? 'allowed' : 'off'}`,
                    )
                  }
                />
              </div>

              {/* sonnen mode */}
              <div style={{ paddingTop: 12, borderTop: '1px solid var(--border-1)' }}>
                <div style={{ fontSize: 13, marginBottom: 7 }}>Sonnen mode</div>
                <SegmentedControl
                  block
                  options={SONNEN_MODES}
                  value={String(cur.sonnen.mode)}
                  onChange={(v) =>
                    v !== cur.sonnen.mode &&
                    confirmCommand('sonnen-mode', 'sonnen', 'mode', v, `Sonnen mode → ${prettyMode(v)}`)
                  }
                />
              </div>

              {/* apply scenario */}
              <div style={{ paddingTop: 12, borderTop: '1px solid var(--border-1)' }}>
                <Button
                  block
                  variant="primary"
                  iconLeft={<Icon name="zap" />}
                  loading={pending === 'apply'}
                  onClick={onApplyScenario}
                >
                  Apply active scenario to devices
                </Button>
              </div>
            </fieldset>
          </div>
        </>
      ) : (
        <div style={{ ...panelCard, display: 'flex', alignItems: 'center', gap: 11, color: 'var(--text-2)', fontSize: 13 }}>
          <Icon name="lock" size={16} color="var(--grid)" />
          <span>
            <strong style={{ color: 'var(--text-1)' }}>View-only.</strong> You can watch the live
            state and the command log, but only an admin can arm or command the batteries.
          </span>
        </div>
      )}

      {/* command log — "what the boss did" */}
      <div style={panelCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Icon name="history" size={16} color="var(--text-3)" />
          <span style={{ fontSize: 14, fontWeight: 600 }}>What the boss did</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>newest first</span>
        </div>
        {status.log.length === 0 ? (
          <div style={{ padding: '14px 0', fontSize: 12.5, color: 'var(--text-3)' }}>
            No commands yet — nothing has been sent to your batteries.
          </div>
        ) : (
          <div>
            {status.log.map((row, i) => (
              <div
                key={`${row.ts}-${i}`}
                style={{
                  display: 'flex',
                  gap: 11,
                  padding: '11px 0',
                  borderTop: '1px solid var(--border-1)',
                  alignItems: 'flex-start',
                }}
              >
                <span
                  title={row.ok ? 'ok' : 'failed'}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    flex: 'none',
                    display: 'grid',
                    placeItems: 'center',
                    marginTop: 1,
                    background: row.ok ? 'var(--solar-wash)' : 'var(--danger-wash)',
                    color: row.ok ? 'var(--solar)' : 'var(--danger)',
                  }}
                >
                  <Icon name={row.ok ? 'check' : 'x'} size={13} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-3)' }}>
                      {fmtTime(row.ts)}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {cap(row.device)} · {row.lever}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)' }}>
                      {fmtVal(row.from)} → <span style={{ color: 'var(--text-1)' }}>{fmtVal(row.to)}</span>
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.45 }}>{row.reason}</div>
                  {!row.ok && row.detail && (
                    <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 3 }}>{row.detail}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* guardrails — always on */}
      <div style={panelCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Icon name="shield-check" size={16} color="var(--solar)" />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Guardrails</span>
          <Badge tone="solar" icon={<Icon name="lock" size={11} />}>
            always enforced
          </Badge>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(4,1fr)' : '1fr 1fr', gap: 10 }}>
          <GuardTile label="SoC floor" value={`${g.socFloorPct}%`} />
          <GuardTile label="Reserve min" value={`${g.teslaReserveMinPct}%`} />
          <GuardTile label="Sonnen max" value={`${(g.sonnenMaxW / 1000).toFixed(1)} kW`} />
          <GuardTile label="Grid import cap" value={`${g.gridImportCapKw} kW`} />
        </div>
      </div>

      {/* confirm dialog */}
      {confirm && <Modal confirm={confirm} busy={confirmBusy} onClose={closeConfirm} />}

      {/* toasts */}
      <div
        style={{
          position: 'fixed',
          right: 18,
          bottom: 18,
          zIndex: 70,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '11px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: 13,
              maxWidth: 360,
              background: 'var(--surface-1)',
              border: `1px solid ${t.kind === 'ok' ? 'var(--solar)' : 'var(--danger)'}`,
              color: t.kind === 'ok' ? 'var(--solar)' : 'var(--danger)',
              boxShadow: 'var(--shadow-2)',
            }}
          >
            <Icon name={t.kind === 'ok' ? 'check-circle' : 'alert-octagon'} size={16} />
            <span style={{ color: 'var(--text-1)' }}>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GuardTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '11px 12px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, color: 'var(--text-1)', marginTop: 3 }}>
        {value}
      </div>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
