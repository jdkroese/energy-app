import { useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { DeviceDetailResponse, ClimateLever, DeviceWarmth, DeviceView, Schedule, DevicesStatus, ControlMode } from '../lib/types';
import { Card, Icon, Button, IconButton, Switch } from '../components/ui';
import { StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * DeviceDetail (/devices/:id) — per-unit AC control, to the approved design:
 *   • header (name · model · installation · state pill)
 *   • SETPOINT (stepper + slider) + AMBIENT (temp, Δ-target, on/off)
 *   • MODE strip (icons) · FAN-SPEED bar · UP-DOWN + LEFT-RIGHT vanes
 *   • solar-surplus automation banner · this unit's schedule (timeline)
 *   • config & service (filter, maintenance, limits, comfort, signal)
 *
 * Vanes / multi-step-fan read-back / filter / maintenance / signal arrive from
 * the Intesis connector as it lands those fields (see AcExtras) — until then the
 * sections render with honest "—" / awaiting states. All writes are admin- and
 * arm-gated server-side.
 * ==========================================================================*/

/** Optional fields the design surfaces; populated by the connector as they land. */
interface AcExtras {
  fanLevel?: number; // current fan step (0 = auto)
  fanSteps?: number; // number of manual steps (default 5)
  vaneUpDown?: number | 'swing' | 'auto'; // 1..5 | swing | auto
  vaneLeftRight?: number | 'swing' | 'auto';
  filterLifePct?: number; // 0..100
  filterDays?: number; // est. days remaining
  maintenanceAlert?: string | null;
  maintenanceEveryMonths?: number;
  maintenanceEnabled?: boolean;
  signal?: string; // 'strong' | 'good' | 'weak'
}

const MODES: { value: string; label: string; icon: string }[] = [
  { value: 'auto', label: 'Auto', icon: '_a' },
  { value: 'cool', label: 'Cool', icon: 'snowflake' },
  { value: 'heat', label: 'Heat', icon: 'flame' },
  { value: 'dry', label: 'Dry', icon: 'droplet' },
  { value: 'fan', label: 'Fan', icon: 'fan' },
];

const WARMTH_COLOR: Record<DeviceWarmth, string> = {
  cold: 'var(--battery)', cool: 'var(--battery)', comfortable: 'var(--text-1)',
  warm: 'var(--grid)', hot: 'var(--danger)', unknown: 'var(--text-3)',
};

const modeWord = (m: string, on: boolean): string =>
  !on ? 'off' : m === 'cool' ? 'cooling' : m === 'heat' ? 'heating' : m === 'dry' ? 'drying' : m;

const accentFor = (m: string): string => (m === 'heat' ? 'var(--grid)' : m === 'dry' ? 'var(--battery)' : 'var(--solar)');

const eyebrow: CSSProperties = { fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)' };

// Weekday chips: display Mon..Sun; store days are 0=Sun..6=Sat.
const DAY_ABBR = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const ROW_TO_STORE = [1, 2, 3, 4, 5, 6, 0];

export function DeviceDetail({ ctx }: { ctx: ShellContext }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt, refetch } = usePolling<DeviceDetailResponse>(() => api.devices.detail(id ?? ''), 15_000, [id]);
  const { data: dstatus, refetch: refetchStatus } = usePolling<DevicesStatus>(() => api.devices.status(), 15_000);
  const [busy, setBusy] = useState(false);
  const [arming, setArming] = useState(false);
  const [cmdErr, setCmdErr] = useState<string | null>(null);
  const [pendingSetpoint, setPendingSetpoint] = useState<number | null>(null);
  const [pendingFan, setPendingFan] = useState<number | null>(null);

  const dev = data?.device ?? null;
  const armed = dstatus?.armed ?? false;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch { /* keep last-good */ } finally { setBusy(false); setPendingSetpoint(null); setPendingFan(null); refetch(); }
  };
  // A device command replies { result: { ok, reason } } — surface a rejection
  // (e.g. "not armed", a guardrail clamp) instead of silently reverting.
  const cmd = (lever: ClimateLever, value: boolean | number | string) =>
    run(async () => {
      const res = (await api.devices.command(id ?? '', lever, value)) as { result?: { ok?: boolean; reason?: string } };
      setCmdErr(res?.result?.ok === false ? res.result.reason ?? 'Command was rejected' : null);
    });
  const armDevices = (on: boolean) => {
    setArming(true);
    setCmdErr(null);
    api.devices.arm(on, on ? 'manual' : 'off').catch(() => {}).finally(() => { setArming(false); refetchStatus(); refetch(); });
  };
  const toggleSchedule = (sid: string, enabled: boolean) => run(() => api.schedules.update(sid, { enabled }));

  if (!dev) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto', width: '100%', padding: wide ? 0 : '16px 14px' }}>
        <Card padded style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', padding: 28 }}>
          <Icon name="thermometer" size={26} color="var(--text-3)" />
          <div style={{ fontSize: 15, fontWeight: 600 }}>{loading ? 'Loading device…' : data && !data.connected ? 'AC Cloud not connected' : 'Device not found'}</div>
          <Button variant="secondary" iconLeft={<Icon name="chevron-left" size={15} />} onClick={() => nav('/devices')}>Back to devices</Button>
        </Card>
      </div>
    );
  }

  const ac = dev as DeviceView & AcExtras;
  const canConfig = isAdmin;            // schedule / solar / settings toggles (persisted config)
  const canWrite = isAdmin && armed;    // live device commands require arming
  const accent = accentFor(dev.mode);
  const setpoint = pendingSetpoint ?? dev.setpointC ?? 24;
  const lo = Math.max(16, dev.minSetpointC ?? 16, dev.comfortFloorC ?? 16);
  const hi = Math.min(30, dev.maxSetpointC ?? 30, dev.comfortCeilingC ?? 30);
  const commitSetpoint = (v: number) => {
    const next = Math.min(hi, Math.max(lo, Math.round(v * 2) / 2));
    setPendingSetpoint(next);
    void cmd('setpoint', next);
  };
  const step = (delta: number) => commitSetpoint(setpoint + delta);

  const fanSteps = ac.fanSteps ?? 5;
  const fanLevel = pendingFan ?? ac.fanLevel ?? null; // null ⇒ unknown / auto
  const setFan = (n: number) => { setPendingFan(n); void cmd('fan', n); };

  const toggleAutomation = (on: boolean) => run(() => api.devices.setSettings(id ?? '', { automationEnabled: on }));
  const releaseHold = () => run(() => api.devices.release(id ?? ''));
  const holdMins = dev.manualOverrideUntil ? Math.max(0, Math.round((dev.manualOverrideUntil - Date.now()) / 60_000)) : 0;

  const stateOn = dev.power;
  const stateLabel = !stateOn ? 'OFF' : dev.mode === 'cool' ? 'COOLING' : dev.mode === 'heat' ? 'HEATING' : dev.mode.toUpperCase();
  const delta = dev.currentTempC != null ? Math.round((dev.currentTempC - setpoint) * 10) / 10 : null;

  const unitSchedules = (data?.schedules ?? []).filter((s) => s.scope.deviceIds.length === 0 || s.scope.deviceIds.includes(dev.id));

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', width: '100%', padding: wide ? 0 : '8px 14px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: wide ? 0 : 8 }}>
        <IconButton variant="solid" aria-label="Back" onClick={() => nav('/devices')}><Icon name="chevron-left" size={18} /></IconButton>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>{dev.name}</h1>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Panasonic Etherea{dev.installation ? ` · ${dev.installation}` : ''} · {modeWord(dev.mode, stateOn)}
          </div>
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', padding: '4px 10px', borderRadius: 'var(--radius-pill)', background: stateOn ? (dev.mode === 'heat' ? 'var(--grid-wash)' : 'var(--solar-wash)') : 'var(--surface-3)', color: stateOn ? accent : 'var(--text-3)' }}>{stateLabel}</span>
        <IconButton variant="ghost" aria-label="Refresh" disabled={busy} onClick={() => refetch()}><Icon name="refresh-cw" size={16} /></IconButton>
      </div>

      {stale && <StaleBanner updatedAt={updatedAt} />}

      {/* ARM STATE — live commands only reach the unit when control is armed */}
      {isAdmin && (
        <ArmBanner armed={armed} mode={dstatus?.mode} busy={arming} onArm={() => armDevices(true)} onDisarm={() => armDevices(false)} />
      )}
      {cmdErr && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--grid)', background: 'var(--grid-wash)', border: '1px solid rgba(245,165,36,0.22)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }}>
          <Icon name="alert-triangle" size={14} color="var(--grid)" />
          <span>Couldn&apos;t send — {cmdErr}{!armed ? ' · arm control above first' : ''}.</span>
        </div>
      )}

      {/* SETPOINT + AMBIENT */}
      <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1.1fr' : '1fr', gap: 12 }}>
        {/* setpoint */}
        <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ ...eyebrow, textAlign: 'center' }}>Setpoint</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
            <IconButton variant="solid" aria-label="Lower setpoint" disabled={!canWrite || busy || setpoint <= lo} onClick={() => step(-0.5)}><Icon name="minus" size={18} /></IconButton>
            <div className="pwr-mono" style={{ fontSize: 46, fontWeight: 600, lineHeight: 1, color: accent, minWidth: 132, textAlign: 'center' }}>{setpoint.toFixed(1)}°</div>
            <IconButton variant="solid" aria-label="Raise setpoint" disabled={!canWrite || busy || setpoint >= hi} onClick={() => step(0.5)}><Icon name="plus" size={18} /></IconButton>
          </div>
          <SetpointSlider value={setpoint} lo={lo} hi={hi} accent={accent} disabled={!canWrite || busy} onInput={setPendingSetpoint} onCommit={commitSetpoint} />
          <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)', textAlign: 'center' }}>range {lo}–{hi}°</div>
        </Card>

        {/* ambient */}
        <Card padded style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={eyebrow}>Ambient</div>
              <div className="pwr-mono" style={{ fontSize: 30, fontWeight: 600, color: WARMTH_COLOR[dev.warmth], lineHeight: 1.1 }}>{dev.currentTempC != null ? `${dev.currentTempC.toFixed(1)}°` : '—'}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={eyebrow}>Δ target</div>
              <div className="pwr-mono" style={{ fontSize: 17, marginTop: 6, color: delta == null ? 'var(--text-3)' : delta > 0 ? 'var(--grid)' : delta < 0 ? 'var(--battery)' : 'var(--solar)' }}>{delta != null ? `${delta > 0 ? '+' : ''}${delta.toFixed(1)}°` : '—'}</div>
            </div>
          </div>
          {dev.currentTempC != null && (
            <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-3)', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', inset: 0, width: `${Math.min(100, Math.max(0, ((dev.currentTempC - lo) / (hi - lo)) * 100))}%`, background: WARMTH_COLOR[dev.warmth] }} />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              disabled={!canWrite || busy}
              onClick={() => cmd('power', !stateOn)}
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 42, borderRadius: 'var(--radius-md)', border: `1px solid ${stateOn ? 'var(--border-2)' : 'var(--border-1)'}`, background: stateOn ? 'var(--surface-2)' : 'var(--surface-1)', color: stateOn ? 'var(--text-1)' : 'var(--text-3)', fontSize: 13, fontWeight: 600, cursor: canWrite ? 'pointer' : 'default' }}
            >
              <Icon name="power" size={15} color={stateOn ? accent : 'var(--text-3)'} />
              {stateOn ? 'On' : 'Off'}
            </button>
            <div className="pwr-mono" style={{ flex: 1, textAlign: 'center', fontSize: 11.5, color: 'var(--text-3)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '11px 8px' }}>
              {stateOn ? `on · ${modeWord(dev.mode, true)}` : 'standby'}
            </div>
          </div>
        </Card>
      </div>

      {/* MODE */}
      <Section title="Mode">
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${MODES.length}, 1fr)`, gap: 6, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 6 }}>
          {MODES.map((m) => {
            const on = dev.mode === m.value;
            return (
              <button key={m.value} type="button" disabled={!canWrite || busy} onClick={() => cmd('mode', m.value)}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '10px 4px', borderRadius: 'var(--radius-md)', border: 'none', cursor: canWrite ? 'pointer' : 'default', background: on ? 'var(--surface-3)' : 'transparent', color: on ? accentFor(m.value) : 'var(--text-3)' }}>
                <ModeIcon icon={m.icon} />
                <span style={{ fontSize: 11.5, fontWeight: on ? 600 : 500, color: on ? 'var(--text-1)' : 'var(--text-3)' }}>{m.label}</span>
              </button>
            );
          })}
        </div>
      </Section>

      {/* FAN SPEED */}
      <Section title="Fan speed" right={<span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{fanLevel == null ? 'auto' : fanLevel === 0 ? 'auto' : `manual · ${fanLevel}/${fanSteps}`}</span>}>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, display: 'flex', gap: 6, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 8 }}>
            {Array.from({ length: fanSteps }, (_, i) => i + 1).map((n) => {
              const filled = fanLevel != null && fanLevel >= n;
              return (
                <button key={n} type="button" aria-label={`Fan ${n}`} disabled={!canWrite || busy} onClick={() => setFan(n)}
                  style={{ flex: 1, height: 30 + n * 4, alignSelf: 'flex-end', borderRadius: 6, border: 'none', cursor: canWrite ? 'pointer' : 'default', background: filled ? 'var(--solar)' : 'var(--surface-3)', transition: 'background .12s' }} />
              );
            })}
          </div>
          <button type="button" disabled={!canWrite || busy} onClick={() => setFan(0)}
            style={{ width: 88, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 'var(--radius-lg)', border: `1px solid ${fanLevel === 0 || fanLevel == null ? 'var(--solar)' : 'var(--border-2)'}`, background: fanLevel === 0 ? 'var(--solar-wash)' : 'var(--surface-1)', color: fanLevel === 0 ? 'var(--solar)' : 'var(--text-2)', cursor: canWrite ? 'pointer' : 'default' }}>
            <CircleA color={fanLevel === 0 ? 'var(--solar)' : 'var(--text-2)'} />
            <span style={{ fontSize: 11.5, fontWeight: 500 }}>Auto</span>
          </button>
        </div>
      </Section>

      {/* VANES */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <VaneCard title="Up / down vanes" value={ac.vaneUpDown} disabled />
        <VaneCard title="Left / right vanes" value={ac.vaneLeftRight} disabled />
      </div>

      {/* MANUAL HOLD */}
      {holdMins > 0 && (
        <Banner icon="hand" tone="surface">
          <span style={{ fontWeight: 600 }}>Manual hold</span>
          <span style={{ color: 'var(--text-2)' }}> — automation won’t touch this unit for ~{holdMins} min</span>
          <BannerAction disabled={!canWrite || busy} onClick={releaseHold}>Release</BannerAction>
        </Banner>
      )}

      {/* SOLAR-SURPLUS COOLING — per-unit opt-in for surplus-driven pre-cooling */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, background: dev.automationEnabled ? 'var(--solar-wash)' : 'var(--surface-1)', border: `1px solid ${dev.automationEnabled ? 'rgba(46,230,160,0.2)' : 'var(--border-1)'}`, borderRadius: 'var(--radius-lg)', padding: '11px 13px' }}>
        <Icon name="zap" size={17} color={dev.automationEnabled ? 'var(--solar)' : 'var(--text-3)'} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Solar-surplus cooling</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{dev.automationEnabled ? 'Uses excess solar to pre-cool this unit' : 'This unit is excluded from surplus cooling'}</div>
        </div>
        <Switch checked={dev.automationEnabled} disabled={!canConfig || busy} onChange={(e) => toggleAutomation(e.target.checked)} />
      </div>

      {/* SCHEDULE — per-schedule timeline, weekdays, active toggle + edit link */}
      <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 4 }}>
          <Icon name="calendar-clock" size={16} color="var(--text-2)" />
          <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>This unit&apos;s schedule</span>
          <button type="button" onClick={() => nav('/schedules?new=1')} style={{ fontSize: 11.5, color: 'var(--solar)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>+ Add</button>
        </div>
        {unitSchedules.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '2px 0 6px' }}>{scheduleCaption(unitSchedules, dev)}</div>
        ) : (
          unitSchedules.map((s) => (
            <ScheduleRow key={s.id} s={s} canConfig={canConfig} busy={busy}
              onToggle={(en) => toggleSchedule(s.id, en)} onEdit={() => nav(`/schedules?edit=${s.id}`)} />
          ))
        )}
      </Card>

      {/* CONFIG & SERVICE */}
      <div style={{ ...eyebrow, marginTop: 4 }}>Config &amp; service</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {/* filter */}
        <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="air-vent" size={15} color="var(--text-2)" />
            <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>Filter cleaning</span>
            {ac.filterLifePct != null && <button type="button" disabled={!canWrite} style={{ fontSize: 11, color: 'var(--solar)', background: 'none', border: 'none', cursor: canWrite ? 'pointer' : 'default', fontWeight: 600 }}>Reset</button>}
          </div>
          {ac.filterLifePct != null ? (
            <>
              <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-3)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, ac.filterLifePct))}%`, background: ac.filterLifePct < 20 ? 'var(--grid)' : 'var(--battery)' }} />
              </div>
              <div className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{ac.filterLifePct}% life{ac.filterDays != null ? ` · ~${ac.filterDays} days` : ''}</div>
            </>
          ) : (
            <div className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>— awaiting unit data</div>
          )}
        </Card>
        {/* maintenance */}
        <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="wrench" size={15} color="var(--text-2)" />
            <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>Maintenance</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: ac.maintenanceAlert ? 'var(--grid)' : 'var(--solar)' }}>{ac.maintenanceAlert || 'No alerts'}</div>
          <div className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{ac.maintenanceEveryMonths != null ? `Reminder every ${ac.maintenanceEveryMonths} mo · ${ac.maintenanceEnabled ? 'on' : 'disabled'}` : 'No reminder set'}</div>
        </Card>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <MetaTile label="Temp limit" value={`${dev.minSetpointC ?? 16}–${dev.maxSetpointC ?? 30}°`} />
        <MetaTile label="Comfort band" value={`${dev.comfortFloorC ?? 16}–${dev.comfortCeilingC ?? 30}°`} />
        <MetaTile label="Installation" value={dev.installation ?? 'Intesis'} />
        <MetaTile label="Signal" value={ac.signal ? cap(ac.signal) : (dev.online ? 'Online' : '—')} valueColor={ac.signal === 'weak' ? 'var(--grid)' : dev.online ? 'var(--solar)' : 'var(--text-3)'} />
      </div>

      {!isAdmin && <div style={{ fontSize: 11.5, color: 'var(--grid)', textAlign: 'center' }}>Read-only — only an admin can command this unit.</div>}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Pieces
 * --------------------------------------------------------------------------*/

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={eyebrow}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function SetpointSlider({ value, lo, hi, accent, disabled, onInput, onCommit }: {
  value: number; lo: number; hi: number; accent: string; disabled: boolean;
  onInput: (v: number) => void; onCommit: (v: number) => void;
}) {
  const pct = Math.min(100, Math.max(0, ((value - lo) / (hi - lo)) * 100));
  return (
    <div style={{ position: 'relative', height: 18, display: 'flex', alignItems: 'center' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, height: 6, borderRadius: 999, background: 'var(--surface-3)' }} />
      <div style={{ position: 'absolute', left: 0, height: 6, width: `${pct}%`, borderRadius: 999, background: disabled ? 'var(--text-3)' : accent }} />
      <input
        type="range" min={lo} max={hi} step={0.5} value={value} disabled={disabled}
        onChange={(e) => onInput(Number(e.target.value))}
        onMouseUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        aria-label="Setpoint"
        style={{ position: 'absolute', left: 0, right: 0, width: '100%', margin: 0, opacity: 0, height: 18, cursor: disabled ? 'default' : 'pointer' }}
      />
    </div>
  );
}

