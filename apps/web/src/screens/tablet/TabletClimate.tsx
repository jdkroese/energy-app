import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { DeviceView, DevicesResponse } from '../../lib/types';
import { Icon, EmptyState } from '../../components/ui';

/* ============================================================================
 * TabletClimate — wall-tablet climate screen. One big tile per cooling/heating
 * unit (grid), matching the proposed design: room/unit name, a solar-heat /
 * solar-cool bolt + manual-on hand marker, the current temperature large
 * (warm-toned for heating, cool-toned for cooling), a big ± setpoint stepper
 * (≥56px, 0.5° steps, clamped to the unit's min/max), and a power button. Off
 * units dim. Reuses the same optimistic-override + debounce command flow as the
 * phone/desktop Devices screen. Rooms render alphabetically. Mode editing stays
 * in the full app — kept off the wall tablet; here mode is a status label.
 * ==========================================================================*/

type Lever = 'power' | 'setpoint';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function TabletClimate() {
  const { data, refetch } = usePolling<DevicesResponse>(api.devices.list, 15_000);

  // Optimistic overrides keyed by `${id}:${lever}` (same shape as Devices.tsx).
  const [override, setOverride] = useState<Record<string, boolean | number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const send = (id: string, lever: Lever, value: boolean | number, debounceMs = 0) => {
    const key = `${id}:${lever}`;
    setOverride((o) => ({ ...o, [key]: value }));
    clearTimeout(timers.current[key]);
    const fire = () => {
      api.devices
        .command(id, lever, value)
        .then(() => setTimeout(() => refetch(), 1200))
        .catch(() =>
          setOverride((o) => {
            const n = { ...o };
            delete n[key];
            return n;
          }),
        );
    };
    if (debounceMs) timers.current[key] = setTimeout(fire, debounceMs);
    else fire();
  };

  // Drop an optimistic value once a poll shows the unit caught up.
  useEffect(() => {
    if (!data) return;
    setOverride((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const d of data.devices) {
        const dropP = `${d.id}:power`;
        if (dropP in next && next[dropP] === d.power) { delete next[dropP]; changed = true; }
        const dropS = `${d.id}:setpoint`;
        if (dropS in next && next[dropS] === d.setpointC) { delete next[dropS]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [data]);

  const withOverrides = (d: DeviceView): DeviceView => {
    const p = override[`${d.id}:power`];
    const s = override[`${d.id}:setpoint`];
    return {
      ...d,
      power: typeof p === 'boolean' ? p : d.power,
      setpointC: typeof s === 'number' ? s : d.setpointC,
    };
  };

  const units = useMemo(
    () =>
      (data?.devices ?? [])
        .filter((d) => d.type === 'cooling' || d.type === 'heating')
        .sort((a, b) =>
          (a.roomName || a.name).localeCompare(b.roomName || b.name, undefined, { numeric: true, sensitivity: 'base' }),
        ),
    [data],
  );

  const showEmpty = data && data.connected && units.length === 0;
  const showOffline = data && !data.connected;

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {showOffline && <Calm icon="cloud-off" title="Climate not connected" subtitle="Connect your AC / heating in Settings to control it here." />}
      {showEmpty && <Calm icon="thermometer" title="No climate units" subtitle="No cooling or heating units were found." />}
      {(!data || units.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {units.map((raw) => (
            <ClimateTile key={raw.id} d={withOverrides(raw)} onCmd={send} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClimateTile({ d, onCmd }: { d: DeviceView; onCmd: (id: string, lever: Lever, value: boolean | number, debounceMs?: number) => void }) {
  const heating = d.type === 'heating';
  const accent = heating ? 'var(--grid)' : 'var(--battery)';
  const on = d.power && d.online;
  const lo = d.minSetpointC ?? 10;
  const hi = d.maxSetpointC ?? 32;
  const enrolled = heating ? d.solarHeatEnabled : d.solarCoolEnabled;
  const statusWord = !d.online ? 'offline' : !d.power ? 'off' : heating ? 'heating' : 'cooling';

  const step = (delta: number) => {
    if (!on || d.setpointC == null) return;
    onCmd(d.id, 'setpoint', clamp(Math.round((d.setpointC + delta) * 2) / 2, lo, hi), 500);
  };

  return (
    <div
      style={{
        background: 'var(--surface-1)',
        border: `1px solid ${on ? accent : 'var(--border-1)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        opacity: d.online ? (d.power ? 1 : 0.62) : 0.5,
        transition: 'border-color .2s, opacity .2s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {d.roomName || d.name}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
          {d.manualOn && (
            <span title="Manually on — protected from auto-off" style={{ color: 'var(--home)', display: 'inline-flex' }}>
              <Icon name="hand" size={16} />
            </span>
          )}
          {enrolled && (
            <span title={heating ? 'Solar heat enrolled' : 'Solar cool enrolled'} style={{ color: accent, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
              <Icon name="zap" size={14} /> solar {heating ? 'heat' : 'cool'}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 34, fontWeight: 600, color: on ? accent : 'var(--text-2)' }}>
          {d.currentTempC != null ? `${d.currentTempC.toFixed(1)}°` : '—'}
        </span>
        <span style={{ fontSize: 13, color: 'var(--text-3)' }}>now · {statusWord}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <StepBtn icon="minus" disabled={!on} onClick={() => step(-0.5)} />
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, color: on ? 'var(--text-1)' : 'var(--text-3)' }}>
            {d.setpointC != null ? `${d.setpointC.toFixed(1)}°` : '—'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>target</div>
        </div>
        <StepBtn icon="plus" disabled={!on} onClick={() => step(0.5)} />
        <button
          type="button"
          disabled={!d.online}
          aria-label={d.power ? 'Turn off' : 'Turn on'}
          aria-pressed={d.power}
          onClick={() => onCmd(d.id, 'power', !d.power)}
          style={{
            width: 56,
            height: 56,
            flex: 'none',
            borderRadius: 'var(--radius-md)',
            border: `1px solid ${d.power ? accent : 'var(--border-2)'}`,
            background: d.power ? accent : 'var(--surface-3)',
            color: d.power ? 'var(--bg-0)' : 'var(--text-2)',
            cursor: d.online ? 'pointer' : 'default',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Icon name="power" size={22} />
        </button>
      </div>
    </div>
  );
}

function StepBtn({ icon, disabled, onClick }: { icon: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={icon === 'plus' ? 'Warmer' : 'Cooler'}
      style={{
        width: 56,
        height: 56,
        flex: 'none',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-2)',
        background: 'var(--surface-3)',
        color: disabled ? 'var(--text-3)' : 'var(--text-1)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <Icon name={icon} size={22} />
    </button>
  );
}

function Calm({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)' }}>
      <EmptyState icon={icon} title={title} subtitle={subtitle} />
    </div>
  );
}
