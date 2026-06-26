import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type {
  Automation, AutomationsResponse, DevicesResponse, DevicesStatus,
  LiveResponse, SolarSurplusPrecoolParams,
  ControlStatus, BatteryPriorityKey, BatteryPriorityRule,
} from '../lib/types';
import { Card, Icon, Button, Switch, SegmentedControl, Slider, Eyebrow } from '../components/ui';
import { AutomationRow } from '../components/AutomationRow';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import type { ReactNode } from 'react';

/* ============================================================================
 * Automations (/automations) — to the approved design: the master arm control,
 * then per-rule WHEN / DO / UNTIL / LIMITS colored blocks with a live preview of
 * what the rule would do right now, plus a collapsible editor. Admin-gated.
 * ==========================================================================*/

function batterySoc(live: LiveResponse | null): number | null {
  if (!live) return null;
  return Math.round((live.sonnen.soc * 9.2 + live.tesla.soc * 27) / (9.2 + 27));
}
function surplusKw(live: LiveResponse | null): number {
  if (!live) return 0;
  return live.grid.dir === 'exporting' ? Math.round(live.grid.kw * 10) / 10 : 0;
}

function Tok({ children, color }: { children: ReactNode; color?: string }) {
  return <span className="pwr-mono" style={{ fontSize: 12, background: 'var(--surface-3)', border: '1px solid var(--border-1)', borderRadius: 7, padding: '3px 8px', color: color ?? 'var(--text-1)' }}>{children}</span>;
}
function Block({ label, color, wash, children }: { label: string; color: string; wash: string; children: ReactNode }) {
  return (
    <div style={{ background: wash, border: `1px solid ${color}`, borderRadius: 'var(--radius-lg)', padding: '11px 14px' }}>
      <div className="pwr-eyebrow" style={{ color, marginBottom: 7 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 12.5, lineHeight: 2 }}>{children}</div>
    </div>
  );
}

function ArmCard({ status, canWrite, onArm, busy }: {
  status: DevicesStatus | null; canWrite: boolean; onArm: (armed: boolean, mode: 'auto' | 'manual') => void; busy: boolean;
}) {
  const armed = status?.armed ?? false;
  const mode = status?.mode ?? 'off';
  return (
    <Card accent={armed ? 'solar' : 'grid'} glow padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: armed ? 'var(--solar-wash)' : 'var(--grid-wash)', color: armed ? 'var(--solar)' : 'var(--grid)', flex: 'none' }}><Icon name={armed ? 'shield-check' : 'shield-off'} size={19} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Climate control · {armed ? (mode === 'auto' ? 'Auto' : 'Manual') : 'Disarmed'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{armed ? 'Writes are permitted. Automations in Auto will act.' : 'Read-only. Nothing is written to the units.'}</div>
        </div>
      </div>
      {status?.lastError && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{status.lastError}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" variant={armed && mode === 'manual' ? 'primary' : 'secondary'} disabled={!canWrite || busy} onClick={() => onArm(true, 'manual')}>Arm · Manual</Button>
        <Button size="sm" variant={armed && mode === 'auto' ? 'primary' : 'secondary'} disabled={!canWrite || busy} onClick={() => onArm(true, 'auto')}>Arm · Auto</Button>
        <Button size="sm" variant="danger" disabled={!canWrite || busy || !armed} onClick={() => onArm(false, 'manual')}>Disarm</Button>
      </div>
      {!canWrite && <div style={{ fontSize: 11.5, color: 'var(--grid)' }}>Only an admin can arm device control.</div>}
    </Card>
  );
}

