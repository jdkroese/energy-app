import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { useAuth } from '../auth/AuthProvider';
import type {
  ControlCommandValue,
  ControlDevice,
  ControlLever,
  ControlLogEntry,
  ControlMode,
  ControlStatus,
  LiveResponse,
} from '../lib/types';
import { Button, Switch, SegmentedControl, Slider, Badge, Eyebrow, Icon, Modal, ScreenHeader } from '../components/ui';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Autopilot — the battery-control screen, organised into three tabs:
 *   Status   · live device truth + always-on guardrails
 *   Events   · the command audit log ("what the boss did")
 *   Settings · arm/mode/kill + manual levers (admin only)
 *
 * The forward-looking 24 h plan + forecast KPIs that used to lead here now live on
 * the Live dashboard (components/energy/PlanSummary). Summary is owned by the
 * Automations host (AutomationsSummary), not this component.
 *
 * It commands REAL Sonnen + Tesla hardware, so the armed state and kill switch
 * are pinned in the header on every tab, and every write runs through a confirm
 * dialog with always-enforced guardrails.
 *
 * Embeddable: when hosted inside the Automations screen (`embedded`), the host
 * renders the page header + tab strip and passes the active `tab` in as a prop,
 * so this component skips its own header/tab bar and drops the page padding.
 * ==========================================================================*/

const POLL_MS = 5_000;
export type TabKey = 'status' | 'events' | 'settings';

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

function ConfirmModal({ confirm, busy, onClose }: { confirm: Confirm; busy: boolean; onClose: () => void }) {
  // Confirm dialogs here open from inside other Autopilot overlays/flows; use the
  // 'nested' z-layer so they always paint above. Non-dismissable while busy.
  return (
    <Modal
      open
      onClose={onClose}
      dismissable={!busy}
      zLayer="nested"
      size="md"
      tone={confirm.danger ? 'danger' : 'battery'}
      icon={confirm.danger ? 'alert-triangle' : 'send'}
      title={confirm.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button data-confirm variant={confirm.danger ? 'danger' : 'primary'} loading={busy} onClick={() => void confirm.onConfirm()}>{confirm.confirmLabel}</Button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.5, padding: '16px 18px' }}>{confirm.body}</div>
    </Modal>
  );
}

/* ---- armed-state tone ---------------------------------------------------- */
function armTone(s: ControlStatus | null): { c: string; wash: string; label: string; icon: string; live: boolean } {
  if (!s || !s.armed || s.mode === 'off') return { c: 'var(--text-3)', wash: 'var(--surface-2)', label: 'OFF', icon: 'power-off', live: false };
  if (s.mode === 'manual') return { c: 'var(--battery)', wash: 'var(--battery-wash)', label: 'MANUAL', icon: 'hand', live: true };
  return { c: 'var(--solar)', wash: 'var(--solar-wash)', label: 'AUTO', icon: 'sparkles', live: true };
}

function TargetRow({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderTop: '1px solid var(--border-1)' }}>
      <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', fontFamily: mono ? 'var(--font-mono)' : undefined }}>{value}</span>
    </div>
  );
}

const panelCard: CSSProperties = { background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-card)', padding: 16 };

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

