import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type {
  DeviceView, DevicesResponse, DeviceWarmth, LiveResponse, DevicesStatus, AutomationsResponse, Automation,
} from '../lib/types';
import { Card, Icon } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { DEVICE_TYPES, typeMeta, classifyDevice, type DeviceType } from '../lib/deviceTypes';
import { AutomationRow } from '../components/AutomationRow';

/* ============================================================================
 * Devices — the typed-device hub. A segmented type bar (Cooling · Heating ·
 * Lighting · Switching) selects which device type's content shows below. Only
 * Cooling (the Intesis AC fleet) is built today; the rest are placeholders.
 *
 * Cooling content: a type-agnostic-feeling summary (cooling now · indoor avg ·
 * warmest · surplus), the shared solar-surplus automation row (read/write, same
 * object as on the Automations screen), and a plain navigable unit list. No bulk
 * editing, no row checkboxes — a row opens the unit detail. Writes are admin +
 * arm gated server-side.
 * ==========================================================================*/

const WARMTH_COLOR: Record<DeviceWarmth, string> = {
  cold: 'var(--battery)', cool: 'var(--battery)', comfortable: 'var(--text-2)',
  warm: 'var(--grid)', hot: 'var(--danger)', unknown: 'var(--text-3)',
};

const t1 = (t: number | null) => (t == null ? '—' : `${t.toFixed(1)}°`);

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

