import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_BATTERIES } from '../lib/mock';
import type { BatteriesResponse, BatteryDetail, FlowDir } from '../lib/types';
import { Card, StatTile, RadialGauge, ProgressBar, Badge, StatusDot, Icon, Eyebrow } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { SolarGenerationSection } from './SolarInverters';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Energy hub (/batteries) — the house's generation + storage in one place, told
 * as an energy-flow story: SOLAR GENERATION (the Sungrow inverters) on top, then
 * BATTERY STORAGE (Sonnen + Tesla) below. The two batteries have deliberately
 * different roles (Sonnen = fast self-consumption actuator, Tesla = backup +
 * policy), so their cards surface different things; each opens a detail page.
 * (Merged from the former standalone Solar Inverters + Charging pages.)
 * ==========================================================================*/

export interface PowerState {
  label: string;
  tone: 'solar' | 'battery' | 'neutral';
  icon: string;
}

export function powerState(power: { kw: number; dir: FlowDir }): PowerState {
  if (power.dir === 'charging') return { label: 'Charging', tone: 'solar', icon: 'arrow-down-to-line' };
  if (power.dir === 'discharging') return { label: 'Discharging', tone: 'battery', icon: 'arrow-up-from-line' };
  return { label: 'Idle', tone: 'neutral', icon: 'minus' };
}

const toneVar = (t: string) => (t === 'neutral' ? 'var(--text-3)' : `var(--${t})`);

/** Live power pill — "Charging · 2.1 kW" with a tone dot. */
export function PowerPill({ power }: { power: { kw: number; dir: FlowDir } }) {
  const ps = powerState(power);
  const c = toneVar(ps.tone);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 9px',
        borderRadius: 'var(--radius-pill)',
        background: ps.tone === 'neutral' ? 'var(--surface-3)' : `var(--${ps.tone}-wash)`,
        color: c,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <Icon name={ps.icon} size={13} />
      {ps.label}
      {power.dir !== 'idle' && (
        <span style={{ fontFamily: 'var(--font-mono)' }}>· {power.kw.toFixed(1)} kW</span>
      )}
    </span>
  );
}

function healthTone(h: number | null): 'solar' | 'grid' | 'danger' {
  if (h == null) return 'grid';
  if (h >= 90) return 'solar';
  if (h >= 75) return 'grid';
  return 'danger';
}

function BatteryCard({ b, onOpen }: { b: BatteryDetail; onOpen: () => void }) {
  return (
    <Card
      interactive
      accent="battery"
      padded
      onClick={onOpen}
      style={{ display: 'flex', flexDirection: 'column', gap: 14, cursor: 'pointer' }}
    >
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span
          style={{
            width: 38,
            height: 38,
            borderRadius: 11,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--battery-wash)',
            color: 'var(--battery)',
            flex: 'none',
          }}
        >
          <Icon name={b.hasBackup ? 'battery-full' : 'battery-charging'} size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, letterSpacing: '-.01em' }}>{b.name}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {b.vendor}
          </div>
        </div>
        <StatusDot tone={b.online ? 'battery' : 'offline'} live={b.online}>
          {b.online ? 'Online' : 'Offline'}
        </StatusDot>
      </div>

      {/* gauge + key state */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <RadialGauge value={b.soc} tone="battery" size={104} label={b.role.split(' ')[0]} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600 }}>{b.kwh.toFixed(1)}</span>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>/ {b.usableKwh} kWh stored</span>
          </div>
          <PowerPill power={b.power} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Badge tone="neutral" variant="soft" icon={<Icon name="settings-2" size={11} />}>
              {b.mode}
            </Badge>
            {b.hasBackup && b.reservePct != null && (
              <Badge tone="battery" variant="soft" icon={<Icon name="shield-check" size={11} />}>
                {b.reservePct}% reserve
              </Badge>
            )}
            {!b.hasBackup && (
              <Badge tone="neutral" variant="soft" icon={<Icon name="zap" size={11} />}>
                No backup
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* health */}
      <ProgressBar
        height={6}
        tone={healthTone(b.health)}
        value={b.health ?? 100}
        label="State of health"
        showValue
        valueText={b.health != null ? `${b.health}%` : 'Nominal'}
      />

      {/* footer — today throughput + open affordance */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          paddingTop: 11,
          borderTop: '1px solid var(--border-1)',
          fontSize: 12,
          color: 'var(--text-2)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name="arrow-down-to-line" size={13} color="var(--solar)" />
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{b.todayInKwh.toFixed(1)}</span> in
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name="arrow-up-from-line" size={13} color="var(--battery)" />
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{b.todayOutKwh.toFixed(1)}</span> out
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--battery)', fontWeight: 600 }}>
          Detail <Icon name="chevron-right" size={15} />
        </span>
      </div>
    </Card>
  );
}

