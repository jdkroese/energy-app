import { useState } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type {
  Automation,
  AutomationsResponse,
  DevicesResponse,
  DevicesStatus,
  SolarSurplusPrecoolParams,
} from '../lib/types';
import { Card, Icon, Button, Switch, Input, SegmentedControl, Badge, Eyebrow, Slider } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Automations (/automations) — the WHEN / DO / UNTIL / LIMITS builder for the
 * flagship solar_surplus_precool rule, plus the master arm control for the whole
 * device-control layer (boots DISARMED). Shadow vs Auto authority is per rule.
 * Live preview narrates exactly what the rule will do. Admin-gated writes.
 * ==========================================================================*/

function relTime(ts: number | null): string {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function ArmCard({
  status,
  canWrite,
  onArm,
  busy,
}: {
  status: DevicesStatus | null;
  canWrite: boolean;
  onArm: (armed: boolean, mode: 'auto' | 'manual') => void;
  busy: boolean;
}) {
  const armed = status?.armed ?? false;
  const mode = status?.mode ?? 'off';
  return (
    <Card accent={armed ? 'solar' : 'grid'} glow padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: armed ? 'var(--solar-wash)' : 'var(--grid-wash)', color: armed ? 'var(--solar)' : 'var(--grid)', flex: 'none' }}>
          <Icon name={armed ? 'shield-check' : 'shield-off'} size={19} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Climate control · {armed ? (mode === 'auto' ? 'Auto' : 'Manual') : 'Disarmed'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {armed ? 'Writes are permitted. Automations in Auto will act.' : 'Read-only. Nothing is ever written to the units.'}
          </div>
        </div>
      </div>
      {status?.lastError && (
        <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{status.lastError}</div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" variant={armed && mode === 'manual' ? 'primary' : 'secondary'} disabled={!canWrite || busy} onClick={() => onArm(true, 'manual')}>Arm · Manual</Button>
        <Button size="sm" variant={armed && mode === 'auto' ? 'primary' : 'secondary'} disabled={!canWrite || busy} onClick={() => onArm(true, 'auto')}>Arm · Auto</Button>
        <Button size="sm" variant="danger" disabled={!canWrite || busy || !armed} onClick={() => onArm(false, 'manual')}>Disarm</Button>
      </div>
      {!canWrite && <div style={{ fontSize: 11.5, color: 'var(--grid)' }}>Only an admin can arm device control.</div>}
    </Card>
  );
}

function PreviewLine({ p, authority }: { p: SolarSurplusPrecoolParams; authority: 'shadow' | 'auto' }) {
  return (
    <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
      <strong style={{ color: 'var(--text-1)' }}>WHEN</strong> a room is above{' '}
      <span style={{ color: 'var(--grid)', fontFamily: 'var(--font-mono)' }}>{p.roomTempLimitC}°C</span> and solar surplus exceeds battery intake{' '}
      (≥ <span style={{ fontFamily: 'var(--font-mono)' }}>{p.startThresholdW ?? 800} W</span>),{' '}
      <strong style={{ color: 'var(--text-1)' }}>DO</strong> cool that room to{' '}
      <span style={{ color: 'var(--solar)', fontFamily: 'var(--font-mono)' }}>{p.targetSetpointC}°C</span>,{' '}
      staggering compressors under the 14 kW cap.{' '}
      <strong style={{ color: 'var(--text-1)' }}>UNTIL</strong> surplus clears for{' '}
      <span style={{ fontFamily: 'var(--font-mono)' }}>{p.surplusClearSec}s</span>, the room hits target, or the band turns{' '}
      <span style={{ color: 'var(--grid)', fontFamily: 'var(--font-mono)' }}>{p.exitBand}</span>.{' '}
      {authority === 'shadow' ? (
        <Badge tone="neutral" variant="soft" icon={<Icon name="eye" size={11} />}>Shadow — logs only</Badge>
      ) : (
        <Badge tone="solar" variant="soft" icon={<Icon name="zap" size={11} />}>Auto — will act when armed</Badge>
      )}
    </div>
  );
}

function AutomationBuilder({
  a,
  canWrite,
  onSave,
  onDelete,
}: {
  a: Automation;
  canWrite: boolean;
  onSave: (patch: Partial<Automation>) => Promise<void>;
  onDelete: () => void;
}) {
  const [name, setName] = useState(a.name);
  const [enabled, setEnabled] = useState(a.enabled);
  const [authority, setAuthority] = useState(a.authority);
  const [p, setP] = useState<SolarSurplusPrecoolParams>(a.params);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<SolarSurplusPrecoolParams>) => setP((prev) => ({ ...prev, ...patch }));

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ name, enabled, authority, params: p });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--battery-wash)', color: 'var(--battery)', flex: 'none' }}>
          <Icon name="workflow" size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Input value={name} disabled={!canWrite} onChange={(e) => setName(e.target.value)} />
        </div>
        <Switch checked={enabled} disabled={!canWrite} onChange={(e) => setEnabled(e.target.checked)} />
      </div>

      <PreviewLine p={p} authority={authority} />

      {/* WHEN */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, borderTop: '1px solid var(--border-1)' }}>
        <Eyebrow>When · trigger</Eyebrow>
        <Slider label="Room above" unit="°C" min={20} max={30} step={0.5} value={p.roomTempLimitC} onChange={(v) => canWrite && set({ roomTempLimitC: v })} />
        <Slider label="Surplus start threshold" unit=" W" min={0} max={3000} step={100} value={p.startThresholdW ?? 800} onChange={(v) => canWrite && set({ startThresholdW: v })} />
      </div>

      {/* DO */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Eyebrow>Do · action</Eyebrow>
        <Slider label="Cool to target" unit="°C" min={16} max={26} step={0.5} value={p.targetSetpointC} onChange={(v) => canWrite && set({ targetSetpointC: v })} />
      </div>

      {/* UNTIL */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Eyebrow>Until · stop</Eyebrow>
        <Slider label="Surplus must clear for" unit=" s" min={30} max={600} step={30} value={p.surplusClearSec} onChange={(v) => canWrite && set({ surplusClearSec: v })} />
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>Exit band</div>
          <SegmentedControl size="sm" options={['P1', 'P2', 'P3']} value={p.exitBand} onChange={(b) => canWrite && set({ exitBand: b as SolarSurplusPrecoolParams['exitBand'] })} />
        </div>
      </div>

      {/* LIMITS / authority */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Eyebrow>Authority</Eyebrow>
        <SegmentedControl
          size="sm"
          block
          options={[
            { value: 'shadow', label: 'Shadow (log only)' },
            { value: 'auto', label: 'Auto (act)' },
          ]}
          value={authority}
          onChange={(v) => canWrite && setAuthority(v as 'shadow' | 'auto')}
        />
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          Compressor starts are always staggered under the 14 kW import cap; setpoints clamp to 16–30°C and per-room comfort bounds.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Last evaluated {relTime(a.lastEval)}</span>
        {canWrite && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={onDelete}>Delete</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function Automations({ ctx }: { ctx: ShellContext }) {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, stale, updatedAt, refetch } = usePolling<AutomationsResponse>(api.automations.list, 0);
  const { data: status, refetch: refetchStatus } = usePolling<DevicesStatus>(api.devices.status, 20_000);
  // Surface whether AC Cloud is connected (so we can warn before arming).
  const { data: devData } = usePolling<DevicesResponse>(api.devices.list, 0);
  const [busy, setBusy] = useState(false);

  const automations = data?.automations ?? [];

  const onArm = async (armed: boolean, mode: 'auto' | 'manual') => {
    setBusy(true);
    try {
      await api.devices.arm(armed, mode);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
      refetchStatus();
    }
  };

  const saveAuto = async (id: string, patch: Partial<Automation>) => {
    await api.automations.update(id, patch);
    refetch();
  };
  const addAuto = async () => {
    await api.automations.create({ name: 'Solar-surplus pre-cool', type: 'solar_surplus_precool' });
    refetch();
  };
  const removeAuto = async (id: string) => {
    await api.automations.remove(id);
    refetch();
  };

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 16 : 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      <ArmCard status={status ?? null} canWrite={!!canWrite} onArm={(a, m) => void onArm(a, m)} busy={busy} />
      {devData && !devData.connected && (
        <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)', flex: 'none' }}>
            <Icon name="cloud-off" size={16} />
          </span>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            AC Cloud is not connected — automations have nothing to act on until you connect it in Settings.
          </div>
        </Card>
      )}
      {automations.map((a) => (
        <AutomationBuilder
          key={a.id}
          a={a}
          canWrite={!!canWrite}
          onSave={(patch) => saveAuto(a.id, patch)}
          onDelete={() => void removeAuto(a.id)}
        />
      ))}
      {canWrite && (
        <Button variant="secondary" iconLeft={<Icon name="plus" size={16} />} onClick={() => void addAuto()}>
          New automation
        </Button>
      )}
    </div>
  );

  if (wide) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, margin: '0 auto', width: '100%' }}>
        <div><Eyebrow>Climate</Eyebrow><h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '2px 0 0' }}>Automations</h1></div>
        {list}
      </div>
    );
  }
  return (
    <>
      <MobileHeader eyebrow="Climate" title="Automations" right={<Avatar />} />
      <div style={{ padding: '8px 14px 22px' }}>{list}</div>
    </>
  );
}