function VaneCard({ title, value, disabled }: { title: string; value?: number | 'swing' | 'auto'; disabled?: boolean }) {
  const mode: 'auto' | 'swing' | 'pos' = value === 'swing' ? 'swing' : typeof value === 'number' ? 'pos' : 'auto';
  const pos = typeof value === 'number' ? value : 0;
  const muted = disabled;
  const pill = (active: boolean): CSSProperties => ({
    fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 'var(--radius-md)',
    border: `1px solid ${active ? 'var(--solar)' : 'var(--border-2)'}`,
    background: active ? 'var(--solar-wash)' : 'transparent', color: active ? 'var(--solar)' : 'var(--text-3)',
  });
  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 10, opacity: muted ? 0.6 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon name="git-commit-vertical" size={14} color="var(--text-3)" />
        <span style={{ ...eyebrow, lineHeight: 1.2 }}>{title}</span>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <span style={pill(mode === 'auto')}>Auto</span>
        <span style={pill(mode === 'swing')}>≋ Swing</span>
      </div>
      <div style={{ display: 'flex', gap: 4, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: 4 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <div key={n} style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '6px 0', borderRadius: 6, fontWeight: mode === 'pos' && pos === n ? 700 : 500, background: mode === 'pos' && pos === n ? 'var(--solar)' : 'transparent', color: mode === 'pos' && pos === n ? '#04140d' : 'var(--text-3)' }}>{n}</div>
        ))}
      </div>
    </Card>
  );
}

