import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_BATTERIES } from '../lib/mock';
import type { BatteriesResponse, BatteryDetail as BatteryDetailT } from '../lib/types';
import { Card, StatTile, RadialGauge, ProgressBar, Badge, StatusDot, Button, IconButton, Eyebrow, Icon } from '../components/ui';
import { AreaChart } from '../components/energy/AreaChart';
import { StaleBanner } from './_shared';
import { PowerPill } from './Batteries';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * BatteryDetail — the per-device deep page (/batteries/:id).
 *
 * Answers, top to bottom: what is it doing now → (Tesla) backup posture →
 * how its capacity is split → today's SoC + charge/discharge → health → specs.
 * Tolerant of nulls: anything the device/API doesn't report renders as "—"
 * rather than a fabricated value.
 * ==========================================================================*/

const CHART_LABELS = ['00', '06', '12', '18', '24'];

function fmt(n: number | null, dp = 1, unit = ''): string {
  if (n == null) return '—';
  return `${n.toFixed(dp)}${unit ? ` ${unit}` : ''}`;
}

/** A labelled metric cell (mono value + optional sub-line). */
function Metric({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600, color: tone || 'var(--text-1)' }}>{value}</span>
      {sub && <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{sub}</span>}
    </div>
  );
}

const card3: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
  gap: 16,
};

function HeroCard({ b }: { b: BatteryDetailT }) {
  return (
    <Card accent="battery" glow padded style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <RadialGauge value={b.soc} tone="battery" size={132} label="State of charge" />
        <div style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 11 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 600 }}>{b.kwh.toFixed(1)}</span>
            <span style={{ fontSize: 13, color: 'var(--text-2)' }}>/ {b.usableKwh} kWh stored</span>
          </div>
          <PowerPill power={b.power} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Badge tone="neutral" variant="soft" icon={<Icon name="settings-2" size={11} />}>{b.mode}</Badge>
            <Badge tone="neutral" variant="soft" icon={<Icon name="gauge" size={11} />}>{b.maxKw} kW max</Badge>
            {b.hasBackup ? (
              <Badge tone="battery" variant="soft" icon={<Icon name="shield-check" size={11} />}>Backup</Badge>
            ) : (
              <Badge tone="neutral" variant="soft" icon={<Icon name="zap" size={11} />}>No backup</Badge>
            )}
          </div>
        </div>
      </div>
      <div style={{ ...card3, paddingTop: 14, borderTop: '1px solid var(--border-1)' }}>
        <StatTile size="sm" label="Stored" value={b.kwh.toFixed(1)} unit="kWh" tone="battery" icon={<Icon name="battery-charging" />} />
        <StatTile size="sm" label="Headroom" value={b.headroomKwh.toFixed(1)} unit="kWh" tone="neutral" icon={<Icon name="arrow-up" />} />
        <StatTile size="sm" label="Capacity" value={String(b.usableKwh)} unit="kWh" tone="neutral" icon={<Icon name="database" />} footnote="usable" />
      </div>
    </Card>
  );
}

function BackupCard({ b, onAutopilot }: { b: BatteryDetailT; onAutopilot: () => void }) {
  return (
    <Card accent="battery" padded style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--battery-wash)', color: 'var(--battery)' }}>
          <Icon name="shield-check" size={16} />
        </span>
        <Eyebrow>Backup posture</Eyebrow>
        <span style={{ marginLeft: 'auto' }}>
          {b.island ? (
            <Badge tone="danger" variant="soft" icon={<Icon name="unplug" size={11} />}>Islanded</Badge>
          ) : (
            <Badge tone="battery" variant="soft" icon={<Icon name="plug" size={11} />}>Grid-tied</Badge>
          )}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 16 }}>
        <Metric label="Backup reserve" value={fmt(b.reservePct, 0, '%')} sub="floor held for outages" tone="var(--battery)" />
        <Metric label="Backup energy" value={fmt(b.backupKwh, 1, 'kWh')} sub="above the reserve" />
        <Metric label="Autonomy" value={b.backupHours != null ? `≈ ${b.backupHours} h` : '—'} sub="at critical load" />
        <Metric label="Storm watch" value={b.stormMode == null ? '—' : b.stormMode ? 'Active' : 'Off'} tone={b.stormMode ? 'var(--grid)' : undefined} />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 12, borderTop: '1px solid var(--border-1)' }}>
        {b.exportRule && (
          <Badge tone="neutral" variant="soft" icon={<Icon name="upload" size={11} />}>Export · {b.exportRule}</Badge>
        )}
        {b.gridChargeAllowed != null && (
          <Badge tone={b.gridChargeAllowed ? 'grid' : 'neutral'} variant="soft" icon={<Icon name="plug-zap" size={11} />}>
            Grid charge · {b.gridChargeAllowed ? 'allowed' : 'solar only'}
          </Badge>
        )}
        <Button size="sm" variant="secondary" style={{ marginLeft: 'auto' }} iconLeft={<Icon name="sliders-horizontal" size={14} />} onClick={onAutopilot}>
          Adjust in Autopilot
        </Button>
      </div>
    </Card>
  );
}