function CombinedSummary({ d, wide }: { d: BatteriesResponse; wide: boolean }) {
  const { combined } = d;
  return (
    <Card accent="battery" glow padded style={{ display: 'flex', alignItems: 'center', gap: wide ? 22 : 16 }}>
      <RadialGauge value={combined.soc} tone="battery" size={wide ? 116 : 96} label="Combined" />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: wide ? 'repeat(3,1fr)' : '1fr 1fr', gap: 12 }}>
        <StatTile size="sm" label="Stored now" value={combined.storedKwh.toFixed(1)} unit="kWh" tone="battery" icon={<Icon name="battery-charging" />} />
        <StatTile size="sm" label="Usable" value={combined.usableKwh.toFixed(1)} unit="kWh" tone="neutral" icon={<Icon name="database" />} />
        <div style={{ gridColumn: wide ? 'auto' : 'span 2' }}>
          <StatTile size="sm" label="Devices" value="2" tone="solar" icon={<Icon name="layers" />} footnote="Sonnen + Tesla" />
        </div>
      </div>
    </Card>
  );
}

export function Batteries({ ctx }: { ctx: ShellContext }) {
  const nav = useNavigate();
  const { data, loading, stale, updatedAt } = usePolling<BatteriesResponse>(api.batteries, 15_000);
  const d = data || (loading ? null : MOCK_BATTERIES);
  const view = d || MOCK_BATTERIES;
  const wide = ctx.desktop;

  const cards = (
    <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1fr' : '1fr', gap: wide ? 18 : 12 }}>
      {view.batteries.map((b) => (
        <BatteryCard key={b.id} b={b} onOpen={() => nav(`/batteries/${b.id}`)} />
      ))}
    </div>
  );

  // Battery storage section (existing content, now under its own heading).
  const batterySection = (
    <section style={{ display: 'flex', flexDirection: 'column', gap: wide ? 14 : 10 }}>
      <Eyebrow>Battery storage</Eyebrow>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      <CombinedSummary d={view} wide={wide} />
      {cards}
      <BackupNote view={view} />
    </section>
  );

  // Solar generation section (the Sungrow inverters), self-contained.
  const solarSection = (
    <section style={{ display: 'flex', flexDirection: 'column', gap: wide ? 14 : 10 }}>
      <Eyebrow>Solar generation</Eyebrow>
      <SolarGenerationSection ctx={ctx} />
    </section>
  );

  // Generation → storage, top to bottom.
  if (wide) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        {solarSection}
        {batterySection}
      </div>
    );
  }

  return (
    <>
      <MobileHeader eyebrow="Energy · Jávea" title="Solar & storage" right={<Avatar />} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '8px 14px 22px' }}>
        {solarSection}
        {batterySection}
      </div>
    </>
  );
}

/** A small honest footnote about the backup asymmetry between the two batteries. */
function BackupNote({ view }: { view: BatteriesResponse }) {
  const tesla = view.batteries.find((b) => b.id === 'tesla');
  if (!tesla) return null;
  return (
    <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--battery-wash)', color: 'var(--battery)', flex: 'none' }}>
        <Icon name="shield-check" size={16} />
      </span>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
        Backup runs on the <strong style={{ color: 'var(--text-1)' }}>Tesla only</strong> — the Sonnen has no backup module.{' '}
        {tesla.backupKwh != null && (
          <>
            Holding <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--battery)' }}>{tesla.backupKwh.toFixed(1)} kWh</span>
            {tesla.backupHours != null && <> · ≈ {tesla.backupHours} h autonomy</>}.
          </>
        )}
      </div>
    </Card>
  );
}
