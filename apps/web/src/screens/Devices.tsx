import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { DeviceView, DevicesResponse, DeviceWarmth, ClimateLever } from '../lib/types';
import { Card, StatTile, Badge, Icon, Button, SegmentedControl } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Devices — climate fleet overview. Context strip (indoor avg, surplus proxy,
 * band), a smart banner, a multi-select bulk action bar, and a tappable row per
 * AC unit. Clones the altitude + Power DS tokens from Batteries. Generic device
 * layer: AC is the first type. Writes are admin + arm gated server-side.
 * ==========================================================================*/

const MODE_ICON: Record<string, string> = {
  cool: 'snowflake',
  heat: 'flame',
  dry: 'droplet',
  fan: 'fan',
  auto: 'sparkles',
  unknown: 'minus',
};

const WARMTH_COLOR: Record<DeviceWarmth, string> = {
  cold: 'var(--battery)',
  cool: 'var(--battery)',
  comfortable: 'var(--solar)',
  warm: 'var(--grid)',
  hot: 'var(--danger)',
  unknown: 'var(--text-3)',
};

function tempStr(t: number | null): string {
  return t == null ? '—' : `${t.toFixed(1)}°`;
}

function StatePill({ on }: { on: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 9px',
        borderRadius: 'var(--radius-pill)',
        background: on ? 'var(--solar-wash)' : 'var(--surface-3)',
        color: on ? 'var(--solar)' : 'var(--text-3)',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <Icon name={on ? 'power' : 'power-off'} size={13} />
      {on ? 'On' : 'Off'}
    </span>
  );
}

function DeviceRow({
  d,
  selected,
  selectMode,
  onToggleSelect,
  onOpen,
}: {
  d: DeviceView;
  selected: boolean;
  selectMode: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
}) {
  return (
    <Card
      interactive
      padded
      onClick={selectMode ? onToggleSelect : onOpen}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        cursor: 'pointer',
        outline: selected ? '2px solid var(--solar)' : undefined,
      }}
    >
      {selectMode && (
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            display: 'grid',
            placeItems: 'center',
            border: selected ? 'none' : '1.5px solid var(--border-2)',
            background: selected ? 'var(--solar)' : 'transparent',
            color: '#06090b',
            flex: 'none',
          }}
        >
          {selected && <Icon name="check" size={14} />}
        </span>
      )}
      <span
        style={{
          width: 38,
          height: 38,
          borderRadius: 11,
          display: 'grid',
          placeItems: 'center',
          background: d.power ? 'var(--solar-wash)' : 'var(--surface-3)',
          color: d.power ? 'var(--solar)' : 'var(--text-3)',
          flex: 'none',
        }}
      >
        <Icon name={MODE_ICON[d.mode] ?? 'thermometer'} size={20} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-.01em', display: 'flex', alignItems: 'center', gap: 8 }}>
          {d.name}
          {d.automationEnabled && (
            <span title="Automation enabled" style={{ color: 'var(--battery)', display: 'inline-flex' }}>
              <Icon name="sparkles" size={13} />
            </span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {d.room}
          {d.power && d.setpointC != null && (
            <>
              {' '}· <span style={{ fontFamily: 'var(--font-mono)' }}>{d.mode}</span> → {d.setpointC.toFixed(1)}°
            </>
          )}
        </div>
      </div>
      <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 19, fontWeight: 600, color: WARMTH_COLOR[d.warmth] }}>
          {tempStr(d.currentTempC)}
        </span>
        <StatePill on={d.power} />
      </div>
    </Card>
  );
}

function ContextStrip({ d, wide }: { d: DevicesResponse; wide: boolean }) {
  return (
    <Card accent="solar" glow padded style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(4,1fr)' : '1fr 1fr', gap: 12 }}>
      <StatTile size="sm" label="Indoor avg" value={d.context.indoorAvgC != null ? d.context.indoorAvgC.toFixed(1) : '—'} unit="°C" tone="solar" icon={<Icon name="thermometer" />} />
      <StatTile size="sm" label="Units on" value={`${d.context.onCount}`} unit={`/ ${d.context.deviceCount}`} tone="battery" icon={<Icon name="power" />} />
      <StatTile size="sm" label="Band" value={d.context.band} tone="neutral" icon={<Icon name="zap" />} footnote={d.context.band === 'P1' ? 'peak' : d.context.band === 'P3' ? 'valley' : 'standard'} />
      <StatTile
        size="sm"
        label="Control"
        value={d.armed ? (d.mode === 'auto' ? 'Auto' : 'Manual') : 'Disarmed'}
        tone={d.armed ? 'solar' : 'neutral'}
        icon={<Icon name={d.armed ? 'shield-check' : 'shield-off'} />}
      />
    </Card>
  );
}

