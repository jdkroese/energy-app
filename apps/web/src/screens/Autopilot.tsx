import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_PLAN } from '../lib/mock';
import { useAuth } from '../auth/AuthProvider';
import type {
  BrainPlanResponse,
  ControlCommandValue,
  ControlDevice,
  ControlLever,
  ControlLogEntry,
  ControlMode,
  ControlStatus,
  LiveResponse,
} from '../lib/types';
import { Button, Switch, SegmentedControl, Slider, Badge, Eyebrow, Icon, Card, StatTile, Modal } from '../components/ui';
import { PlanTimeline } from '../components/energy/PlanTimeline';
import { StaleBanner } from './_shared';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Autopilot — the battery-control screen, organised into four tabs:
 *   Summary  · the plan (hero) + which systems are armed and in what mode
 *   Status   · live device truth + always-on guardrails
 *   Events   · the command audit log ("what the boss did")
 *   Settings · arm/mode/kill + manual levers (admin only)
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
export type TabKey = 'summary' | 'status' | 'events' | 'settings';

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

/* ---- compact status pill + 2×2 grid cell (Summary control block) --------- */
function StatePill({ label, tone, dot }: { label: string; tone: string; dot?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, flex: 'none', background: `color-mix(in srgb, var(--${tone}) 14%, transparent)`, color: `var(--${tone})` }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: `var(--${tone})`, boxShadow: `0 0 6px var(--${tone})` }} />}
      {label}
    </span>
  );
}