function prettyMode(m: string | null | undefined): string {
  // Tolerate missing values: when a device is offline the control status omits
  // mode/exportRule, and the Status panel formats them directly. Guard so an
  // undefined field renders as a dash instead of throwing and blanking the screen.
  if (m === null || m === undefined) return '—';
  return String(m).replace(/_/g, ' ');
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
export function Autopilot({ ctx, tab: tabProp, embedded = false }: { ctx: ShellContext; tab?: TabKey; embedded?: boolean }) {
  const wide = ctx.desktop;
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // When embedded, the host owns tab state and passes it in; otherwise we keep
  // our own internal state and render our own tab strip.
  const [tabState, setTabState] = useState<TabKey>('status');
  const tab = tabProp ?? tabState;
  const [status, setStatus] = useState<ControlStatus | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [reserveDraft, setReserveDraft] = useState<number | null>(null);
  const [logFilter, setLogFilter] = useState<'changes' | 'all' | 'errors'>('changes');
  const toastId = useRef(0);

  // Live snapshot — for the relocated "Backup · Tesla only" card on the Status tab
  // (backup energy + autonomy hours live on /api/live, not on ControlStatus).
  const { data: live } = usePolling<LiveResponse>(api.live, 10_000);

  const pushToast = useCallback((kind: 'ok' | 'err', text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  // poll control status (~5s)
  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const s = await api.control.status();
        if (alive) setStatus(s);
      } catch {
        /* keep last-good */
      }
    };
    void run();
    const t = setInterval(run, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

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
      setConfirm({
        title: 'Arm Autopilot?',
        body: (<>This lets Power send <strong>real commands</strong> to your Sonnen + Tesla. Guardrails (SoC floor, reserve min, 14 kW cap) stay enforced at all times.</>),
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
    setConfirm({
      title: m === 'auto' ? 'Hand control to Autopilot?' : 'Switch to manual control?',
      body:
        m === 'auto' ? (
          <><strong>Auto</strong> lets the brain command your batteries continuously to follow the active scenario. Guardrails stay enforced; the kill switch reverts everything instantly.</>
        ) : (
          <><strong>Manual</strong> arms the link so your explicit commands reach the batteries. The brain won't act on its own.</>
        ),
      confirmLabel: m === 'auto' ? 'Go Auto' : 'Go Manual',
      onConfirm: () => doArm(true, m),
    });
  };

  const onKill = () => {
    setConfirm({
      title: 'Kill switch — disarm now?',
      body: (<>Immediately disarms Autopilot and reverts your Sonnen + Tesla to safe <strong>self-consumption</strong>. Use this if anything looks wrong.</>),
      confirmLabel: 'Disarm now',
      danger: true,
      onConfirm: () => doArm(false, 'off'),
    });
  };

  /* --- manual commands --------------------------------------------------- */
  const sendCommand = async (key: string, device: ControlDevice, lever: ControlLever, value: ControlCommandValue, label: string) => {
    setConfirmBusy(true);
    setPending(key);
    try {
      const s = await api.control.command(device, lever, value);
      setStatus(s);
      setConfirm(null);
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

  const confirmCommand = (key: string, device: ControlDevice, lever: ControlLever, value: ControlCommandValue, label: string) => {
    setConfirm({
      title: 'Send command?',
      body: (<>Send <strong>{label}</strong> to your {device === 'tesla' ? 'Tesla Powerwall' : 'Sonnen'} now?</>),
      confirmLabel: 'Send now',
      onConfirm: () => sendCommand(key, device, lever, value, label),
    });
  };

  const onApplyScenario = () => {
    setConfirm({
      title: 'Apply active scenario?',
      body: (<>Push the active scenario's full strategy (reserve, modes, export rule) to both batteries now?</>),
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

  // Armed-state tone — drives the slim armed strip pinned atop every tab.
  const at = armTone(status);

  /* ---- connecting placeholder ------------------------------------------ */
  const connecting = (
    <div style={{ ...panelCard, padding: 22, color: 'var(--text-3)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
      <Icon name="loader" size={16} /> Connecting to control plane…
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: embedded ? undefined : 1100, margin: embedded ? undefined : '0 auto', width: '100%', padding: embedded ? 0 : wide ? 0 : '8px 14px 22px' }}>
      {/* mobile header — host renders the page header when embedded */}
      {!wide && !embedded && <ScreenHeader eyebrow="Live control" title="Autopilot" padding="4px 2px 0" />}

      {/* tab bar — host renders the tab strip when embedded */}
      {!embedded && (
        <SegmentedControl
          block
          options={[
            { value: 'status', label: 'Status' },
            { value: 'events', label: 'Events' },
            { value: 'settings', label: 'Settings' },
          ]}
          value={tab}
          onChange={(v) => setTabState(v as TabKey)}
        />
      )}

      {/* armed strip — slim status row pinned atop every tab */}
      <div style={{ borderRadius: 'var(--radius-card)', border: '1px solid var(--border-1)', background: 'var(--surface-1)', padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <span style={{ position: 'relative', width: 11, height: 11, flex: 'none' }}>
              <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: at.c, boxShadow: at.live ? `0 0 9px ${at.c}` : 'none' }} />
              {at.live && <span style={{ position: 'absolute', inset: -4, borderRadius: '50%', background: at.c, opacity: 0.5, animation: 'pwr-pulse 1.8s var(--ease-out) infinite' }} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 14, letterSpacing: '.03em', color: at.c }}>{!status ? 'CONNECTING…' : at.label === 'OFF' ? 'DISARMED' : `${at.label} — running`}</span>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 1 }}>Real device control · {armed ? 'commanding your batteries live' : 'no commands reaching your batteries'}</div>
            </div>
            {isAdmin && armed && <Button size="sm" variant="danger" iconLeft={<Icon name="power-off" />} onClick={onKill}>Disarm</Button>}
          </div>
        </div>

      {/* ============================== STATUS ============================= */}
      {tab === 'status' && (status ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1fr' : '1fr', gap: 12 }}>
            <div style={panelCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Icon name="car" size={16} color="var(--ev)" />
                <span style={{ fontSize: 14, fontWeight: 600 }}>Tesla Powerwall</span>
              </div>
              <TargetRow label="Mode" value={prettyMode(String(status.current.tesla.mode))} mono={false} />
              <TargetRow label="Backup reserve" value={`${status.current.tesla.reservePct}%`} />
              <TargetRow label="Grid charge" value={status.current.tesla.gridChargeAllowed ? 'allowed' : 'solar only'} mono={false} />
              <TargetRow label="Export rule" value={prettyMode(status.current.tesla.exportRule)} mono={false} />
            </div>
            <div style={panelCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Icon name="battery-charging" size={16} color="var(--battery)" />
                <span style={{ fontSize: 14, fontWeight: 600 }}>Sonnen</span>
              </div>
              <TargetRow label="Mode" value={prettyMode(String(status.current.sonnen.mode))} mono={false} />
              <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>Sonnen is the fast actuator for self-consumption; Tesla holds the backup policy.</div>
            </div>
          </div>

          <div style={panelCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Icon name="shield-check" size={16} color="var(--solar)" />
              <span style={{ fontSize: 14, fontWeight: 600 }}>Guardrails</span>
              <Badge tone="solar" icon={<Icon name="lock" size={11} />}>always enforced</Badge>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(4,1fr)' : '1fr 1fr', gap: 10 }}>
              <GuardTile label="SoC floor" value={`${status.guardrails.socFloorPct}%`} />
              <GuardTile label="Reserve min" value={`${status.guardrails.teslaReserveMinPct}%`} />
              <GuardTile label="Sonnen max" value={`${(status.guardrails.sonnenMaxW / 1000).toFixed(1)} kW`} />
              <GuardTile label="Grid import cap" value={`${status.guardrails.gridImportCapKw} kW`} />
            </div>
          </div>

          {/* backup · Tesla only — relocated from the Live page (data on /api/live) */}
          {live && (
            <div style={{ ...panelCard, borderColor: 'var(--battery)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Eyebrow>Backup · Tesla only</Eyebrow>
                <Icon name="shield-check" size={18} color="var(--battery)" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 600, color: 'var(--battery)' }}>{live.tesla.backupKwh}</span>
                <span style={{ fontSize: 13, color: 'var(--text-2)' }}>kWh · ≈ {live.tesla.backupHours} h autonomy</span>
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>Sonnen excluded — no backup module installed</div>
            </div>
          )}
        </>
      ) : connecting)}

      {/* ============================== EVENTS ============================ */}
      {tab === 'events' && (status ? (
        <div style={panelCard}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Icon name="history" size={16} color="var(--text-3)" />
            <span style={{ fontSize: 14, fontWeight: 600 }}>Command log</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {(['changes', 'all', 'errors'] as const).map((f) => (
                <button key={f} onClick={() => setLogFilter(f)} style={{ fontSize: 11.5, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--border-2)', cursor: 'pointer', textTransform: 'capitalize', background: logFilter === f ? 'var(--surface-3)' : 'transparent', color: logFilter === f ? 'var(--text-1)' : 'var(--text-3)' }}>{f}</button>
              ))}
            </div>
          </div>
          {(() => {
            // A no-op re-asserts the value already in place ("reserve 80 → 80, unchanged"). These
            // fire every steady-state tick and are pure clutter, so the default "Changes" view
            // hides them; "All" reveals the latest per-lever check, "Errors" only rejections.
            const isNoop = (r: ControlLogEntry) => r.ok && String(r.from) === String(r.to);
            const hiddenNoops = status.log.filter(isNoop).length;
            const rows = status.log.filter((r) =>
              logFilter === 'all' ? true : logFilter === 'errors' ? !r.ok : !isNoop(r),
            );
            if (rows.length === 0) {
              const empty =
                logFilter === 'errors'
                  ? 'No rejected commands — clean run.'
                  : logFilter === 'changes' && hiddenNoops > 0
                    ? 'No changes yet — Autopilot is holding steady (every command so far was a no-op). Switch to All to see the latest per-lever check.'
                    : 'No commands yet — nothing has been sent to your batteries.';
              return <div style={{ padding: '14px 0', fontSize: 12.5, color: 'var(--text-3)' }}>{empty}</div>;
            }
            return (
              <>
                {rows.map((row, i) => (
                  <div key={`${row.ts}-${i}`} style={{ display: 'flex', gap: 11, padding: '11px 0', borderTop: '1px solid var(--border-1)', alignItems: 'flex-start' }}>
                    <span title={row.ok ? 'ok' : 'failed'} style={{ width: 22, height: 22, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', marginTop: 1, background: row.ok ? 'var(--solar-wash)' : 'var(--danger-wash)', color: row.ok ? 'var(--solar)' : 'var(--danger)' }}>
                      <Icon name={row.ok ? 'check' : 'x'} size={13} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-3)' }}>{fmtTime(row.ts)}</span>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{cap(row.device)} · {row.lever}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)' }}>{fmtVal(row.from)} → <span style={{ color: 'var(--text-1)' }}>{fmtVal(row.to)}</span></span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.45 }}>{row.reason}</div>
                      {!row.ok && row.detail && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 3 }}>{row.detail}</div>}
                    </div>
                  </div>
                ))}
                {logFilter === 'changes' && hiddenNoops > 0 && (
                  <div style={{ paddingTop: 11, marginTop: 4, borderTop: '1px solid var(--border-1)', fontSize: 11.5, color: 'var(--text-3)' }}>
                    {hiddenNoops} steady-state no-op{hiddenNoops === 1 ? '' : 's'} hidden ·{' '}
                    <button onClick={() => setLogFilter('all')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-2)', textDecoration: 'underline', font: 'inherit' }}>show all</button>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      ) : connecting)}

      {/* ============================= SETTINGS =========================== */}
      {tab === 'settings' && (
        !isAdmin ? (
          <div style={{ ...panelCard, display: 'flex', alignItems: 'center', gap: 11, color: 'var(--text-2)', fontSize: 13 }}>
            <Icon name="lock" size={16} color="var(--grid)" />
            <span><strong style={{ color: 'var(--text-1)' }}>View-only.</strong> You can watch the plan, live state, and the command log, but only an admin can arm or command the batteries.</span>
          </div>
        ) : !status ? connecting : (
          <>
            {/* master */}
            <div style={panelCard}>
              <Eyebrow>Master</Eyebrow>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, marginTop: 12, justifyContent: 'space-between' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                  <Switch checked={status.armed} onChange={onToggleArm} />
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{status.armed ? 'Armed' : 'Disarmed'}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{status.armed ? 'Power can command devices' : 'Flip to let Power act'}</div>
                  </div>
                </label>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6, textAlign: 'right' }}>Mode</div>
                  <SegmentedControl options={[{ value: 'off', label: 'Off' }, { value: 'manual', label: 'Manual' }, { value: 'auto', label: 'Auto' }]} value={status.armed ? status.mode : 'off'} onChange={onMode} />
                </div>
              </div>
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-1)' }}>
                <Button variant="danger" block size="lg" iconLeft={<Icon name="power-off" />} disabled={!status.armed} onClick={onKill}>Kill switch — disarm &amp; revert to self-consumption</Button>
              </div>
            </div>

            {/* manual controls */}
            <div style={panelCard}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <Eyebrow>Manual controls</Eyebrow>
                {!armed && <span style={{ fontSize: 11.5, color: 'var(--grid)', display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="lock" size={13} /> Arm (Manual or Auto) to send commands</span>}
              </div>
              <fieldset disabled={!canControl} style={{ border: 'none', padding: 0, margin: '12px 0 0', opacity: canControl ? 1 : 0.45, pointerEvents: canControl ? 'auto' : 'none', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <Slider label="Tesla backup reserve" unit="%" min={status.guardrails.teslaReserveMinPct} max={100} value={reserveDraft ?? status.current.tesla.reservePct} onChange={(v) => setReserveDraft(v)} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Floor {status.guardrails.teslaReserveMinPct}% · device now {status.current.tesla.reservePct}%</span>
                    <Button size="sm" variant="secondary" style={{ marginLeft: 'auto' }} loading={pending === 'reserve'} disabled={(reserveDraft ?? status.current.tesla.reservePct) === status.current.tesla.reservePct} onClick={() => confirmCommand('reserve', 'tesla', 'reserve', reserveDraft ?? status.current.tesla.reservePct, `backup reserve → ${reserveDraft ?? status.current.tesla.reservePct}%`)}>Set</Button>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 13, marginBottom: 7 }}>Tesla mode</div>
                  <SegmentedControl block options={TESLA_MODES} value={String(status.current.tesla.mode)} onChange={(v) => v !== status.current.tesla.mode && confirmCommand('tesla-mode', 'tesla', 'mode', v, `Tesla mode → ${prettyMode(v)}`)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 12, borderTop: '1px solid var(--border-1)' }}>
                  <div>
                    <div style={{ fontSize: 13.5 }}>Tesla grid charging</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{status.current.tesla.gridChargeAllowed ? 'Allowed (cheap P3 only)' : 'Solar only — never buy to store'}</div>
                  </div>
                  <Switch checked={status.current.tesla.gridChargeAllowed} onChange={() => confirmCommand('gridCharge', 'tesla', 'gridCharge', !status.current.tesla.gridChargeAllowed, `grid charging → ${!status.current.tesla.gridChargeAllowed ? 'allowed' : 'off'}`)} />
                </div>
                <div style={{ paddingTop: 12, borderTop: '1px solid var(--border-1)' }}>
                  <div style={{ fontSize: 13, marginBottom: 7 }}>Sonnen mode</div>
                  <SegmentedControl block options={SONNEN_MODES} value={String(status.current.sonnen.mode)} onChange={(v) => v !== status.current.sonnen.mode && confirmCommand('sonnen-mode', 'sonnen', 'mode', v, `Sonnen mode → ${prettyMode(v)}`)} />
                </div>
                <div style={{ paddingTop: 12, borderTop: '1px solid var(--border-1)' }}>
                  <Button block variant="primary" iconLeft={<Icon name="zap" />} loading={pending === 'apply'} onClick={onApplyScenario}>Apply active scenario to devices</Button>
                </div>
              </fieldset>
            </div>
          </>
        )
      )}

      {/* confirm dialog */}
      {confirm && <ConfirmModal confirm={confirm} busy={confirmBusy} onClose={closeConfirm} />}

      {/* toasts — toast z-layer (above overlays/nested confirms) */}
      <div style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 1020, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
        {toasts.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', borderRadius: 'var(--radius-md)', fontSize: 13, maxWidth: 360, background: 'var(--surface-1)', border: `1px solid ${t.kind === 'ok' ? 'var(--solar)' : 'var(--danger)'}`, color: t.kind === 'ok' ? 'var(--solar)' : 'var(--danger)', boxShadow: 'var(--shadow-2)' }}>
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
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, color: 'var(--text-1)', marginTop: 3 }}>{value}</div>
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