/* ---- type tab bar (matches the Autopilot SegmentedControl look + hue dots) -- */
function TypeTabs({ active, counts, wide, onSelect }: {
  active: DeviceType; counts: Record<DeviceType, number>; wide: boolean; onSelect: (t: DeviceType) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 5 }}>
      {DEVICE_TYPES.map((m) => {
        const on = m.type === active;
        const short = !wide && m.label.length > 7 ? m.label.slice(0, 5) : m.label;
        return (
          <button
            key={m.type}
            type="button"
            onClick={() => onSelect(m.type)}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              padding: wide ? '9px 6px' : '8px 4px', borderRadius: 'var(--radius-md)', border: 'none', cursor: 'pointer',
              background: on ? 'var(--surface-3)' : 'transparent',
              boxShadow: on ? 'inset 0 1px 0 rgba(233,245,242,0.06)' : 'none',
              color: on ? 'var(--text-1)' : 'var(--text-2)',
              fontSize: wide ? 13 : 11.5, fontWeight: 500, minWidth: 0,
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.hue, flex: 'none', opacity: on ? 1 : 0.6 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{short}</span>
            {wide && counts[m.type] > 0 && (
              <span className="pwr-mono" style={{ fontSize: 11, color: on ? 'var(--text-3)' : 'var(--text-disabled)' }}>{counts[m.type]}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SummaryTile({ label, value, color, accent }: { label: string; value: string; color?: string; accent?: boolean }) {
  return (
    <div style={{
      background: accent ? 'var(--solar-wash)' : 'var(--surface-1)',
      border: `1px solid ${accent ? 'rgba(46,230,160,0.25)' : 'var(--border-1)'}`,
      borderRadius: 'var(--radius-md)', padding: '8px 12px', textAlign: 'right', minWidth: 0,
    }}>
      <div className="pwr-eyebrow" style={{ color: accent ? 'var(--solar-dim)' : 'var(--text-3)' }}>{label}</div>
      <div className="pwr-mono" style={{ fontSize: 16, marginTop: 2, color: color ?? 'var(--text-1)' }}>{value}</div>
    </div>
  );
}

function AcRow({ d, wide, onOpen }: { d: DeviceView; wide: boolean; onOpen: () => void }) {
  const st = stateLabel(d);
  if (!wide) {
    const sub = d.power ? `${d.mode} · set ${t1(d.setpointC)}` : 'off';
    return (
      <button type="button" onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '11px 12px', cursor: 'pointer' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
          <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{sub}</div>
        </div>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', padding: '3px 8px', borderRadius: 'var(--radius-pill)', background: st.bg, color: st.color }}>{st.label}</span>
        <span className="pwr-mono" style={{ fontSize: 13, color: WARMTH_COLOR[d.warmth], minWidth: 44, textAlign: 'right' }}>{t1(d.currentTempC)}</span>
        <Icon name="chevron-right" size={15} color="var(--text-3)" />
      </button>
    );
  }
  return (
    <div role="button" onClick={onOpen} style={{ display: 'grid', gridTemplateColumns: '1.5fr 96px 64px 60px 60px 22px', alignItems: 'center', gap: 10, padding: '11px 10px', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
        {d.room && d.room !== d.name && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.room}</div>
        )}
      </div>
      <span style={{ justifySelf: 'start', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', padding: '3px 8px', borderRadius: 'var(--radius-pill)', background: st.bg, color: st.color }}>{st.label}</span>
      <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>{d.mode}</span>
      <span className="pwr-mono" style={{ textAlign: 'right', fontSize: 13, color: 'var(--text-2)' }}>{t1(d.setpointC)}</span>
      <span className="pwr-mono" style={{ textAlign: 'right', fontSize: 13, color: WARMTH_COLOR[d.warmth] }}>{t1(d.currentTempC)}</span>
      <Icon name="chevron-right" size={15} color="var(--text-3)" />
    </div>
  );
}

function ComingSoon({ meta }: { meta: { label: string; icon: string; hue: string } }) {
  return (
    <Card padded style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 28 }}>
      <span style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: meta.hue }}><Icon name={meta.icon} size={20} /></span>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{meta.label}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', maxWidth: 320, lineHeight: 1.5 }}>Not set up yet — {meta.label.toLowerCase()} controls are coming to this hub.</div>
    </Card>
  );
}

export function Devices({ ctx }: { ctx: ShellContext }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt } = usePolling<DevicesResponse>(api.devices.list, 20_000);
  const { data: live } = usePolling<LiveResponse>(api.live, 20_000);
  const { data: status } = usePolling<DevicesStatus>(api.devices.status, 20_000);
  const { data: autoData, refetch: refetchAuto } = usePolling<AutomationsResponse>(api.automations.list, 0);
  const [activeType, setActiveType] = useState<DeviceType>('cooling');

  const d = data;
  const armed = status?.armed ?? false;

  const counts = DEVICE_TYPES.reduce((acc, m) => {
    acc[m.type] = (d?.devices ?? []).filter((x) => classifyDevice(x) === m.type).length;
    return acc;
  }, {} as Record<DeviceType, number>);

  const cooling = (d?.devices ?? []).filter((x) => classifyDevice(x) === 'cooling');
  const coolingNow = cooling.filter((x) => x.power && x.mode === 'cool').length;
  const warmest = cooling.reduce<number | null>((m, x) => (x.currentTempC != null && x.currentTempC > (m ?? -Infinity) ? x.currentTempC : m), null);
  const warmestHot = warmest != null && warmest >= 28;
  const surplus = surplusKw(live);

  const automation: Automation | null = autoData?.automations?.[0] ?? null;
  const saveAuto = (patch: Partial<Automation>) => {
    if (!automation) return;
    void api.automations.update(automation.id, patch).then(() => refetchAuto());
  };

  const coolingContent = !d ? null : !d.connected ? (
    <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)', flex: 'none' }}><Icon name="cloud-off" size={16} /></span>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>AC Cloud is not connected. Add your account in <strong style={{ color: 'var(--text-1)' }}>Settings → Connect AC Cloud</strong> to see and control the units.</div>
    </Card>
  ) : (
    <>
      {/* SUMMARY */}
      <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(4,1fr)' : '1fr 1fr', gap: 8 }}>
        <SummaryTile label="Cooling now" value={`${coolingNow} / ${cooling.length}`} color="var(--solar)" />
        <SummaryTile label="Indoor avg" value={d.context.indoorAvgC != null ? `${d.context.indoorAvgC.toFixed(1)}°` : '—'} />
        <SummaryTile label="Warmest" value={t1(warmest)} color={warmestHot ? 'var(--danger)' : 'var(--text-1)'} />
        <SummaryTile label="Surplus" value={surplus != null ? `${surplus >= 0 ? '+' : ''}${surplus} kW` : '—'} color="var(--solar)" accent />
      </div>

      {/* AUTOPILOT ROW — shared automation object (read/write here and on Automations) */}
      {automation && (
        <Card padded style={{ padding: '13px 15px' }}>
          <AutomationRow automation={automation} canWrite={isAdmin} onSave={saveAuto} subtitle="Automation · cooling" dim={!armed} />
          {!armed && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="shield-off" size={13} color="var(--grid)" />
              Control is disarmed — the rule won't act. Arm it on the <button type="button" onClick={() => nav('/automations')} style={{ color: 'var(--solar)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 600 }}>Automations</button> screen.
            </div>
          )}
        </Card>
      )}

      {/* UNIT LIST */}
      {cooling.length > 0 ? (
        <Card padded style={{ padding: '6px 6px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: wide ? '1.5fr 96px 64px 60px 60px 22px' : '1fr 56px 44px 15px', gap: 10, padding: '4px 12px 6px' }}>
            <span className="pwr-eyebrow">Unit / room</span>
            <span className="pwr-eyebrow">State</span>
            {wide && <span className="pwr-eyebrow">Mode</span>}
            {wide && <span className="pwr-eyebrow" style={{ textAlign: 'right' }}>Set</span>}
            <span className="pwr-eyebrow" style={{ textAlign: 'right' }}>Room</span>
            <span />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {cooling.map((dev, i) => (
              <div key={dev.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                <AcRow d={dev} wide={wide} onOpen={() => nav(`/devices/${dev.id}`)} />
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
          {d.fleetError ? `Could not read the fleet: ${d.fleetError}` : 'No AC units reported by the account.'}
        </Card>
      )}
    </>
  );

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      {!d && loading && <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading devices…</Card>}
      {d && (
        <>
          <TypeTabs active={activeType} counts={counts} wide={wide} onSelect={setActiveType} />
          {activeType === 'cooling' ? coolingContent : <ComingSoon meta={typeMeta(activeType)} />}
        </>
      )}
    </div>
  );

  if (wide) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 880, margin: '0 auto', width: '100%' }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>Devices</h1>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{d?.devices[0]?.installation ?? 'First installation'}</div>
        </div>
        {body}
      </div>
    );
  }
  return (
    <>
      <MobileHeader eyebrow="Home" title="Devices" right={<Avatar />} />
      <div style={{ padding: '8px 14px 22px' }}>{body}</div>
    </>
  );
}