function RuleCard({ a, live, devData, canWrite, onSave, onDelete }: {
  a: Automation; live: LiveResponse | null; devData: DevicesResponse | null;
  canWrite: boolean; onSave: (patch: Partial<Automation>) => Promise<void>; onDelete: () => void;
}) {
  const [authority, setAuthority] = useState(a.authority);
  const [enabled, setEnabled] = useState(a.enabled);
  const [p, setP] = useState<SolarSurplusPrecoolParams>(a.params);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<SolarSurplusPrecoolParams>) => setP((prev) => ({ ...prev, ...patch }));

  const save = async () => { setBusy(true); try { await onSave({ enabled, authority, params: p }); setEditing(false); } finally { setBusy(false); } };
  const setAuthAndSave = (next: 'shadow' | 'auto') => { setAuthority(next); void onSave({ authority: next }); };

  const surplus = surplusKw(live);
  const soc = batterySoc(live);
  // Rooms warmer than the limit, split by whether they're included in automation.
  // The rule (and the coordinator) only act on included rooms — but a room being
  // *above the limit yet excluded* is the common "why is nothing happening?" case,
  // so surface it explicitly instead of pretending no room is above the limit.
  const aboveLimit = (devData?.devices ?? []).filter((d) => d.currentTempC != null && d.currentTempC > p.roomTempLimitC);
  const qualifying = aboveLimit.filter((d) => d.automationEnabled);
  const excluded = aboveLimit.filter((d) => !d.automationEnabled);
  const bandOn = p.bandRestrictionEnabled ?? true;

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {/* header — the shared automation row (same control as on the Devices hub) */}
      <AutomationRow
        automation={{ ...a, authority, enabled }}
        canWrite={canWrite}
        onSave={(patch) => {
          if (patch.authority) setAuthAndSave(patch.authority);
          if (patch.enabled !== undefined) { setEnabled(patch.enabled); void onSave({ enabled: patch.enabled }); }
        }}
      />

      {/* WHEN / DO / UNTIL / LIMITS */}
      <Block label="When" color="var(--battery)" wash="var(--battery-wash)">
        <Tok>solar surplus</Tok><span style={{ color: 'var(--text-3)' }}>&gt;</span><Tok>battery intake headroom</Tok>
        <span style={{ color: 'var(--text-3)' }}>and</span><Tok>room temp</Tok><span style={{ color: 'var(--text-3)' }}>&gt;</span><Tok color="var(--grid)">{p.roomTempLimitC.toFixed(1)}°</Tok>
      </Block>
      <Block label="Do" color="var(--solar)" wash="var(--solar-wash)">
        run <Tok>cool</Tok> in <Tok>matching rooms</Tok> at <Tok color="var(--solar)">{p.targetSetpointC.toFixed(1)}°</Tok>, <Tok>staggered ≤ 14 kW</Tok>
      </Block>
      <Block label="Until" color="var(--home)" wash="var(--home-wash)">
        surplus clears <span style={{ color: 'var(--text-3)' }}>for</span> <Tok>{p.surplusClearSec}s</Tok> <span style={{ color: 'var(--text-3)' }}>·or·</span> room reaches target
        {bandOn && (<><span style={{ color: 'var(--text-3)' }}>·or·</span> band <Tok color="var(--grid)">{p.exitBand}</Tok></>)}
      </Block>
      <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: '10px 14px' }}>
        <div className="pwr-eyebrow" style={{ marginBottom: 6 }}>Limits (always enforced)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Tok color="var(--text-2)">grid import ≤ 14 kW</Tok><Tok color="var(--text-2)">comfort ceiling</Tok><Tok color="var(--text-2)">min cycle 8 min</Tok>
        </div>
      </div>

      {/* LIVE PREVIEW */}
      <div style={{ background: 'var(--surface-2)', border: '1px solid rgba(46,230,160,0.2)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span className="pwr-eyebrow" style={{ color: 'var(--solar)' }}>Live preview · right now</span>
          <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>surplus <span style={{ color: surplus > 0 ? 'var(--solar)' : 'var(--text-3)' }}>+{surplus} kW</span>{soc != null ? ` · batteries ${soc}%` : ''}</span>
        </div>
        {qualifying.length > 0 ? (
          <>
            <div style={{ fontSize: 12.5, marginBottom: 8 }}>{qualifying.length} room{qualifying.length > 1 ? 's' : ''} qualify — would cool to {p.targetSetpointC.toFixed(1)}°:</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {qualifying.slice(0, 6).map((d) => (
                <span key={d.id} className="pwr-mono" style={{ fontSize: 11.5, background: 'var(--solar-wash)', color: 'var(--solar)', borderRadius: 8, padding: '5px 10px' }}>{d.name} · {d.currentTempC!.toFixed(1)}°→{p.targetSetpointC.toFixed(0)}°</span>
              ))}
            </div>
          </>
        ) : surplus <= 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            No solar surplus right now — rule is idle.{excluded.length > 0 ? ` (${excluded.length} room${excluded.length > 1 ? 's' : ''} above ${p.roomTempLimitC.toFixed(1)}°, but not included in automation.)` : ''}
          </div>
        ) : excluded.length > 0 ? (
          <>
            <div style={{ fontSize: 12.5, marginBottom: 8, color: 'var(--text-2)' }}>
              {excluded.length} room{excluded.length > 1 ? 's are' : ' is'} above {p.roomTempLimitC.toFixed(1)}° but not included in automation — open the device and tap “Include in automation” to let the rule pre-cool {excluded.length > 1 ? 'them' : 'it'}:
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {excluded.slice(0, 6).map((d) => (
                <span key={d.id} className="pwr-mono" style={{ fontSize: 11.5, background: 'var(--surface-3)', color: 'var(--grid)', borderRadius: 8, padding: '5px 10px' }}>{d.name} · {d.currentTempC!.toFixed(1)}° · excluded</span>
              ))}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>No rooms above the limit right now — nothing to pre-cool.</div>
        )}
      </div>

      {/* EDIT */}
      {canWrite && (
        <button type="button" onClick={() => setEditing((v) => !v)} style={{ alignSelf: 'flex-start', fontSize: 11.5, color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name={editing ? 'chevron-up' : 'sliders-horizontal'} size={14} /> {editing ? 'Hide settings' : 'Edit rule'}
        </button>
      )}
      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4, borderTop: '1px solid var(--border-1)' }}>
          <Slider label="Room above" unit="°C" min={20} max={30} step={0.5} value={p.roomTempLimitC} onChange={(v) => set({ roomTempLimitC: v })} />
          <Slider label="Cool to target" unit="°C" min={16} max={26} step={0.5} value={p.targetSetpointC} onChange={(v) => set({ targetSetpointC: v })} />
          <Slider label="Surplus must clear for" unit=" s" min={30} max={600} step={30} value={p.surplusClearSec} onChange={(v) => set({ surplusClearSec: v })} />
          <div>
            <div className="pwr-eyebrow" style={{ marginBottom: 6 }}>Price-band stand-down</div>
            <SegmentedControl
              size="sm"
              options={['Off', 'P1', 'P2', 'P3']}
              value={bandOn ? p.exitBand : 'Off'}
              onChange={(b) => (b === 'Off' ? set({ bandRestrictionEnabled: false }) : set({ bandRestrictionEnabled: true, exitBand: b as SolarSurplusPrecoolParams['exitBand'] }))}
            />
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5 }}>{bandOn ? `Stands down (and won't start) while the tariff is in ${p.exitBand}.` : 'Pre-cools in any tariff band, including P1 peak.'}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={onDelete}>Delete</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ============================================================================
 * Battery-priority rules — Sonnen-first discharge / Tesla-first charge. These are
 * battery-control policies (persisted in control state), so they ACT only when the
 * battery Autopilot is armed in Auto (on the Autopilot screen), independent of the
 * climate arm above. Each rule has its own enable + Shadow/Auto authority + a
 * throughput cap beyond which the OTHER battery is allowed to join in.
 * ==========================================================================*/

