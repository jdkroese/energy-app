import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { DeviceView, DevicesResponse, DeviceWarmth, ClimateLever, LiveResponse } from '../lib/types';
import { Card, Icon, Button, SegmentedControl } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Devices — climate fleet overview, built to the approved design:
 *   • context strip (indoor avg · solar surplus · batteries · band)
 *   • smart banner (solar-surplus cooling active/idle, with the armed mode)
 *   • multi-select bulk action bar
 *   • a tabular fleet list (state pill · mode · setpoint · room temp · smart)
 * AC is the first device type. Writes are admin + arm gated server-side.
 * ==========================================================================*/

const WARMTH_COLOR: Record<DeviceWarmth, string> = {
  cold: 'var(--battery)',
  cool: 'var(--battery)',
  comfortable: 'var(--text-2)',
  warm: 'var(--grid)',
  hot: 'var(--danger)',
  unknown: 'var(--text-3)',
};

const t1 = (t: number | null) => (t == null ? '—' : `${t.toFixed(1)}°`);

/** Weighted combined battery SoC (Sonnen 9.2 kWh + Tesla 27 kWh usable). */
function batterySoc(live: LiveResponse | null): number | null {
  if (!live) return null;
  const s = live.sonnen.soc * 9.2;
  const t = live.tesla.soc * 27;
  return Math.round((s + t) / (9.2 + 27));
}
/** Free solar surplus = what's being exported right now (≈ €0 value). */
function surplusKw(live: LiveResponse | null): number | null {
  if (!live) return null;
  return live.grid.dir === 'exporting' ? Math.round(live.grid.kw * 10) / 10 : 0;
}

function stateLabel(d: DeviceView): { label: string; color: string; bg: string } {
  if (!d.power) return { label: 'OFF', color: 'var(--text-3)', bg: 'var(--surface-3)' };
  const map: Record<string, string> = { cool: 'COOLING', heat: 'HEATING', dry: 'DRYING', fan: 'FAN', auto: 'AUTO' };
  const warm = d.mode === 'heat';
  return {
    label: map[d.mode] ?? d.mode.toUpperCase(),
    color: warm ? 'var(--grid)' : 'var(--solar)',
    bg: warm ? 'var(--grid-wash)' : 'var(--solar-wash)',
  };
}

function Chip({ label, value, color, accent }: { label: string; value: string; color?: string; accent?: boolean }) {
  return (
    <div
      style={{
        background: accent ? 'var(--solar-wash)' : 'var(--surface-1)',
        border: `1px solid ${accent ? 'rgba(46,230,160,0.25)' : 'var(--border-1)'}`,
        borderRadius: 'var(--radius-md)',
        padding: '8px 12px',
        textAlign: 'right',
        minWidth: 0,
      }}
    >
      <div className="pwr-eyebrow" style={{ color: accent ? 'var(--solar-dim)' : 'var(--text-3)' }}>{label}</div>
      <div className="pwr-mono" style={{ fontSize: 16, marginTop: 2, color: color ?? 'var(--text-1)' }}>{value}</div>
    </div>
  );
}

