import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { DeviceDetailResponse, ClimateLever, DeviceWarmth, DeviceView, DevicesResponse, Schedule, SchedulesResponse } from '../lib/types';
import { Card, Icon, Button, IconButton, Switch } from '../components/ui';
import { StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { UnitScheduleBox } from '../components/schedules/UnitScheduleBox';
import { EditRuleOverlay, type RulePeer } from '../components/schedules/EditRuleOverlay';
import { newRuleDraft } from '../lib/scheduleRules';

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

/** Optional service fields the design surfaces; populated by the connector as they land.
 *  (fanLevel / vaneUpDown / vaneLeftRight now live on DeviceView itself.) */
interface AcExtras {
  fanSteps?: number; // number of manual steps (default 5)
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

// Underfloor (Airzone) modes — no Dry, plus an explicit Stop. No fan-steps / vanes.
const HEATING_MODES: { value: string; label: string; icon: string }[] = [
  { value: 'auto', label: 'Auto', icon: '_a' },
  { value: 'heat', label: 'Heat', icon: 'flame' },
  { value: 'cool', label: 'Cool', icon: 'snowflake' },
  { value: 'fan', label: 'Fan', icon: 'fan' },
  { value: 'stop', label: 'Stop', icon: 'power' },
];

const WARMTH_COLOR: Record<DeviceWarmth, string> = {
  cold: 'var(--battery)', cool: 'var(--battery)', comfortable: 'var(--text-1)',
  warm: 'var(--grid)', hot: 'var(--danger)', unknown: 'var(--text-3)',
};

const modeWord = (m: string, on: boolean): string =>
  !on ? 'off' : m === 'cool' ? 'cooling' : m === 'heat' ? 'heating' : m === 'dry' ? 'drying' : m;

const accentFor = (m: string): string => (m === 'heat' ? 'var(--grid)' : m === 'dry' ? 'var(--battery)' : 'var(--solar)');

const eyebrow: CSSProperties = { fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)' };

export function DeviceDetail({ ctx }: { ctx: ShellContext }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt, refetch } = usePolling<DeviceDetailResponse>(() => api.devices.detail(id ?? ''), 15_000, [id]);
  // Fleet + all rules feed the rule overlay's "copy to units" + cross-unit overlap checks.
  const { data: fleetData } = usePolling<DevicesResponse>(api.devices.list, 0);
  const { data: schedData, refetch: refetchSchedules } = usePolling<SchedulesResponse>(api.schedules.list, 0);
  const [busy, setBusy] = useState(false);
  const [cmdErr, setCmdErr] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<{ rule: Schedule; isNew: boolean } | null>(null);

  // ---- Optimistic command pipeline -------------------------------------------
  // Every lever updates its shown value instantly (no round-trip block). Writes
  // are coalesced per lever via a short debounce so rapid taps send only the FINAL
  // value (the backend rate-limits ~1 write/30s/lever — see bug: setpoint stepping).
  // A pending value clears when the device poll reads back the requested value
  // (confirm), or snaps back to truth + surfaces the reason on a rejected write.
  type PendingValue = number | boolean | string;
  const [pending, setPending] = useState<Partial<Record<ClimateLever, PendingValue>>>({});
  const timers = useRef<Partial<Record<ClimateLever, ReturnType<typeof setTimeout>>>>({});
  const settle = useRef<Partial<Record<ClimateLever, ReturnType<typeof setTimeout>>>>({});

  const dev = data?.device ?? null;

  const clearPending = (lever: ClimateLever) =>
    setPending((p) => { const n = { ...p }; delete n[lever]; return n; });

  /** Optimistically set + debounce-send one lever. value already in device units. */
  const sendLever = (lever: ClimateLever, value: PendingValue, debounceMs = 0) => {
    setPending((p) => ({ ...p, [lever]: value }));
    if (timers.current[lever]) clearTimeout(timers.current[lever]);
    timers.current[lever] = setTimeout(() => {
      delete timers.current[lever];
      void api.devices.command(id ?? '', lever, value)
        .then((res) => {
          const r = (res as { result?: { ok?: boolean; reason?: string } }).result;
          if (r?.ok === false) {
            setCmdErr(r.reason ?? 'Command was rejected');
            clearPending(lever); // rejected — snap back to the real value
          } else {
            setCmdErr(null);
          }
        })
        .catch(() => { /* transient — keep optimistic; the poll reconciles */ })
        .finally(() => {
          refetch();
          // Safety net: if the device never reads back the requested value (clamp,
          // connector cache, silent drop), settle to truth so it can't stick wrong.
          if (settle.current[lever]) clearTimeout(settle.current[lever]);
          settle.current[lever] = setTimeout(() => clearPending(lever), 45_000);
        });
    }, debounceMs);
  };

  // Confirm-poll: drop a pending value once the device reports the requested one.
  useEffect(() => {
    if (!dev) return;
    setPending((p) => {
      if (Object.keys(p).length === 0) return p;
      const n = { ...p };
      let changed = false;
      const matches: Partial<Record<ClimateLever, boolean>> = {
        power: p.power !== undefined && dev.power === p.power,
        mode: p.mode !== undefined && dev.mode === p.mode,
        setpoint: p.setpoint !== undefined && dev.setpointC === p.setpoint,
        fan: p.fan !== undefined && (dev.fanLevel ?? 0) === p.fan,
        vaneUpDown: p.vaneUpDown !== undefined && (dev.vaneUpDown ?? 0) === p.vaneUpDown,
        vaneLeftRight: p.vaneLeftRight !== undefined && (dev.vaneLeftRight ?? 0) === p.vaneLeftRight,
      };
      for (const k of Object.keys(matches) as ClimateLever[]) {
        if (matches[k]) { delete n[k]; changed = true; }
      }
      return changed ? n : p;
    });
  }, [dev]);

  // Tear down any in-flight debounce / settle timers on unmount.
  useEffect(() => () => {
    for (const t of Object.values(timers.current)) if (t) clearTimeout(t);
    for (const t of Object.values(settle.current)) if (t) clearTimeout(t);
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch { /* keep last-good */ } finally { setBusy(false); refetch(); }
  };

  // ---- Rule (schedule) editing — same overlay as the Schedules page ----
  const refetchAll = () => { refetch(); refetchSchedules(); };
  const runRule = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch { /* surfaced via refetch */ } finally { setBusy(false); refetchAll(); }
  };
  const toggleRuleEnabled = (s: Schedule, enabled: boolean) => runRule(() => api.schedules.update(s.id, { enabled }));
  const toggleRuleDay = (s: Schedule, day: number) => {
    const days = s.days.includes(day) ? s.days.filter((x) => x !== day) : [...s.days, day].sort();
    return runRule(() => api.schedules.update(s.id, { days }));
  };
  const saveRule = async (rule: Schedule, copyTo: string[]) => {
    const { id: _rid, ...payload } = rule;
    if (rule.id) await api.schedules.update(rule.id, payload);
    else await api.schedules.create(payload);
    for (const deviceId of copyTo) await api.schedules.create({ ...payload, scope: { kind: 'unit', deviceId } });
    setEditingRule(null);
    refetchAll();
  };
  const deleteRule = (s: Schedule) => { setEditingRule(null); void runRule(() => api.schedules.remove(s.id)); };

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
  const isHeating = dev.type === 'heating'; // Airzone underfloor — no fan-steps / vanes
  const modeList = isHeating ? HEATING_MODES : MODES;
  const canConfig = isAdmin;   // schedule / solar / settings toggles
  const canWrite = isAdmin;    // live device commands

  // Optimistic display values — a pending lever overrides the last polled state.
  const pSet = pending.setpoint as number | undefined;
  const pPow = pending.power as boolean | undefined;
  const pMode = pending.mode as string | undefined;
  const pFan = pending.fan as number | undefined;
  const pVUD = pending.vaneUpDown as number | undefined;
  const pVLR = pending.vaneLeftRight as number | undefined;
  const syncing = (lever: ClimateLever): boolean => pending[lever] !== undefined;

  const curMode = pMode ?? dev.mode;
  const stateOn = pPow ?? dev.power;
  const accent = accentFor(curMode);
  // Cooling clamps to a hard 16–30 floor; underfloor zones can report a lower min (≈15).
  const hardLo = isHeating ? 10 : 16;
  const lo = Math.max(hardLo, dev.minSetpointC ?? hardLo, dev.comfortFloorC ?? hardLo);
  const hi = Math.min(30, dev.maxSetpointC ?? 30, dev.comfortCeilingC ?? 30);
  const setpoint = pSet ?? dev.setpointC ?? 24;
  const clampSet = (v: number) => Math.min(hi, Math.max(lo, Math.round(v * 2) / 2));
  // Setpoint + fan are coalesced (debounced) — rapid steps send only the final value.
  const commitSetpoint = (v: number) => sendLever('setpoint', clampSet(v), 500);
  const previewSetpoint = (v: number) => setPending((p) => ({ ...p, setpoint: clampSet(v) }));
  const step = (delta: number) => commitSetpoint(setpoint + delta);

  const fanSteps = ac.fanSteps ?? 5;
  const fanLevel = pFan ?? dev.fanLevel ?? null; // null ⇒ unknown / auto
  const setFan = (n: number) => sendLever('fan', n, 400);
  const setMode = (m: string) => sendLever('mode', m, 0);
  const togglePower = () => sendLever('power', !stateOn, 0);
  const setVane = (lever: 'vaneUpDown' | 'vaneLeftRight', n: number) => sendLever(lever, n, 300);
  const vUD = pVUD ?? dev.vaneUpDown ?? null;
  const vLR = pVLR ?? dev.vaneLeftRight ?? null;

  const toggleAutomation = (on: boolean) => run(() => api.devices.setSettings(id ?? '', { automationEnabled: on }));
  const releaseHold = () => run(() => api.devices.release(id ?? ''));
  const holdMins = dev.manualOverrideUntil ? Math.max(0, Math.round((dev.manualOverrideUntil - Date.now()) / 60_000)) : 0;

  const stateLabel = !stateOn ? 'OFF' : curMode === 'cool' ? 'COOLING' : curMode === 'heat' ? 'HEATING' : curMode.toUpperCase();
  const delta = dev.currentTempC != null ? Math.round((dev.currentTempC - setpoint) * 10) / 10 : null;

  const allRules = schedData?.schedules ?? data?.schedules ?? [];
  const unitRules = allRules.filter((s) => s.scope.kind === 'unit' && s.scope.deviceId === dev.id);
  const peers: RulePeer[] = (fleetData?.devices ?? [])
    .filter((d) => d.type === dev.type && d.id !== dev.id)
    .map((d) => ({ id: d.id, name: d.room || d.name }));
  const openAddRule = () => setEditingRule({ rule: newRuleDraft({ type: dev.type, deviceId: dev.id, name: dev.room || dev.name }), isNew: true });

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', width: '100%', padding: wide ? 0 : '8px 14px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: wide ? 0 : 8 }}>
        <IconButton variant="solid" aria-label="Back" onClick={() => nav('/devices')}><Icon name="chevron-left" size={18} /></IconButton>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>{dev.name}</h1>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isHeating ? 'Airzone underfloor' : 'Panasonic Etherea'}{dev.installation ? ` · ${dev.installation}` : ''} · {modeWord(curMode, stateOn)}
          </div>
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', padding: '4px 10px', borderRadius: 'var(--radius-pill)', background: stateOn ? (curMode === 'heat' ? 'var(--grid-wash)' : 'var(--solar-wash)') : 'var(--surface-3)', color: stateOn ? accent : 'var(--text-3)' }}>{stateLabel}</span>
        <IconButton variant="ghost" aria-label="Refresh" disabled={busy} onClick={() => refetch()}><Icon name="refresh-cw" size={16} /></IconButton>
      </div>

      {stale && <StaleBanner updatedAt={updatedAt} />}

      {cmdErr && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--grid)', background: 'var(--grid-wash)', border: '1px solid rgba(245,165,36,0.22)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }}>
          <Icon name="alert-triangle" size={14} color="var(--grid)" />
          <span>Couldn&apos;t send — {cmdErr}.</span>
        </div>
      )}

      {/* SETPOINT + AMBIENT */}
      <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1.1fr' : '1fr', gap: 12 }}>
        {/* setpoint */}
        <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ ...eyebrow, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>Setpoint{syncing('setpoint') && <SyncDot />}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
            <IconButton variant="solid" aria-label="Lower setpoint" disabled={!canWrite || setpoint <= lo} onClick={() => step(-0.5)}><Icon name="minus" size={18} /></IconButton>
            <div className="pwr-mono" style={{ fontSize: 46, fontWeight: 600, lineHeight: 1, color: accent, minWidth: 132, textAlign: 'center' }}>{setpoint.toFixed(1)}°</div>
            <IconButton variant="solid" aria-label="Raise setpoint" disabled={!canWrite || setpoint >= hi} onClick={() => step(0.5)}><Icon name="plus" size={18} /></IconButton>
          </div>
          <SetpointSlider value={setpoint} lo={lo} hi={hi} accent={accent} disabled={!canWrite} onInput={previewSetpoint} onCommit={commitSetpoint} />
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
              disabled={!canWrite}
              onClick={togglePower}
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 42, borderRadius: 'var(--radius-md)', border: `1px solid ${stateOn ? 'var(--border-2)' : 'var(--border-1)'}`, background: stateOn ? 'var(--surface-2)' : 'var(--surface-1)', color: stateOn ? 'var(--text-1)' : 'var(--text-3)', fontSize: 13, fontWeight: 600, cursor: canWrite ? 'pointer' : 'default' }}
            >
              <Icon name="power" size={15} color={stateOn ? accent : 'var(--text-3)'} />
              {stateOn ? 'On' : 'Off'}
              {syncing('power') && <SyncDot />}
            </button>
            <div className="pwr-mono" style={{ flex: 1, textAlign: 'center', fontSize: 11.5, color: 'var(--text-3)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '11px 8px' }}>
              {stateOn ? `on · ${modeWord(curMode, true)}` : 'standby'}
            </div>
          </div>
        </Card>
      </div>

      {/* MODE */}
      <Section title="Mode" right={syncing('mode') ? <SyncDot /> : undefined}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${modeList.length}, 1fr)`, gap: 6, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 6 }}>
          {modeList.map((m) => {
            const on = curMode === m.value;
            return (
              <button key={m.value} type="button" disabled={!canWrite} onClick={() => setMode(m.value)}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '10px 4px', borderRadius: 'var(--radius-md)', border: 'none', cursor: canWrite ? 'pointer' : 'default', background: on ? 'var(--surface-3)' : 'transparent', color: on ? accentFor(m.value) : 'var(--text-3)' }}>
                <ModeIcon icon={m.icon} />
                <span style={{ fontSize: 11.5, fontWeight: on ? 600 : 500, color: on ? 'var(--text-1)' : 'var(--text-3)' }}>{m.label}</span>
              </button>
            );
          })}
        </div>
      </Section>

      {/* FAN SPEED — cooling only (underfloor has no fan) */}
      {!isHeating && (
      <Section title="Fan speed" right={<span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{syncing('fan') && <SyncDot />}<span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{fanLevel == null ? 'auto' : fanLevel === 0 ? 'auto' : `manual · ${fanLevel}/${fanSteps}`}</span></span>}>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, display: 'flex', gap: 6, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 8 }}>
            {Array.from({ length: fanSteps }, (_, i) => i + 1).map((n) => {
              const filled = fanLevel != null && fanLevel >= n;
              return (
                <button key={n} type="button" aria-label={`Fan ${n}`} disabled={!canWrite} onClick={() => setFan(n)}
                  style={{ flex: 1, height: 30 + n * 4, alignSelf: 'flex-end', borderRadius: 6, border: 'none', cursor: canWrite ? 'pointer' : 'default', background: filled ? 'var(--solar)' : 'var(--surface-3)', transition: 'background .12s' }} />
              );
            })}
          </div>
          <button type="button" disabled={!canWrite} onClick={() => setFan(0)}
            style={{ width: 88, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 'var(--radius-lg)', border: `1px solid ${fanLevel === 0 || fanLevel == null ? 'var(--solar)' : 'var(--border-2)'}`, background: fanLevel === 0 ? 'var(--solar-wash)' : 'var(--surface-1)', color: fanLevel === 0 ? 'var(--solar)' : 'var(--text-2)', cursor: canWrite ? 'pointer' : 'default' }}>
            <CircleA color={fanLevel === 0 ? 'var(--solar)' : 'var(--text-2)'} />
            <span style={{ fontSize: 11.5, fontWeight: 500 }}>Auto</span>
          </button>
        </div>
      </Section>
      )}

      {/* VANES — cooling only (underfloor has none) */}
      {!isHeating && (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <VaneCard title="Up / down vanes" value={vUD} syncing={syncing('vaneUpDown')} disabled={!canWrite} onSelect={(n) => setVane('vaneUpDown', n)} />
        <VaneCard title="Left / right vanes" value={vLR} syncing={syncing('vaneLeftRight')} disabled={!canWrite} onSelect={(n) => setVane('vaneLeftRight', n)} />
      </div>
      )}

      {/* HEATING READOUTS — underfloor-only signals Cooling lacks */}
      {isHeating && (
        <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(3, 1fr)' : '1fr 1fr', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '11px 13px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text-2)' }}><Icon name="flame" size={14} color={dev.floorDemand ? 'var(--grid)' : 'var(--text-3)'} />Floor demand</span>
            <span className="pwr-mono" style={{ fontSize: 12.5, fontWeight: 600, color: dev.floorDemand ? 'var(--grid)' : 'var(--text-3)' }}>{dev.floorDemand ? 'Calling' : 'Idle'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '11px 13px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text-2)' }}><Icon name="droplet" size={14} color="var(--battery)" />Humidity</span>
            <span className="pwr-mono" style={{ fontSize: 12.5, fontWeight: 600, color: dev.humidity != null ? 'var(--text-1)' : 'var(--text-3)' }}>{dev.humidity != null ? `${Math.round(dev.humidity)}%` : '—'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '11px 13px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text-2)' }}><Icon name={dev.wireless ? 'radio' : 'cable'} size={14} color="var(--text-2)" />Thermostat</span>
            <span className="pwr-mono" style={{ fontSize: 12, fontWeight: 600, color: dev.lowBattery ? 'var(--grid)' : 'var(--text-1)' }}>
              {dev.wireless ? (dev.lowBattery ? 'Radio · low batt' : 'Radio') : 'Wired'}
            </span>
          </div>
        </div>
      )}

      {/* MANUAL HOLD */}
      {holdMins > 0 && (
        <Banner icon="hand" tone="surface">
          <span style={{ fontWeight: 600 }}>Manual hold</span>
          <span style={{ color: 'var(--text-2)' }}> — automation won’t touch this unit for ~{holdMins} min</span>
          <BannerAction disabled={!canWrite || busy} onClick={releaseHold}>Release</BannerAction>
        </Banner>
      )}

      {/* SOLAR-SURPLUS PRE-HEAT / PRE-COOL — per-unit opt-in for surplus-driven runs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, background: dev.automationEnabled ? (isHeating ? 'var(--grid-wash)' : 'var(--solar-wash)') : 'var(--surface-1)', border: `1px solid ${dev.automationEnabled ? (isHeating ? 'rgba(245,165,36,0.2)' : 'rgba(46,230,160,0.2)') : 'var(--border-1)'}`, borderRadius: 'var(--radius-lg)', padding: '11px 13px' }}>
        <Icon name={isHeating ? 'flame' : 'zap'} size={17} color={dev.automationEnabled ? (isHeating ? 'var(--grid)' : 'var(--solar)') : 'var(--text-3)'} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{isHeating ? 'Solar-surplus pre-heat' : 'Solar-surplus cooling'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{dev.automationEnabled ? (isHeating ? 'Uses excess solar to pre-heat this room' : 'Uses excess solar to pre-cool this unit') : (isHeating ? 'This room is excluded from surplus pre-heat' : 'This unit is excluded from surplus cooling')}</div>
        </div>
        <Switch checked={dev.automationEnabled} disabled={!canConfig || busy} onChange={(e) => toggleAutomation(e.target.checked)} />
      </div>

      {/* SCHEDULE — this unit's rules, via the shared UnitScheduleBox + overlay */}
      <UnitScheduleBox
        name={dev.room || dev.name}
        type={dev.type}
        rules={unitRules}
        canConfig={canConfig}
        busy={busy}
        onAddRule={openAddRule}
        onEditRule={(s) => setEditingRule({ rule: s, isNew: false })}
        onToggleEnabled={toggleRuleEnabled}
        onToggleDay={toggleRuleDay}
      />

      {/* CONFIG & SERVICE */}
      <div style={{ ...eyebrow, marginTop: 4 }}>Config &amp; service</div>
      {/* filter + maintenance — AC only (underfloor has no air filter) */}
      {!isHeating && (
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
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <MetaTile label="Temp limit" value={`${dev.minSetpointC ?? 16}–${dev.maxSetpointC ?? 30}°`} />
        <MetaTile label="Comfort band" value={`${dev.comfortFloorC ?? 16}–${dev.comfortCeilingC ?? 30}°`} />
        <MetaTile label="Installation" value={dev.installation ?? (isHeating ? 'Airzone' : 'Intesis')} />
        <MetaTile label="Signal" value={ac.signal ? cap(ac.signal) : (dev.online ? 'Online' : '—')} valueColor={ac.signal === 'weak' ? 'var(--grid)' : dev.online ? 'var(--solar)' : 'var(--text-3)'} />
      </div>

      {!isAdmin && <div style={{ fontSize: 11.5, color: 'var(--grid)', textAlign: 'center' }}>Read-only — only an admin can command this unit.</div>}

      {editingRule && (
        <EditRuleOverlay
          rule={editingRule.rule}
          unitName={dev.room || dev.name}
          wide={wide}
          peers={peers}
          allRules={allRules}
          canDelete={canConfig && !editingRule.isNew}
          onCancel={() => setEditingRule(null)}
          onSave={saveRule}
          onDelete={() => deleteRule(editingRule.rule)}
        />
      )}
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

function VaneCard({ title, value, disabled, syncing, onSelect }: { title: string; value?: number | null; disabled?: boolean; syncing?: boolean; onSelect: (n: number) => void }) {
  // 0 = auto (A), 1..5 = fixed, 10 = swing. null ⇒ unknown.
  const pos = value ?? 0;
  const opts: { v: number; label: string }[] = [
    { v: 0, label: 'A' }, { v: 1, label: '1' }, { v: 2, label: '2' }, { v: 3, label: '3' }, { v: 4, label: '4' }, { v: 5, label: '5' },
  ];
  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon name="git-commit-vertical" size={14} color="var(--text-3)" />
        <span style={{ ...eyebrow, lineHeight: 1.2 }}>{title}</span>
        {syncing && <SyncDot />}
      </div>
      <div style={{ display: 'flex', gap: 4, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: 4 }}>
        {opts.map((o) => {
          const on = pos === o.v;
          return (
            <button key={o.v} type="button" disabled={disabled} aria-label={`${title} ${o.label}`} onClick={() => onSelect(o.v)}
              style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '7px 0', borderRadius: 6, border: 'none', cursor: disabled ? 'default' : 'pointer', fontWeight: on ? 700 : 500, background: on ? 'var(--solar)' : 'transparent', color: on ? '#04140d' : 'var(--text-3)' }}>{o.label}</button>
          );
        })}
      </div>
    </Card>
  );
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

/** Pulsing solar dot shown while a lever's command is in flight / unconfirmed. */
function SyncDot() {
  return (
    <span aria-label="syncing" title="Syncing — confirming with the unit" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--solar)', flex: 'none', animation: 'pwrSyncPulse 1s ease-in-out infinite' }}>
      <style>{`@keyframes pwrSyncPulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }`}</style>
    </span>
  );
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