function CapacityCard({ b }: { b: BatteryDetailT }) {
  const reserve = b.reservePct ?? 0;
  const available = Math.max(0, b.soc - reserve);
  const headroom = Math.max(0, 100 - b.soc);
  const reserveKwh = (reserve / 100) * b.usableKwh;
  const availableKwh = b.aboveReserveKwh ?? (available / 100) * b.usableKwh;

  const segments = b.hasBackup
    ? [
        { value: reserve, tone: 'grid', label: 'Reserve' },
        { value: available, tone: 'battery', label: 'Available' },
        { value: headroom, tone: 'var(--surface-4)', label: 'Headroom' },
      ]
    : [
        { value: b.soc, tone: 'battery', label: 'Available' },
        { value: headroom, tone: 'var(--surface-4)', label: 'Headroom' },
      ];

  const Legend = ({ c, label, val }: { c: string; label: string; val: string }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text-2)' }}>
      <span style={{ width: 9, height: 9, borderRadius: 3, background: c, flex: 'none' }} />
      {label}
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)', marginLeft: 'auto' }}>{val}</span>
    </div>
  );

  return (
    <Card title="Capacity" subtitle="How the usable pack is split right now" icon={<Icon name="database" />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ProgressBar height={14} segments={segments} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 22px' }}>
          {b.hasBackup && <Legend c="var(--grid)" label="Reserve (held)" val={`${reserveKwh.toFixed(1)} kWh`} />}
          <Legend c="var(--battery)" label="Available now" val={`${availableKwh.toFixed(1)} kWh`} />
          <Legend c="var(--surface-4)" label="Headroom to full" val={`${b.headroomKwh.toFixed(1)} kWh`} />
          <Legend c="transparent" label="Usable total" val={`${b.usableKwh} kWh`} />
        </div>
      </div>
    </Card>
  );
}

function TodayCard({ b }: { b: BatteryDetailT }) {
  const reserveLine = b.reservePct != null ? new Array(b.socDay.length).fill(b.reservePct) : null;
  return (
    <Card title="Today" subtitle="State of charge + charge / discharge power" icon={<Icon name="activity" />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>State of charge · %</span>
            {reserveLine && (
              <span style={{ fontSize: 11, color: 'var(--grid)', fontFamily: 'var(--font-mono)' }}>– – reserve {b.reservePct}%</span>
            )}
          </div>
          <AreaChart
            height={150}
            axis
            labels={CHART_LABELS}
            series={[
              { data: b.socDay, tone: 'var(--battery)' },
              ...(reserveLine ? [{ data: reserveLine, tone: 'var(--grid)', dash: true, fill: false }] : []),
            ]}
          />
        </div>
        <div>
          <div style={{ display: 'flex', gap: 14, marginBottom: 4, fontSize: 12, color: 'var(--text-2)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: 'var(--solar)' }} /> Charge
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: 'var(--battery)' }} /> Discharge
            </span>
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>kW</span>
          </div>
          <AreaChart
            height={120}
            labels={CHART_LABELS}
            series={[
              { data: b.chargeKwDay, tone: 'var(--solar)' },
              { data: b.dischargeKwDay, tone: 'var(--battery)' },
            ]}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, paddingTop: 12, borderTop: '1px solid var(--border-1)' }}>
          <StatTile size="sm" label="Charged today" value={b.todayInKwh.toFixed(1)} unit="kWh" tone="solar" icon={<Icon name="arrow-down-to-line" />} />
          <StatTile size="sm" label="Discharged today" value={b.todayOutKwh.toFixed(1)} unit="kWh" tone="battery" icon={<Icon name="arrow-up-from-line" />} />
        </div>
      </div>
    </Card>
  );
}