function FleetRow({
  d,
  selected,
  selectMode,
  wide,
  onToggleSelect,
  onOpen,
}: {
  d: DeviceView;
  selected: boolean;
  selectMode: boolean;
  wide: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
}) {
  const st = stateLabel(d);
  const cols = wide ? '22px 1.5fr 96px 56px 60px 60px 22px' : '22px 1.4fr 84px 56px 56px';
  return (
    <div
      role="button"
      onClick={selectMode ? onToggleSelect : onOpen}
      style={{
        display: 'grid',
        gridTemplateColumns: cols,
        alignItems: 'center',
        gap: 10,
        padding: '10px 10px',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        background: selected ? 'var(--solar-wash)' : 'transparent',
      }}
    >
      <span
        onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
        style={{
          width: 17, height: 17, borderRadius: 4, justifySelf: 'center',
          border: selected ? 'none' : '1.5px solid var(--border-3)',
          background: selected ? 'var(--solar)' : 'transparent',
          display: 'grid', placeItems: 'center', color: '#06090b',
        }}
      >
        {selected && <Icon name="check" size={12} />}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
        {d.room && d.room !== d.name && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.room}</div>
        )}
      </div>
      <span style={{ justifySelf: 'start', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', padding: '3px 8px', borderRadius: 'var(--radius-pill)', background: st.bg, color: st.color }}>{st.label}</span>
      {wide && <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>{d.mode}</span>}
      <span className="pwr-mono" style={{ textAlign: 'right', fontSize: 13, color: 'var(--text-2)' }}>{t1(d.setpointC)}</span>
      <span className="pwr-mono" style={{ textAlign: 'right', fontSize: 13, color: WARMTH_COLOR[d.warmth] }}>{t1(d.currentTempC)}</span>
      {wide && (
        <span style={{ justifySelf: 'center', color: d.automationEnabled ? 'var(--solar)' : 'var(--text-disabled)' }} title={d.automationEnabled ? 'Automation enabled' : 'Not automated'}>
          <Icon name="zap" size={14} />
        </span>
      )}
    </div>
  );
}

