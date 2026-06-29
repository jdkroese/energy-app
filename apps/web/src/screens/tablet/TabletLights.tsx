import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { LightUnit, LightsResponse, LightLever } from '../../lib/types';
import { Icon, Slider, EmptyState } from '../../components/ui';

/* ============================================================================
 * TabletLights — wall-tablet lights screen. Big light tiles grouped by room
 * (alphabetical, Unassigned last) with a fat on/off toggle, name + state, and a
 * brightness slider when dimmable. Reuses the same optimistic-override +
 * 150ms-debounce command flow as the phone/desktop Lights screen so a drag feels
 * live while the Tuya cloud read catches up. Empty/disconnected states render
 * calmly. Big touch targets throughout (kitchen wall display).
 * ==========================================================================*/

const sortByName = <T extends { name: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

/** Group lights by resolved room name (alphabetical; Unassigned last). */
function groupByRoom(lights: LightUnit[]): { room: string; items: LightUnit[] }[] {
  const map = new Map<string, LightUnit[]>();
  for (const l of lights) {
    const room = (l.roomName || l.room || '').trim() || 'Unassigned';
    if (!map.has(room)) map.set(room, []);
    map.get(room)!.push(l);
  }
  const rooms = [...map.keys()].sort((a, b) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
  return rooms.map((room) => ({ room, items: sortByName(map.get(room)!) }));
}

export function TabletLights() {
  const { data, refetch } = usePolling<LightsResponse>(api.lights.list, 15_000);

  // Optimistic overrides keyed by `${id}:${lever}` (same pattern as Lights.tsx).
  const [override, setOverride] = useState<Record<string, boolean | number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const send = (id: string, lever: LightLever, value: boolean | number) => {
    const key = `${id}:${lever}`;
    setOverride((o) => ({ ...o, [key]: value }));
    clearTimeout(timers.current[key]);
    const fire = () => {
      api.lights
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
    if (typeof value === 'number') timers.current[key] = setTimeout(fire, 150);
    else fire();
  };

  // Drop an optimistic value once a poll shows the device caught up.
  useEffect(() => {
    if (!data) return;
    setOverride((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const dev of data.devices) {
        const drop = (lever: LightLever, serverVal: unknown) => {
          const k = `${dev.id}:${lever}`;
          if (k in next && next[k] === serverVal) { delete next[k]; changed = true; }
        };
        drop('power', dev.power);
        drop('brightness', dev.brightnessPct);
      }
      return changed ? next : prev;
    });
  }, [data]);

  const withOverrides = (d: LightUnit): LightUnit => {
    const p = override[`${d.id}:power`];
    const b = override[`${d.id}:brightness`];
    return { ...d, power: typeof p === 'boolean' ? p : d.power, brightnessPct: typeof b === 'number' ? b : d.brightnessPct };
  };

  const groups = useMemo(() => groupByRoom(data?.devices ?? []), [data]);

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {data && !data.connected && (
        <Calm icon="cloud-off" title="Lights not connected" subtitle="Connect Tuya in Settings to control your lights here." />
      )}
      {data && data.connected && data.devices.length === 0 && (
        <Calm icon="lightbulb" title="No lights" subtitle="No lights were found on this account." />
      )}
      {(!data || (data.connected && data.devices.length > 0)) && groups.map(({ room, items }) => (
        <section key={room} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-2)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{room}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
            {items.map((dev) => <LightTile key={dev.id} d={withOverrides(dev)} onCmd={(lever, value) => send(dev.id, lever, value)} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function LightTile({ d, onCmd }: { d: LightUnit; onCmd: (lever: LightLever, value: boolean | number) => void }) {
  const on = d.power && d.online;
  const stateText = !d.online ? 'Offline' : d.power ? (d.brightnessPct != null ? `On · ${d.brightnessPct}%` : 'On') : 'Off';
  return (
    <div style={{ background: 'var(--surface-1)', border: `1px solid ${on ? 'var(--solar)' : 'var(--border-1)'}`, borderRadius: 'var(--radius-lg)', padding: 16, display: 'flex', flexDirection: 'column', gap: 14, opacity: d.online ? 1 : 0.55, transition: 'border-color .2s' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ width: 48, height: 48, borderRadius: 14, flex: 'none', display: 'grid', placeItems: 'center', background: on ? 'var(--solar-wash)' : 'var(--surface-3)', color: on ? 'var(--solar)' : 'var(--text-3)', boxShadow: on ? '0 0 18px -4px var(--solar)' : 'none', transition: 'all .2s' }}>
          <Icon name="lightbulb" size={24} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
          <div style={{ fontSize: 13, color: on ? 'var(--solar)' : 'var(--text-3)' }}>{stateText}</div>
        </div>
        <BigToggle on={d.power} disabled={!d.online} onToggle={() => onCmd('power', !d.power)} accent="var(--solar)" accentWash="var(--solar-wash)" />
      </div>
      {d.online && d.dimmable && d.brightnessPct != null && (
        <Slider label="Brightness" min={1} max={100} unit="%" value={d.brightnessPct} onChange={(v) => onCmd('brightness', v)} />
      )}
    </div>
  );
}

/** A large pill toggle sized for fingers (≥56px wide track). */
export function BigToggle({ on, disabled, onToggle, accent, accentWash }: { on: boolean; disabled?: boolean; onToggle: () => void; accent: string; accentWash: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={on ? 'Turn off' : 'Turn on'}
      aria-pressed={on}
      onClick={onToggle}
      style={{ width: 76, height: 44, borderRadius: 'var(--radius-pill)', border: '1px solid var(--border-2)', position: 'relative', flex: 'none', padding: 0, cursor: disabled ? 'default' : 'pointer', background: on ? accentWash : 'var(--surface-3)', opacity: disabled ? 0.5 : 1, transition: 'background .15s' }}
    >
      <span style={{ position: 'absolute', top: 3, left: on ? 36 : 3, width: 36, height: 36, borderRadius: '50%', background: on ? accent : 'var(--text-3)', transition: 'left .16s' }} />
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