function StatusCell({ icon, name, sub, label, tone, dot }: { icon: string; name: string; sub: ReactNode; label: string; tone: string; dot?: boolean }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name={icon} size={16} color={`var(--${tone})`} />
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <StatePill label={label} tone={tone} dot={dot} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.4 }}>{sub}</div>
    </div>
  );
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
function hhmm(h: number): string {
  return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
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
  const [tabState, setTabState] = useState<TabKey>('summary');
  const tab = tabProp ?? tabState;
  const [status, setStatus] = useState<ControlStatus | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [reserveDraft, setReserveDraft] = useState<number | null>(null);
  const [logFilter, setLogFilter] = useState<'changes' | 'all' | 'errors'>('changes');
  const toastId = useRef(0);

  const { data: planData, stale: planStale, updatedAt: planAt } = usePolling<BrainPlanResponse>(api.brainPlan, 60_000);
  const plan = planData || MOCK_PLAN;

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

  /* ---- derived for Summary --------------------------------------------- */
  const at = armTone(status);
  const sysLabel = at.label === 'OFF' ? 'Off' : at.label === 'MANUAL' ? 'Manual' : 'Auto';
  const nowH = plan.now;
  const solarNow = plan.forecast.solarKw[Math.min(plan.forecast.solarKw.length - 1, Math.max(0, Math.round(nowH)))] ?? 0;
  const nextAction = plan.actions.find((a) => a.h > nowH) ?? plan.actions[0];
  const nextRel = nextAction
    ? nextAction.h > nowH
      ? `in ${Math.floor(nextAction.h - nowH)}h ${String(Math.round(((nextAction.h - nowH) % 1) * 60)).padStart(2, '0')}m`
      : 'now'
    : '';

  // Day totals for the KPI row (sum the first 24 hourly buckets).
  const sum24 = (a: number[]) => a.slice(0, 24).reduce((s, v) => s + (v || 0), 0);
  const genKwhTotal = Math.round(sum24(plan.forecast.genKwh));
  const usageKwhTotal = Math.round(sum24(plan.forecast.usageKwh));

  /* ---- connecting placeholder ------------------------------------------ */
  const connecting = (
    <div style={{ ...panelCard, padding: 22, color: 'var(--text-3)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
      <Icon name="loader" size={16} /> Connecting to control plane…
    </div>
  );

  // Summary control grid (armed state / battery autopilot / solar / next move) — rendered
  // BELOW the KPI row on the Summary tab (see the summary section).
  const controlGrid = (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      {/* cell 1 — armed state + what it means */}
      <div style={{ background: at.live ? at.wash : 'var(--surface-2)', border: `1px solid ${at.live ? at.c : 'transparent'}`, borderRadius: 12, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ position: 'relative', width: 10, height: 10, flex: 'none' }}>
            <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: at.c, boxShadow: at.live ? `0 0 8px ${at.c}` : 'none' }} />
            {at.live && <span style={{ position: 'absolute', inset: -4, borderRadius: '50%', background: at.c, opacity: 0.5, animation: 'pwr-pulse 1.8s var(--ease-out) infinite' }} />}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13.5, letterSpacing: '.03em', color: at.c, flex: 1, minWidth: 0 }}>{!status ? 'CONNECTING…' : at.label === 'OFF' ? 'DISARMED' : `${at.label} — running`}</span>
          {isAdmin && armed && <Button size="sm" variant="danger" onClick={onKill}>Disarm</Button>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.4 }}>
          {armed
            ? 'Power is sending live commands to your Sonnen + Tesla — guardrails stay enforced.'
            : 'Read-only: no commands reach your batteries. Arm it in Settings to let Power control them.'}
        </div>
      </div>

      {/* cell 2 — battery autopilot */}
      <StatusCell icon="cpu" name="Battery autopilot" sub="Sonnen + Tesla authority" label={sysLabel} tone={at.label === 'OFF' ? 'text-3' : at.label === 'MANUAL' ? 'battery' : 'solar'} dot={at.live} />

      {/* cell 3 — solar */}
      <StatusCell icon="sun" name="Solar self-consumption" sub={`cloud-adjusted · ~${solarNow.toFixed(1)} kW · ${plan.weather.cloudAvgPct}% cloud`} label={armed ? sysLabel : 'Producing'} tone="solar" dot />

      {/* cell 4 — next move */}
      {nextAction && (
        <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Icon name={nextAction.icon} size={16} color="var(--battery)" />
            <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-3)', flex: 1 }}>Next move</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--battery)', background: 'var(--surface-3)', borderRadius: 999, padding: '2px 8px' }}>{hhmm(nextAction.h)} · {nextRel}</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{nextAction.title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.4 }}>{nextAction.why}</div>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: embedded ? undefined : 1100, margin: embedded ? undefined : '0 auto', width: '100%', padding: embedded ? 0 : wide ? 0 : '8px 14px 22px' }}>
      {/* mobile header — host renders the page header when embedded */}
      {!wide && !embedded && (
        <div style={{ padding: '4px 2px 0' }}>
          <Eyebrow>Live control</Eyebrow>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '2px 0 0' }}>Autopilot</h1>
        </div>
      )}
      {planStale && <StaleBanner updatedAt={planAt} />}

      {/* tab bar — host renders the tab strip when embedded */}
      {!embedded && (
        <SegmentedControl
          block
          options={[
            { value: 'summary', label: 'Summary' },
            { value: 'status', label: 'Status' },
            { value: 'events', label: 'Events' },
            { value: 'settings', label: 'Settings' },
          ]}
          value={tab}
          onChange={(v) => setTabState(v as TabKey)}
        />
      )}

      {/* armed strip — slim status row at the top on non-summary tabs (on Summary the
          control block is rendered below the KPI row instead) */}
      {tab !== 'summary' && (
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
      )}

      {/* ============================= SUMMARY ============================= */}
      {tab === 'summary' && (
        <>
          {/* the plan — hero */}
          <Card
            title="The plan · next 24 h"
            subtitle={`sun forecast · predicted generation · battery trajectory · tariff bands — cloud-adjusted (${plan.weather.source === 'live' ? 'Open-Meteo, Jávea' : 'estimate'}), ${plan.weather.cloudAvgPct}% avg cloud`}
            icon={<Icon name="brain" />}
            actions={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Badge tone="battery" variant="soft" icon={<Icon name="graduation-cap" size={12} />}>
                  {`${plan.model.month} roof model · ${plan.model.confidencePct}% (${plan.model.days}d)`}
                </Badge>
                <Badge tone="solar" variant="soft" icon={<Icon name="radio" size={12} />}>Live plan</Badge>
              </div>
            }
          >
            <PlanTimeline
              solar={plan.forecast.solarKw}
              load={plan.forecast.loadKw}
              soc={plan.socPct}
              tariff={plan.tariff}
              sunIntensityPct={plan.forecast.sunIntensityPct}
              genKwh={plan.forecast.genKwh}
              actions={plan.actions}
              now={plan.now}
              wide={wide}
            />
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-2)', flexWrap: 'wrap', marginTop: 10 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 8, borderRadius: 2, background: 'linear-gradient(#ffe27a,#f5c518)' }} /> Sun intensity</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 14, height: 3, borderRadius: 2, background: 'var(--solar)' }} /> Solar (cloud-adjusted)</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 14, height: 3, borderRadius: 2, background: 'var(--home)' }} /> House load</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 14, height: 3, borderRadius: 2, background: 'var(--battery)' }} /> Battery SoC</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', color: 'var(--text-3)' }}><Icon name="cloud" size={13} /> {plan.weather.cloudAvgPct}% cloud</span>
            </div>
          </Card>

          {/* today's impact — 5-metric KPI row (one row desktop, 2-up mobile) */}
          <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(5,1fr)' : '1fr 1fr', gap: wide ? 12 : 10 }}>
            <Card style={wide ? undefined : { padding: 14 }}><StatTile size={wide ? 'md' : 'sm'} label="Production & usage" value={`${genKwhTotal} / ${usageKwhTotal}`} unit="kWh" tone="solar" icon={<Icon name="sun" />} footnote="forecast today" /></Card>
            <Card style={wide ? undefined : { padding: 14 }}><StatTile size={wide ? 'md' : 'sm'} label="Self-sufficiency" value={String(plan.projected.selfSufficiencyPct)} unit="%" tone="battery" icon={<Icon name="leaf" />} footnote="solar + stored" /></Card>
            <Card style={wide ? undefined : { padding: 14 }}><StatTile size={wide ? 'md' : 'sm'} label="P1 avoided" value={plan.projected.p1AvoidedKwh.toFixed(1)} unit="kWh" tone="grid" icon={<Icon name="trending-down" />} footnote="moved to P3" /></Card>
            <Card style={wide ? undefined : { padding: 14 }}><StatTile size={wide ? 'md' : 'sm'} label="Free climatization" value={plan.projected.freeClimatizationKwh.toFixed(1)} unit="kWh" tone="home" icon={<Icon name="snowflake" />} footnote="surplus → HVAC" /></Card>
            <Card style={wide ? undefined : { padding: 14 }}><StatTile size={wide ? 'md' : 'sm'} label="Projected savings" value={`€${plan.projected.savedEur.toFixed(2)}`} tone="solar" icon={<Icon name="piggy-bank" />} footnote="vs vendor default" /></Card>
          </div>

          {/* control block — armed state + autopilot + solar + next move (moved below the KPI row) */}
          <div style={{ borderRadius: 'var(--radius-card)', border: '1px solid var(--border-1)', background: 'var(--surface-1)', padding: 12 }}>
            {controlGrid}
          </div>

          {/* today's moves + why now */}
          <div style={{ display: 'grid', gridTemplateColumns: wide ? '1.25fr 1fr' : '1fr', gap: wide ? 14 : 12 }}>
            <Card title="Today's moves" subtitle="scheduled by the brain" icon={<Icon name="list-checks" />} style={{ padding: '16px 18px 6px' }}>
              {plan.actions.map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 2px', borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                  <span style={{ width: 24, height: 24, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, background: `color-mix(in srgb, var(--${a.tone}) 18%, transparent)`, color: `var(--${a.tone})` }}>{i + 1}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)' }}>{hhmm(a.startH)}–{hhmm(a.endH)}</span>
                      <Icon name={a.icon} size={15} color={`var(--${a.tone})`} />
                      <span style={{ fontSize: 14, fontWeight: 500 }}>{a.title}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.45 }}>{a.why}</div>
                  </div>
                </div>
              ))}
            </Card>
            <Card accent="battery" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--battery-wash)', color: 'var(--battery)' }}><Icon name="brain" size={18} /></span>
                <div>
                  <Eyebrow>Why now · {hhmm(plan.now)}</Eyebrow>
                  <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{plan.whyNow.title}</div>
                </div>
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-1)', lineHeight: 1.55 }}>{plan.whyNow.body}</div>
              <div style={{ marginTop: 'auto', display: 'flex', gap: 8, fontSize: 12, color: 'var(--text-3)' }}><Icon name="cpu" size={14} /> Re-planned every 10 min · MPC over 36 h</div>
            </Card>
          </div>
        </>
      )}

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