export function Devices({ ctx }: { ctx: ShellContext }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt, refetch } = usePolling<DevicesResponse>(api.devices.list, 20_000);
  const { data: live } = usePolling<LiveResponse>(api.live, 20_000);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const d = data;
  const selectMode = selected.size > 0;

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch { /* surfaced via refetch */ } finally { setBusy(false); refetch(); }
  };
  const ids = () => [...selected];
  const bulk = (lever: ClimateLever, value: boolean | number | string) => run(() => api.devices.bulkCommand(ids(), lever, value));
  const onStep = (delta: number) => {
    if (!d) return;
    void run(async () => {
      for (const id of ids()) {
        const base = d.devices.find((x) => x.id === id)?.setpointC ?? 24;
        await api.devices.command(id, 'setpoint', Math.round((base + delta) * 2) / 2);
      }
    });
  };

  const armedMode = d?.armed ? (d.mode === 'auto' ? 'Auto' : 'Manual') : 'Disarmed';
  const warmCount = d?.devices.filter((x) => x.warmth === 'hot' || x.warmth === 'warm').length ?? 0;
  const coolingCount = d?.devices.filter((x) => x.power && x.mode === 'cool').length ?? 0;

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      {!d && loading && <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading devices…</Card>}
      {d && (
        <>
          {/* CONTEXT STRIP */}
          <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(4,1fr)' : '1fr 1fr', gap: 8 }}>
            <Chip label="Indoor avg" value={d.context.indoorAvgC != null ? `${d.context.indoorAvgC.toFixed(1)}°` : '—'} />
            <Chip label="Solar surplus" value={surplusKw(live) != null ? `${surplusKw(live)! >= 0 ? '+' : ''}${surplusKw(live)} kW` : '—'} color="var(--solar)" accent />
            <Chip label="Batteries" value={batterySoc(live) != null ? `${batterySoc(live)}%` : '—'} color="var(--battery)" />
            <Chip label="Band" value={d.context.band} color="var(--grid)" />
          </div>

          {/* SMART BANNER */}
          {!d.connected ? (
            <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)', flex: 'none' }}><Icon name="cloud-off" size={16} /></span>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>AC Cloud is not connected. Add your account in <strong style={{ color: 'var(--text-1)' }}>Settings → Connect AC Cloud</strong> to see and control the units.</div>
            </Card>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--solar-wash)', border: '1px solid rgba(46,230,160,0.22)', borderRadius: 'var(--radius-lg)', padding: '11px 14px' }}>
              <Icon name="zap" size={20} color="var(--solar)" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Solar-surplus cooling · <span style={{ color: coolingCount > 0 ? 'var(--solar)' : 'var(--text-2)' }}>{coolingCount > 0 ? 'active' : 'idle'}</span></div>
                <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 1 }}>
                  {coolingCount > 0 ? `Cooling ${coolingCount} room${coolingCount > 1 ? 's' : ''}` : warmCount > 0 ? `${warmCount} warm room${warmCount > 1 ? 's' : ''} — will pre-cool on surplus` : 'All rooms comfortable'}
                </div>
              </div>
              <span style={{ fontSize: 11, color: d.mode === 'auto' ? 'var(--solar)' : 'var(--text-2)', fontWeight: 600, padding: '4px 10px', borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)' }}>{armedMode}</span>
            </div>
          )}

          {/* BULK BAR */}
          {selectMode && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: '8px 12px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600 }}>
                <span style={{ width: 17, height: 17, borderRadius: 4, background: 'var(--solar)', display: 'grid', placeItems: 'center', color: '#06090b' }}><Icon name="check" size={12} /></span>
                {selected.size} selected
              </span>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button size="sm" variant="secondary" disabled={!isAdmin || !d.armed || busy} iconLeft={<Icon name="power" size={13} />} onClick={() => bulk('power', true)}>On</Button>
                <Button size="sm" variant="secondary" disabled={!isAdmin || !d.armed || busy} iconLeft={<Icon name="power-off" size={13} />} onClick={() => bulk('power', false)}>Off</Button>
                <Button size="sm" variant="secondary" disabled={!isAdmin || !d.armed || busy} iconLeft={<Icon name="minus" size={13} />} onClick={() => onStep(-0.5)}>0.5°</Button>
                <Button size="sm" variant="secondary" disabled={!isAdmin || !d.armed || busy} iconLeft={<Icon name="plus" size={13} />} onClick={() => onStep(0.5)}>0.5°</Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
              </div>
            </div>
          )}
          {selectMode && (
            <div style={{ maxWidth: wide ? 360 : '100%' }}>
              <SegmentedControl size="sm" block options={[{ value: 'cool', label: 'Cool' }, { value: 'fan', label: 'Fan' }, { value: 'dry', label: 'Dry' }, { value: 'heat', label: 'Heat' }]} onChange={(m) => isAdmin && d.armed && bulk('mode', m)} />
            </div>
          )}

          {/* FLEET LIST */}
          {d.connected && d.devices.length > 0 && (
            <Card padded style={{ padding: '6px 6px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: wide ? '22px 1.5fr 96px 56px 60px 60px 22px' : '22px 1.4fr 84px 56px 56px', gap: 10, padding: '4px 10px 6px' }}>
                <span />
                <span className="pwr-eyebrow">Unit / room</span>
                <span className="pwr-eyebrow">State</span>
                {wide && <span className="pwr-eyebrow">Mode</span>}
                <span className="pwr-eyebrow" style={{ textAlign: 'right' }}>Set</span>
                <span className="pwr-eyebrow" style={{ textAlign: 'right' }}>Room</span>
                {wide && <span />}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {d.devices.map((dev, i) => (
                  <div key={dev.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                    <FleetRow d={dev} wide={wide} selected={selected.has(dev.id)} selectMode={selectMode} onToggleSelect={() => toggleSelect(dev.id)} onOpen={() => nav(`/devices/${dev.id}`)} />
                  </div>
                ))}
              </div>
            </Card>
          )}
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
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 880, margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>Devices</h1>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{d ? `${d.context.deviceCount} climate units${d.devices[0]?.installation ? ` · ${d.devices[0].installation}` : ''}` : 'Climate'}</div>
          </div>
        </div>
        {body}
      </div>
    );
  }
  return (
    <>
      <MobileHeader eyebrow={d ? `${d.context.deviceCount} climate units` : 'Climate'} title="Devices" right={<Avatar />} />
      <div style={{ padding: '8px 14px 22px' }}>{body}</div>
    </>
  );
}
