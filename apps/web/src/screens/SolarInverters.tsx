import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { InvertersResponse, InverterView } from '../lib/types';
import { Card, StatTile, Badge, StatusDot, Icon } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Solar Inverters (Sungrow SG5.0RS ×2; docs/36). READ-ONLY monitoring surface:
 * a combined summary + a rich card per inverter (live kW, today kWh, work-state,
 * reachable/last-seen, temp, recent fault). The two Sungrow string inverters drive
 * Array A; they de-energize at night, so an "asleep" state (night) is shown calmly
 * and distinctly from a real daylight "offline".
 * ==========================================================================*/

type Status = InverterView['status'];

function statusMeta(s: Status): { label: string; tone: 'solar' | 'grid' | 'offline'; live: boolean } {
  if (s === 'online') return { label: 'Producing', tone: 'solar', live: true };
  if (s === 'asleep') return { label: 'Asleep', tone: 'offline', live: false };
  return { label: 'Offline', tone: 'grid', live: false };
}

function relTime(iso: string | null): string {
  if (!iso) return 'never seen';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function workStateTone(ws: string): 'solar' | 'grid' | 'danger' | 'neutral' {
  if (ws === 'Run') return 'solar';
  if (ws === 'Fault') return 'danger';
  if (ws === 'Alarm' || ws === 'Derating') return 'grid';
  return 'neutral';
}

function InverterCard({ inv }: { inv: InverterView }) {
  const sm = statusMeta(inv.status);
  const activeFault = inv.faults.find((f) => f.status.toLowerCase().includes('active'));
  return (
    <Card accent="solar" padded style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span
          style={{
            width: 38,
            height: 38,
            borderRadius: 11,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--solar-wash)',
            color: 'var(--solar)',
            flex: 'none',
          }}
        >
          <Icon name="sun" size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, letterSpacing: '-.01em' }}>{inv.name}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {inv.model} · {inv.ip}
          </div>
        </div>
        <StatusDot tone={sm.tone} live={sm.live}>
          {sm.label}
        </StatusDot>
      </div>

      {/* live power + today */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 600, color: inv.reachable ? 'var(--solar)' : 'var(--text-3)' }}>
            {inv.reachable ? inv.kw.toFixed(2) : '—'}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>kW now</span>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600 }}>{inv.dailyKwh.toFixed(1)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>kWh today</div>
        </div>
      </div>

      {/* chips: work-state · temp · lifetime */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Badge tone={workStateTone(inv.workState)} variant="soft" icon={<Icon name="activity" size={11} />}>
          {inv.workState}
        </Badge>
        {inv.tempC != null && (
          <Badge tone="neutral" variant="soft" icon={<Icon name="thermometer" size={11} />}>
            {inv.tempC.toFixed(0)} °C
          </Badge>
        )}
        <Badge tone="neutral" variant="soft" icon={<Icon name="gauge" size={11} />}>
          {inv.totalKwh.toLocaleString()} kWh lifetime
        </Badge>
      </div>

      {/* fault + last-seen footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 11,
          borderTop: '1px solid var(--border-1)',
          fontSize: 12,
          color: 'var(--text-2)',
        }}
      >
        {activeFault ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--danger)', fontWeight: 600 }}>
            <Icon name="triangle-alert" size={14} />
            {activeFault.name}
            {activeFault.code != null && <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>· code {activeFault.code}</span>}
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="check-circle" size={14} color="var(--solar)" />
            No active faults
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name="clock" size={13} />
          {relTime(inv.lastSeen)}
        </span>
      </div>
    </Card>
  );
}

function Summary({ d, wide }: { d: InvertersResponse; wide: boolean }) {
  const online = d.inverters.filter((i) => i.status === 'online').length;
  const problems = d.inverters.filter((i) => i.status === 'offline' || i.activeFaultCount > 0).length;
  return (
    <Card accent="solar" glow padded style={{ display: 'flex', alignItems: 'center', gap: wide ? 22 : 16 }}>
      <span
        style={{
          width: wide ? 64 : 52,
          height: wide ? 64 : 52,
          borderRadius: 16,
          display: 'grid',
          placeItems: 'center',
          background: 'var(--solar-wash)',
          color: 'var(--solar)',
          flex: 'none',
        }}
      >
        <Icon name="sun" size={wide ? 32 : 26} />
      </span>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: wide ? 'repeat(4,1fr)' : '1fr 1fr', gap: 12 }}>
        <StatTile size="sm" label="Producing now" value={d.productionKw.toFixed(2)} unit="kW" tone="solar" icon={<Icon name="zap" />} />
        <StatTile size="sm" label="Today" value={d.todayKwh.toFixed(1)} unit="kWh" tone="solar" icon={<Icon name="sun" />} />
        <StatTile size="sm" label="Online" value={`${online}/${d.count}`} tone={online === d.count ? 'solar' : 'grid'} icon={<Icon name="wifi" />} footnote={!d.daylight ? 'night — asleep' : undefined} />
        <StatTile size="sm" label="Issues" value={String(problems)} tone={problems > 0 ? 'grid' : 'neutral'} icon={<Icon name="triangle-alert" />} />
      </div>
    </Card>
  );
}

export function SolarInverters({ ctx }: { ctx: ShellContext }) {
  const { data, loading, stale, updatedAt } = usePolling<InvertersResponse>(api.inverters, 15_000);
  const wide = ctx.desktop;
  const d = data;

  const empty = !loading && (!d || d.count === 0);

  const body = d && d.count > 0 && (
    <>
      <Summary d={d} wide={wide} />
      <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1fr' : '1fr', gap: wide ? 18 : 12 }}>
        {d.inverters.map((inv) => (
          <InverterCard key={inv.id} inv={inv} />
        ))}
      </div>
      <NightNote daylight={d.daylight} />
    </>
  );

  const emptyState = empty && (
    <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--solar-wash)', color: 'var(--solar)', flex: 'none' }}>
        <Icon name="sun" size={16} />
      </span>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
        No solar inverters configured yet. Add the WiNet-S dongle IPs under{' '}
        <strong style={{ color: 'var(--text-1)' }}>Settings → Connections → Sungrow</strong>.
      </div>
    </Card>
  );

  if (wide) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {stale && <StaleBanner updatedAt={updatedAt} />}
        {body}
        {emptyState}
      </div>
    );
  }

  return (
    <>
      <MobileHeader eyebrow="Solar · Jávea" title="Inverters" right={<Avatar />} />
      {stale && <StaleBanner updatedAt={updatedAt} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 14px 22px' }}>
        {body}
        {emptyState}
      </div>
    </>
  );
}

/** Honest footnote: string inverters + their WiNet-S dongles sleep at night. */
function NightNote({ daylight }: { daylight: boolean }) {
  return (
    <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--text-2)', flex: 'none' }}>
        <Icon name={daylight ? 'sun' : 'moon'} size={16} />
      </span>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
        {daylight ? (
          <>These are string inverters — an unreachable dongle in <strong style={{ color: 'var(--text-1)' }}>daylight</strong> is a real outage and pages you.</>
        ) : (
          <>It's <strong style={{ color: 'var(--text-1)' }}>night</strong> — the inverters and their WiNet-S dongles sleep with the sun, so "Asleep" is normal and never alerts.</>
        )}
      </div>
    </Card>
  );
}