function SmartBanner({ d }: { d: DevicesResponse }) {
  if (!d.connected) {
    return (
      <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)', flex: 'none' }}>
          <Icon name="cloud-off" size={16} />
        </span>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
          AC Cloud is not connected. Add your account in <strong style={{ color: 'var(--text-1)' }}>Settings → Connect AC Cloud</strong> to see and control the Panasonic units.
        </div>
      </Card>
    );
  }
  const hot = d.devices.filter((x) => x.warmth === 'hot' || x.warmth === 'warm').length;
  const msg = !d.armed
    ? 'Device control is disarmed — the fleet is read-only. Arm it in Automations to allow writes.'
    : hot > 0
      ? `${hot} room${hot > 1 ? 's are' : ' is'} running warm. During solar surplus, pre-cool can spend it instead of exporting.`
      : 'All rooms are comfortable. Climate control is armed and watching for solar surplus.';
  return (
    <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--solar-wash)', color: 'var(--solar)', flex: 'none' }}>
        <Icon name="sparkles" size={16} />
      </span>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>{msg}</div>
    </Card>
  );
}

function BulkBar({
  count,
  isAdmin,
  armed,
  onPower,
  onMode,
  onStep,
  onClear,
  busy,
}: {
  count: number;
  isAdmin: boolean;
  armed: boolean;
  onPower: (on: boolean) => void;
  onMode: (mode: string) => void;
  onStep: (delta: number) => void;
  onClear: () => void;
  busy: boolean;
}) {
  const disabled = !isAdmin || !armed || busy;
  return (
    <Card accent="battery" padded style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Badge tone="battery" variant="soft" icon={<Icon name="check-check" size={12} />}>{count} selected</Badge>
        {!armed && <span style={{ fontSize: 11.5, color: 'var(--grid)' }}>control disarmed</span>}
        {!isAdmin && <span style={{ fontSize: 11.5, color: 'var(--grid)' }}>admin only</span>}
        <Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }} onClick={onClear}>Clear</Button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" variant="primary" disabled={disabled} iconLeft={<Icon name="power" size={14} />} onClick={() => onPower(true)}>On</Button>
        <Button size="sm" variant="secondary" disabled={disabled} iconLeft={<Icon name="power-off" size={14} />} onClick={() => onPower(false)}>Off</Button>
        <Button size="sm" variant="secondary" disabled={disabled} iconLeft={<Icon name="minus" size={14} />} onClick={() => onStep(-0.5)}>−0.5°</Button>
        <Button size="sm" variant="secondary" disabled={disabled} iconLeft={<Icon name="plus" size={14} />} onClick={() => onStep(0.5)}>+0.5°</Button>
      </div>
      <div style={{ maxWidth: 320 }}>
        <SegmentedControl
          size="sm"
          block
          options={[
            { value: 'cool', label: 'Cool' },
            { value: 'fan', label: 'Fan' },
            { value: 'dry', label: 'Dry' },
            { value: 'heat', label: 'Heat' },
          ]}
          onChange={(m) => !disabled && onMode(m)}
        />
      </div>
    </Card>
  );
}

export function Devices({ ctx }: { ctx: ShellContext }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt, refetch } = usePolling<DevicesResponse>(api.devices.list, 20_000);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const d = data;
  const selectMode = selected.size > 0;

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      /* surfaced via stale/refetch */
    } finally {
      setBusy(false);
      refetch();
    }
  };

  const ids = () => [...selected];
  const bulk = (lever: ClimateLever, value: boolean | number | string) =>
    run(() => api.devices.bulkCommand(ids(), lever, value));

  const onStep = (delta: number) => {
    if (!d) return;
    // Apply a relative step per device by computing each device's new setpoint.
    void run(async () => {
      for (const id of ids()) {
        const dev = d.devices.find((x) => x.id === id);
        const base = dev?.setpointC ?? 24;
        await api.devices.command(id, 'setpoint', Math.round((base + delta) * 2) / 2);
      }
    });
  };

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 16 : 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      {!d && loading && <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading devices…</Card>}
      {d && (
        <>
          <ContextStrip d={d} wide={wide} />
          <SmartBanner d={d} />
          {selectMode && (
            <BulkBar
              count={selected.size}
              isAdmin={isAdmin}
              armed={d.armed}
              busy={busy}
              onPower={(on) => bulk('power', on)}
              onMode={(m) => bulk('mode', m)}
              onStep={onStep}
              onClear={() => setSelected(new Set())}
            />
          )}
          {d.connected && d.devices.length > 0 && !selectMode && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button size="sm" variant="ghost" iconLeft={<Icon name="check-check" size={14} />} onClick={() => d.devices[0] && toggleSelect(d.devices[0].id)}>
                Select
              </Button>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1fr' : '1fr', gap: wide ? 14 : 10 }}>
            {d.devices.map((dev) => (
              <DeviceRow
                key={dev.id}
                d={dev}
                selected={selected.has(dev.id)}
                selectMode={selectMode}
                onToggleSelect={() => toggleSelect(dev.id)}
                onOpen={() => nav(`/devices/${dev.id}`)}
              />
            ))}
          </div>
          {d.connected && d.devices.length === 0 && (
            <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
              {d.fleetError ? `Could not read the fleet: ${d.fleetError}` : 'No AC units reported by the account.'}
            </Card>
          )}
        </>
      )}
    </div>
  );

  if (wide) {
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>{body}</div>;
  }
  return (
    <>
      <MobileHeader eyebrow="Climate · Jávea" title="Devices" right={<Avatar />} />
      <div style={{ padding: '8px 14px 22px' }}>{body}</div>
    </>
  );
}