function ArmBanner({ armed, mode, busy, onArm, onDisarm }: {
  armed: boolean; mode?: ControlMode; busy: boolean; onArm: () => void; onDisarm: () => void;
}) {
  if (armed) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--solar-wash)', border: '1px solid rgba(46,230,160,0.2)', borderRadius: 'var(--radius-lg)', padding: '9px 13px' }}>
        <Icon name="shield-check" size={16} color="var(--solar)" />
        <div style={{ flex: 1, fontSize: 12, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: 'var(--solar)' }}>Live control armed</span>
          <span style={{ color: 'var(--text-3)' }}> · {mode ?? 'manual'} — controls reach the unit</span>
        </div>
        <button type="button" disabled={busy} onClick={onDisarm} style={{ fontSize: 11, color: 'var(--text-2)', background: 'none', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: '5px 11px', cursor: busy ? 'default' : 'pointer', fontWeight: 600 }}>Disarm</button>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--grid-wash)', border: '1px solid rgba(245,165,36,0.25)', borderRadius: 'var(--radius-lg)', padding: '9px 13px' }}>
      <Icon name="shield-off" size={16} color="var(--grid)" />
      <div style={{ flex: 1, fontSize: 12, minWidth: 0 }}>
        <span style={{ fontWeight: 600, color: 'var(--grid)' }}>Live control is disarmed</span>
        <span style={{ color: 'var(--text-2)' }}> — these controls won&apos;t reach the unit yet</span>
      </div>
      <Button size="sm" variant="primary" loading={busy} iconLeft={<Icon name="power" size={14} />} onClick={onArm}>Arm</Button>
    </div>
  );
}