interface BatRuleMeta {
  key: BatteryPriorityKey;
  kind: 'discharge' | 'charge';
  title: string;
  icon: string;
  tone: string;
  wash: string;
}
const BAT_RULES: BatRuleMeta[] = [
  { key: 'dischargeSonnenFirst', kind: 'discharge', title: 'Discharge — Sonnen first', icon: 'battery-low', tone: 'var(--battery)', wash: 'var(--battery-wash)' },
  { key: 'chargeTeslaFirst', kind: 'charge', title: 'Charge — Tesla first', icon: 'battery-charging', tone: 'var(--solar)', wash: 'var(--solar-wash)' },
];

function BatteryRuleCard({ meta, rule, live, socFloorPct, canWrite, onSave }: {
  meta: BatRuleMeta; rule: BatteryPriorityRule; live: LiveResponse | null;
  socFloorPct: number; canWrite: boolean; onSave: (patch: Partial<BatteryPriorityRule>) => void;
}) {
  const [enabled, setEnabled] = useState(rule.enabled);
  const [authority, setAuthority] = useState(rule.authority);
  const [thr, setThr] = useState(rule.throughputKw);
  const [editing, setEditing] = useState(false);

  const setAuthAndSave = (next: 'shadow' | 'auto') => { setAuthority(next); onSave({ authority: next }); };
  const toggleEnabled = (on: boolean) => { setEnabled(on); onSave({ enabled: on }); };
  const saveThr = () => { onSave({ throughputKw: thr }); setEditing(false); };

  const sonnenSoc = live ? Math.round(live.sonnen.soc) : null;
  const teslaSoc = live ? Math.round(live.tesla.soc) : null;
  const importKw = live && live.grid.dir === 'importing' ? Math.round(live.grid.kw * 10) / 10 : 0;
  const exportKw = live && live.grid.dir === 'exporting' ? Math.round(live.grid.kw * 10) / 10 : 0;

  // Live preview — mirror the coordinator's decision so the UI shows what WOULD happen.
  let preview = 'Connecting to live data…';
  let active = false;
  if (live && sonnenSoc != null && teslaSoc != null) {
    if (meta.kind === 'discharge') {
      if (exportKw > 0.2) preview = `Solar surplus now (+${exportKw} kW) — discharge priority idle.`;
      else if (sonnenSoc <= socFloorPct) preview = `Sonnen ${sonnenSoc}% at floor — Tesla released to share the load.`;
      else if (importKw > thr) preview = `Grid import ${importKw} kW > ${thr} kW — Tesla joins in.`;
      else { active = true; preview = `Would hold Tesla at ~${teslaSoc}% — Sonnen covers the house first.`; }
    } else {
      if (exportKw <= 0.2) preview = 'No solar surplus now — charge priority idle.';
      else if (teslaSoc >= 100) preview = 'Tesla full — Sonnen free to charge.';
      else if (exportKw > thr) preview = `Surplus ${exportKw} kW > ${thr} kW — Sonnen joins in.`;
      else { active = true; preview = `Would idle Sonnen — Tesla charges first (${teslaSoc}%).`; }
    }
  }

  const whenDo = meta.kind === 'discharge'
    ? { when: <><Tok>house drawing</Tok><span style={{ color: 'var(--text-3)' }}>and</span><Tok>Sonnen &gt; floor</Tok></>,
        doIt: <>discharge <Tok color="var(--battery)">Sonnen</Tok> first · keep <Tok color="var(--ev)">Tesla</Tok> full for backup</>,
        until: <>grid import <span style={{ color: 'var(--text-3)' }}>&gt;</span> <Tok>{thr} kW</Tok> <span style={{ color: 'var(--text-3)' }}>·or·</span> Sonnen hits floor <span style={{ color: 'var(--text-3)' }}>→</span> Tesla joins</> }
    : { when: <><Tok>solar surplus</Tok><span style={{ color: 'var(--text-3)' }}>and</span><Tok>Tesla not full</Tok></>,
        doIt: <>charge <Tok color="var(--ev)">Tesla</Tok> first · restore backup capacity</>,
        until: <>surplus <span style={{ color: 'var(--text-3)' }}>&gt;</span> <Tok>{thr} kW</Tok> <span style={{ color: 'var(--text-3)' }}>·or·</span> Tesla full <span style={{ color: 'var(--text-3)' }}>→</span> Sonnen joins</> };

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name={meta.icon} size={19} color={meta.tone} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{meta.title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Automation · battery</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" disabled={!canWrite} onClick={() => setAuthAndSave('shadow')} style={{ fontSize: 11, padding: '5px 11px', borderRadius: 8, cursor: canWrite ? 'pointer' : 'default', border: '1px solid var(--border-1)', background: authority === 'shadow' ? 'var(--surface-3)' : 'transparent', color: authority === 'shadow' ? 'var(--text-1)' : 'var(--text-3)', fontWeight: 600 }}>Shadow</button>
          <button type="button" disabled={!canWrite} onClick={() => setAuthAndSave('auto')} style={{ fontSize: 11, padding: '5px 11px', borderRadius: 8, cursor: canWrite ? 'pointer' : 'default', border: 'none', background: authority === 'auto' ? 'var(--solar)' : 'var(--surface-3)', color: authority === 'auto' ? '#06090b' : 'var(--text-3)', fontWeight: 600 }}>Auto</button>
          <Switch checked={enabled} disabled={!canWrite} onChange={(e) => toggleEnabled(e.target.checked)} />
        </div>
      </div>

      {/* WHEN / DO / UNTIL */}
      <Block label="When" color="var(--battery)" wash="var(--battery-wash)">{whenDo.when}</Block>
      <Block label="Do" color={meta.tone} wash={meta.wash}>{whenDo.doIt}</Block>
      <Block label="Until" color="var(--home)" wash="var(--home-wash)">{whenDo.until}</Block>

      {/* LIVE PREVIEW */}
      <div style={{ background: 'var(--surface-2)', border: `1px solid ${active ? meta.tone : 'var(--border-1)'}`, borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span className="pwr-eyebrow" style={{ color: active ? meta.tone : 'var(--text-3)' }}>Live preview · right now</span>
          <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>
            {meta.kind === 'discharge' ? (importKw > 0 ? `import ${importKw} kW` : 'no import') : (exportKw > 0 ? `+${exportKw} kW` : 'no surplus')}
            {sonnenSoc != null ? ` · S ${sonnenSoc}%` : ''}{teslaSoc != null ? ` · T ${teslaSoc}%` : ''}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: active ? 'var(--text-1)' : 'var(--text-2)' }}>{preview}</div>
      </div>

      {/* EDIT */}
      {canWrite && (
        <button type="button" onClick={() => setEditing((v) => !v)} style={{ alignSelf: 'flex-start', fontSize: 11.5, color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name={editing ? 'chevron-up' : 'sliders-horizontal'} size={14} /> {editing ? 'Hide settings' : 'Edit rule'}
        </button>
      )}
      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4, borderTop: '1px solid var(--border-1)' }}>
          <Slider label={meta.kind === 'discharge' ? 'Sonnen-only until grid import exceeds' : 'Tesla-only until surplus exceeds'} unit=" kW" min={0} max={14} step={0.5} value={thr} onChange={(v) => setThr(v)} />
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {meta.kind === 'discharge'
              ? `The Sonnen carries the house alone; once grid import climbs past ${thr} kW (it can't keep up) the Tesla joins to discharge.`
              : `The Tesla absorbs the surplus alone; once surplus exceeds ${thr} kW (it can't keep up) the Sonnen joins to charge.`}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" disabled={thr === rule.throughputKw} onClick={saveThr}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setThr(rule.throughputKw); setEditing(false); }}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function Automations({ ctx }: { ctx: ShellContext }) {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, stale, updatedAt, refetch } = usePolling<AutomationsResponse>(api.automations.list, 0);
  const { data: status, refetch: refetchStatus } = usePolling<DevicesStatus>(api.devices.status, 20_000);
  const { data: devData } = usePolling<DevicesResponse>(api.devices.list, 20_000);
  const { data: live } = usePolling<LiveResponse>(api.live, 20_000);
  const { data: ctrl, refetch: refetchCtrl } = usePolling<ControlStatus>(api.control.status, 20_000);
  const [busy, setBusy] = useState(false);

  const automations = data?.automations ?? [];
  const bp = ctrl?.batteryPriority ?? null;
  const socFloorPct = ctrl?.guardrails.socFloorPct ?? 10;
  const batteryArmedAuto = !!ctrl?.armed && ctrl.mode === 'auto';

  const onArm = async (armed: boolean, mode: 'auto' | 'manual') => {
    setBusy(true);
    try { await api.devices.arm(armed, mode); } catch { /* ignore */ } finally { setBusy(false); refetchStatus(); }
  };
  const saveAuto = async (id: string, patch: Partial<Automation>) => { await api.automations.update(id, patch); refetch(); };
  const addAuto = async () => { await api.automations.create({ name: 'Solar-surplus pre-cool', type: 'solar_surplus_precool' }); refetch(); };
  const removeAuto = async (id: string) => { await api.automations.remove(id); refetch(); };
  const saveBatteryRule = async (key: BatteryPriorityKey, patch: Partial<BatteryPriorityRule>) => {
    try { await api.control.batteryPriority(key, patch); } catch { /* ignore */ } finally { refetchCtrl(); }
  };

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      {/* ---- Battery priority ---- */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginTop: 2 }}>
        <Eyebrow>Battery</Eyebrow>
        <span style={{ fontSize: 11, color: batteryArmedAuto ? 'var(--solar)' : 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name={batteryArmedAuto ? 'shield-check' : 'shield-off'} size={13} />
          {batteryArmedAuto ? 'Autopilot armed · Auto' : 'Acts when Autopilot is in Auto'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--battery-wash)', border: '1px solid rgba(64,160,255,0.18)', borderRadius: 'var(--radius-md)', padding: '9px 13px' }}>
        <Icon name="info" size={15} color="var(--battery)" />
        <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
          The Tesla is kept full for backup (the Sonnen has no backup mode). These rules run in the battery coordinator — <strong style={{ color: 'var(--text-1)' }}>Shadow</strong> only logs intended actions; flip to <strong style={{ color: 'var(--text-1)' }}>Auto</strong> and arm <Link to="/brain" style={{ color: 'var(--battery)' }}>Autopilot</Link> (Auto) to let them act.
        </span>
      </div>
      {bp
        ? BAT_RULES.map((m) => (
            <BatteryRuleCard key={m.key} meta={m} rule={bp[m.key]} live={live ?? null} socFloorPct={socFloorPct} canWrite={!!canWrite} onSave={(patch) => void saveBatteryRule(m.key, patch)} />
          ))
        : <Card padded style={{ color: 'var(--text-3)', fontSize: 12.5 }}>Connecting to the battery control plane…</Card>}

      {/* ---- Climate ---- */}
      <Eyebrow>Climate</Eyebrow>
      <ArmCard status={status ?? null} canWrite={!!canWrite} onArm={(a, m) => void onArm(a, m)} busy={busy} />
      {devData && !devData.connected && (
        <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)', flex: 'none' }}><Icon name="cloud-off" size={16} /></span>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>AC Cloud is not connected — automations have nothing to act on until you connect it in Settings.</div>
        </Card>
      )}
      {automations.map((a) => (
        <RuleCard key={a.id} a={a} live={live ?? null} devData={devData ?? null} canWrite={!!canWrite} onSave={(patch) => saveAuto(a.id, patch)} onDelete={() => void removeAuto(a.id)} />
      ))}
      {canWrite && <Button variant="secondary" iconLeft={<Icon name="plus" size={16} />} onClick={() => void addAuto()}>New automation</Button>}
    </div>
  );

  if (wide) return <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, margin: '0 auto', width: '100%' }}><div><Eyebrow>Power</Eyebrow><h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-.01em', margin: '2px 0 0' }}>Automations</h1></div>{list}</div>;
  return (<><MobileHeader eyebrow="Power" title="Automations" right={<Avatar />} /><div style={{ padding: '8px 14px 22px' }}>{list}</div></>);
}