function HealthCard({ b }: { b: BatteryDetailT }) {
  const noHealth = b.health == null && b.capacityKwh == null && b.cyclesTotal == null;
  return (
    <Card title="Health" subtitle="Degradation, cycles & efficiency" icon={<Icon name="heart-pulse" />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <RadialGauge
            value={b.health ?? 100}
            tone={b.health == null || b.health >= 90 ? 'solar' : 'grid'}
            size={108}
            label="Health"
            valueText={b.health != null ? String(b.health) : '—'}
          />
          <div style={{ flex: 1, minWidth: 160, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Metric label="Measured capacity" value={fmt(b.capacityKwh, 1, 'kWh')} sub={`of ${b.nominalKwh} kWh nameplate`} />
            <Metric label="Equivalent cycles" value={b.cyclesTotal != null ? b.cyclesTotal.toLocaleString() : '—'} />
            <Metric label="Lifetime throughput" value={b.throughputKwh != null ? `${(b.throughputKwh / 1000).toFixed(1)} MWh` : '—'} />
            <Metric label="Round-trip" value={fmt(b.roundTripPct, 0, '%')} />
            <Metric label="Cell temp" value={b.tempC != null ? `${b.tempC} °C` : '—'} />
            <Metric label="Warranty left" value={fmt(b.warrantyPct, 0, '%')} sub={b.installedYear ? `installed ${b.installedYear}` : undefined} />
          </div>
        </div>
        {noHealth && (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5, display: 'flex', gap: 7 }}>
            <Icon name="info" size={14} />
            <span>
              {b.id === 'tesla'
                ? 'The Tesla Fleet API does not expose pack-level health; these fill in if a richer source is added.'
                : 'Health metrics fill in once the device reports full-charge capacity and cycle count.'}
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

function SpecsCard({ b }: { b: BatteryDetailT }) {
  return (
    <Card title="Specifications" icon={<Icon name="file-text" />}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 22px' }}>
        {b.specs.map((s) => (
          <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '2px 0' }}>
            <span style={{ color: 'var(--text-2)' }}>{s.label}</span>
            <span style={{ color: 'var(--text-1)', fontWeight: 500, textAlign: 'right' }}>{s.value}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function BatteryDetail({ ctx }: { ctx: ShellContext }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { data, loading, stale, updatedAt } = usePolling<BatteriesResponse>(api.batteries, 15_000);
  const view = data || (loading ? null : MOCK_BATTERIES) || MOCK_BATTERIES;
  const b = view?.batteries.find((x) => x.id === id);
  const wide = ctx.desktop;

  if (!b) {
    return (
      <div style={{ maxWidth: 880, margin: '0 auto', width: '100%', padding: wide ? 0 : '16px 14px' }}>
        <Card padded style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', padding: 28 }}>
          <Icon name="battery-warning" size={26} color="var(--text-3)" />
          <div style={{ fontSize: 15, fontWeight: 600 }}>{loading ? 'Loading battery…' : 'Battery not found'}</div>
          <Button variant="secondary" iconLeft={<Icon name="chevron-left" size={15} />} onClick={() => nav('/batteries')}>
            Back to batteries
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', width: '100%', padding: wide ? 0 : '8px 14px 22px', display: 'flex', flexDirection: 'column', gap: wide ? 16 : 12 }}>
      {/* in-page header (works on both platforms; the desktop TopBar shows a generic title) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: wide ? 0 : 8 }}>
        <IconButton variant="solid" aria-label="Back" onClick={() => nav('/batteries')}>
          <Icon name="chevron-left" size={18} />
        </IconButton>
        <span style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--battery-wash)', color: 'var(--battery)', flex: 'none' }}>
          <Icon name={b.hasBackup ? 'battery-full' : 'battery-charging'} size={21} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-.02em', margin: 0 }}>{b.name}</h1>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{b.vendor} · {b.role}</div>
        </div>
        <StatusDot tone={b.online ? 'battery' : 'offline'} live={b.online}>{b.online ? 'Online' : 'Offline'}</StatusDot>
      </div>

      {stale && <StaleBanner updatedAt={updatedAt} />}

      <HeroCard b={b} />
      {b.hasBackup && <BackupCard b={b} onAutopilot={() => nav('/brain')} />}

      <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1fr' : '1fr', gap: wide ? 16 : 12 }}>
        <CapacityCard b={b} />
        <HealthCard b={b} />
      </div>

      <TodayCard b={b} />
      <SpecsCard b={b} />

      {/* footer actions */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Button variant="primary" iconLeft={<Icon name="sliders-horizontal" size={16} />} onClick={() => nav('/brain')}>
          Control in Autopilot
        </Button>
        <Button variant="secondary" iconLeft={<Icon name="bell" size={16} />} onClick={() => nav('/alerts')}>
          View alerts
        </Button>
      </div>
    </div>
  );
}
