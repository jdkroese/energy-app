import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { DeviceDetailResponse, ClimateLever } from '../lib/types';
import { Card, Icon, Button, IconButton, Badge, StatusDot, SegmentedControl, Switch, Eyebrow } from '../components/ui';
import { StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * DeviceDetail (/devices/:id) — the per-unit control page. Big setpoint stepper,
 * mode + fan segmented controls, room-temp readout, governing automation note,
 * and an automation-enable toggle. All writes are admin + arm gated server-side;
 * the UI disables controls when not permitted and explains why.
 * ==========================================================================*/

const MODES = [
  { value: 'cool', label: 'Cool', icon: <Icon name="snowflake" size={14} /> },
  { value: 'heat', label: 'Heat', icon: <Icon name="flame" size={14} /> },
  { value: 'dry', label: 'Dry', icon: <Icon name="droplet" size={14} /> },
  { value: 'fan', label: 'Fan', icon: <Icon name="fan" size={14} /> },
  { value: 'auto', label: 'Auto', icon: <Icon name="sparkles" size={14} /> },
];

const FANS = [
  { value: '0', label: 'Auto' },
  { value: '1', label: 'Low' },
  { value: '2', label: 'Med' },
  { value: '3', label: 'High' },
];

export function DeviceDetail({ ctx }: { ctx: ShellContext }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt, refetch } = usePolling<DeviceDetailResponse>(
    () => api.devices.detail(id ?? ''),
    15_000,
    [id],
  );
  const [busy, setBusy] = useState(false);
  // Optimistic setpoint while a write is in flight.
  const [pendingSetpoint, setPendingSetpoint] = useState<number | null>(null);

  const dev = data?.device ?? null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      /* keep last-good */
    } finally {
      setBusy(false);
      setPendingSetpoint(null);
      refetch();
    }
  };

  const cmd = (lever: ClimateLever, value: boolean | number | string) =>
    run(() => api.devices.command(id ?? '', lever, value));

  if (!dev) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto', width: '100%', padding: wide ? 0 : '16px 14px' }}>
        <Card padded style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', padding: 28 }}>
          <Icon name="thermometer" size={26} color="var(--text-3)" />
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {loading ? 'Loading device…' : data && !data.connected ? 'AC Cloud not connected' : 'Device not found'}
          </div>
          <Button variant="secondary" iconLeft={<Icon name="chevron-left" size={15} />} onClick={() => nav('/devices')}>
            Back to devices
          </Button>
        </Card>
      </div>
    );
  }

  // Detail doesn't fetch arm state; the server still gates every write on
  // armed + admin, so the UI optimistically enables for admins and surfaces
  // any rejection via the (kept-last-good) refetch.
  const canWrite = isAdmin;
  const setpoint = pendingSetpoint ?? dev.setpointC ?? 24;
  const lo = Math.max(16, dev.minSetpointC ?? 16, dev.comfortFloorC ?? 16);
  const hi = Math.min(30, dev.maxSetpointC ?? 30, dev.comfortCeilingC ?? 30);

  const step = (delta: number) => {
    const next = Math.min(hi, Math.max(lo, Math.round((setpoint + delta) * 2) / 2));
    setPendingSetpoint(next);
    void cmd('setpoint', next);
  };

  const toggleAutomation = (on: boolean) =>
    run(() => api.devices.setSettings(id ?? '', { automationEnabled: on }));

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', width: '100%', padding: wide ? 0 : '8px 14px 22px', display: 'flex', flexDirection: 'column', gap: wide ? 16 : 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: wide ? 0 : 8 }}>
        <IconButton variant="solid" aria-label="Back" onClick={() => nav('/devices')}>
          <Icon name="chevron-left" size={18} />
        </IconButton>
        <span style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: dev.power ? 'var(--solar-wash)' : 'var(--surface-3)', color: dev.power ? 'var(--solar)' : 'var(--text-3)', flex: 'none' }}>
          <Icon name="thermometer" size={21} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-.02em', margin: 0 }}>{dev.name}</h1>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{dev.room}{dev.installation ? ` · ${dev.installation}` : ''}</div>
        </div>
        <StatusDot tone={dev.online ? 'battery' : 'offline'} live={dev.online}>{dev.online ? 'Online' : 'Offline'}</StatusDot>
      </div>

      {stale && <StaleBanner updatedAt={updatedAt} />}

      {/* HERO — room temp + setpoint stepper + power */}
      <Card accent="solar" glow padded style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Eyebrow>Room temperature</Eyebrow>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 44, fontWeight: 600, lineHeight: 1 }}>
              {dev.currentTempC != null ? dev.currentTempC.toFixed(1) : '—'}<span style={{ fontSize: 22, color: 'var(--text-2)' }}>°C</span>
            </span>
          </div>
          <div style={{ flex: 1 }} />
          <Button
            variant={dev.power ? 'secondary' : 'primary'}
            disabled={!canWrite || busy}
            iconLeft={<Icon name={dev.power ? 'power-off' : 'power'} size={16} />}
            onClick={() => cmd('power', !dev.power)}
          >
            {dev.power ? 'Turn off' : 'Turn on'}
          </Button>
        </div>

        {/* Setpoint stepper */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 22, padding: '6px 0' }}>
          <IconButton variant="solid" aria-label="Lower setpoint" disabled={!canWrite || busy || setpoint <= lo} onClick={() => step(-0.5)}>
            <Icon name="minus" size={20} />
          </IconButton>
          <div style={{ textAlign: 'center', minWidth: 120 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 40, fontWeight: 600, color: 'var(--solar)' }}>
              {setpoint.toFixed(1)}°
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>target · {lo}–{hi}°C</div>
          </div>
          <IconButton variant="solid" aria-label="Raise setpoint" disabled={!canWrite || busy || setpoint >= hi} onClick={() => step(0.5)}>
            <Icon name="plus" size={20} />
          </IconButton>
        </div>

        {!canWrite && (
          <div style={{ fontSize: 11.5, color: 'var(--grid)', textAlign: 'center' }}>
            Read-only — only an admin can command devices, and control must be armed.
          </div>
        )}
      </Card>

      {/* MODE + FAN */}
      <Card title="Mode & fan" icon={<Icon name="sliders-horizontal" />}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>Mode</div>
            <SegmentedControl
              size="sm"
              block
              options={MODES}
              value={dev.mode}
              onChange={(m) => canWrite && cmd('mode', m)}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>Fan speed</div>
            <SegmentedControl
              size="sm"
              block
              options={FANS}
              onChange={(f) => canWrite && cmd('fan', Number(f))}
            />
          </div>
        </div>
      </Card>

      {/* GOVERNING automation/schedule */}
      <Card title="Governance" subtitle="Schedules & automations affecting this unit" icon={<Icon name="workflow" />}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--battery-wash)', color: 'var(--battery)', flex: 'none' }}>
              <Icon name="sparkles" size={16} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14 }}>Automations</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {dev.automationEnabled ? 'This room may be pre-cooled on solar surplus' : 'Excluded from automations'}
              </div>
            </div>
            <Switch checked={dev.automationEnabled} disabled={!canWrite || busy} onChange={(e) => void toggleAutomation(e.target.checked)} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 10, borderTop: '1px solid var(--border-1)' }}>
            {(data?.schedules ?? []).filter((s) => s.scope.deviceIds.includes(dev.id)).map((s) => (
              <Badge key={s.id} tone={s.enabled ? 'solar' : 'neutral'} variant="soft" icon={<Icon name="calendar-clock" size={11} />}>{s.name}</Badge>
            ))}
            {(data?.schedules ?? []).filter((s) => s.scope.deviceIds.includes(dev.id)).length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>No schedules cover this unit.</span>
            )}
            <Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} iconLeft={<Icon name="calendar-clock" size={14} />} onClick={() => nav('/schedules')}>
              Schedules
            </Button>
            <Button size="sm" variant="ghost" iconLeft={<Icon name="workflow" size={14} />} onClick={() => nav('/automations')}>
              Automations
            </Button>
          </div>
        </div>
      </Card>

      {/* ADVANCED */}
      <Card title="Advanced" icon={<Icon name="settings-2" />}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 22px', fontSize: 13 }}>
          <Row label="Comfort ceiling" value={dev.comfortCeilingC != null ? `${dev.comfortCeilingC}°C` : '—'} />
          <Row label="Comfort floor" value={dev.comfortFloorC != null ? `${dev.comfortFloorC}°C` : '—'} />
          <Row label="Device range" value={`${dev.minSetpointC ?? 16}–${dev.maxSetpointC ?? 30}°C`} />
          <Row label="Installation" value={dev.installation ?? '—'} />
        </div>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '2px 0' }}>
      <span style={{ color: 'var(--text-2)' }}>{label}</span>
      <span style={{ color: 'var(--text-1)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>{value}</span>
    </div>
  );
}