function ScheduleRow({ s, canConfig, busy, onToggle, onEdit }: {
  s: Schedule; canConfig: boolean; busy: boolean; onToggle: (enabled: boolean) => void; onEdit: () => void;
}) {
  const frac = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    return Math.min(1, Math.max(0, ((h || 0) + (m || 0) / 60) / 24));
  };
  const a = frac(s.start); const b = frac(s.end);
  const left = Math.min(a, b) * 100; const width = Math.max(2, Math.abs(b - a) * 100);
  const dim = !s.enabled;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '11px 0', borderTop: '1px solid var(--border-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, opacity: dim ? 0.55 : 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
          <div className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{s.start}–{s.end} · {cap(s.mode)} {s.setpointC}°</div>
        </div>
        <button type="button" aria-label="Edit schedule" onClick={onEdit} style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, flex: 'none', borderRadius: 8, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-2)', cursor: 'pointer' }}>
          <Icon name="pencil" size={14} />
        </button>
        <Switch checked={s.enabled} disabled={!canConfig || busy} onChange={(e) => onToggle(e.target.checked)} />
      </div>
      <div style={{ display: 'flex', gap: 5, opacity: dim ? 0.55 : 1 }}>
        {DAY_ABBR.map((l, row) => {
          const on = s.days.includes(ROW_TO_STORE[row]);
          return <span key={row} style={{ width: 24, height: 22, flex: 'none', borderRadius: 6, display: 'grid', placeItems: 'center', fontSize: 10.5, fontWeight: 600, background: on ? 'var(--solar-wash)' : 'var(--surface-1)', color: on ? 'var(--solar)' : 'var(--text-3)', border: `1px solid ${on ? 'transparent' : 'var(--border-1)'}` }}>{l}</span>;
        })}
      </div>
      <div style={{ position: 'relative', height: 16, borderRadius: 6, background: 'var(--surface-1)', border: '1px solid var(--border-1)', overflow: 'hidden', opacity: dim ? 0.4 : 1 }}>
        {[25, 50, 75].map((p) => <div key={p} style={{ position: 'absolute', top: 0, bottom: 0, left: `${p}%`, width: 1, background: 'var(--border-1)' }} />)}
        <div title={`${s.start}–${s.end}`} style={{ position: 'absolute', top: 3, bottom: 3, left: `${left}%`, width: `${width}%`, borderRadius: 3, background: 'var(--solar)', opacity: 0.6 }} />
      </div>
    </div>
  );
}

function scheduleCaption(schedules: Schedule[], dev: DeviceView): string {
  const active = schedules.filter((s) => s.enabled);
  if (active.length) {
    const parts = active.map((s) => `${s.name} ${parseInt(s.start, 10)}–${parseInt(s.end, 10)}`);
    return parts.join(' · ');
  }
  if (dev.governedBy.schedules.length) return `Inherits ${dev.governedBy.schedules.join(', ')}`;
  return 'No unit schedule · inherits group defaults';
}

function Banner({ icon, tone, iconColor, children }: { icon: string; tone: 'solar' | 'surface'; iconColor?: string; children: ReactNode }) {
  const solar = tone === 'solar';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, background: solar ? 'var(--solar-wash)' : 'var(--surface-1)', border: `1px solid ${solar ? 'rgba(46,230,160,0.2)' : 'var(--border-1)'}`, borderRadius: 'var(--radius-lg)', padding: '10px 13px' }}>
      <Icon name={icon} size={17} color={iconColor ?? 'var(--text-1)'} />
      <div style={{ flex: 1, fontSize: 12 }}>{children}</div>
    </div>
  );
}

function BannerAction({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} style={{ fontSize: 11, color: 'var(--solar)', background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', fontWeight: 600, marginLeft: 8 }}>{children}</button>
  );
}

function MetaTile({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '11px 13px' }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{label}</span>
      <span className="pwr-mono" style={{ fontSize: 12.5, fontWeight: 600, color: valueColor ?? 'var(--text-1)' }}>{value}</span>
    </div>
  );
}

function ModeIcon({ icon }: { icon: string }) {
  if (icon === '_a') return <CircleA color="currentColor" />;
  return <Icon name={icon} size={18} />;
}

function CircleA({ color }: { color: string }) {
  return (
    <span style={{ width: 20, height: 20, borderRadius: '50%', border: `1.5px solid ${color}`, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, color }}>A</span>
  );
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
