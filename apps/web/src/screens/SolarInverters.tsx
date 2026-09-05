import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { InvertersResponse, InverterView } from '../lib/types';
import { Badge, Card, Eyebrow, Icon } from '../components/ui';

/* ============================================================================
 * Solar inverters (V2, docs/53) — the generation row on the Energy hub.
 *
 * One line per inverter: name · a share bar of today's production · the kWh · a
 * state badge. The V1 screen's four-stat summary and per-inverter detail cards
 * are gone: today's split IS the story on this screen, and device health lives
 * on Automations → Status (which pages you when an inverter is dark in
 * daylight). The one thing kept is the honest night note — string inverters
 * sleep with the sun, so "Asleep" must never read as a fault.
 * ==========================================================================*/

type Status = InverterView['status'];

function statusMeta(s: Status, activeFaults: number): { label: string; tone: 'solar' | 'grid' | 'danger' | 'neutral' } {
  if (activeFaults > 0) return { label: 'Fault', tone: 'danger' };
  if (s === 'online') return { label: 'Producing', tone: 'solar' };
  if (s === 'asleep') return { label: 'Asleep', tone: 'neutral' };
  return { label: 'Offline', tone: 'grid' };
}

export function SolarInverterRows({ pad }: { pad: number }) {
  const { data } = usePolling<InvertersResponse>(api.inverters, 15_000);

  if (!data || data.count === 0) {
    return (
      <Card padded={false} style={{ padding: pad, display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--solar-wash)', color: 'var(--solar)', flex: 'none' }}>
          <Icon name="sun" size={16} />
        </span>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
          No solar inverters configured yet. Add the WiNet-S dongle IPs under{' '}
          <strong style={{ color: 'var(--text-1)' }}>Settings → Connections → Sungrow</strong>.
        </div>
      </Card>
    );
  }

  const max = Math.max(0.1, ...data.inverters.map((i) => i.dailyKwh));
  const model = data.inverters[0]?.model ?? 'inverter';

  return (
    <Card padded={false} style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: 14, animation: 'v2rise .5s var(--ease-out) .14s' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Eyebrow>Solar inverters · today</Eyebrow>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{data.count}× {model}</span>
      </div>

      {data.inverters.map((inv) => {
        const sm = statusMeta(inv.status, inv.activeFaultCount);
        const tone = sm.tone === 'danger' || sm.tone === 'grid' ? 'grid' : 'solar';
        return (
          <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* 78 px is the design's measure for short names ("Sungrow A"); real
                fleet names run longer, so the column grows to 150 before it clips. */}
            <span style={{ minWidth: 78, maxWidth: 150, flex: 'none', fontSize: 13, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {inv.name}
            </span>
            <div style={{ flex: 1, minWidth: 0, height: 22, borderRadius: 6, background: 'var(--surface-2)', overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
              <i
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${((inv.dailyKwh / max) * 100).toFixed(0)}%`,
                  background: `linear-gradient(90deg, var(--${tone}-dim), var(--${tone}))`,
                  borderRadius: 6,
                  transition: 'width .6s var(--ease-out)',
                }}
              />
            </div>
            <span className="pwr-mono" style={{ fontSize: 12.5, color: 'var(--text-2)', width: 74, textAlign: 'right', flex: 'none' }}>
              {inv.dailyKwh.toFixed(1)} kWh
            </span>
            <Badge tone={sm.tone === 'danger' ? 'danger' : sm.tone === 'grid' ? 'grid' : sm.tone === 'solar' ? 'solar' : 'neutral'} variant="soft">
              {sm.label}
            </Badge>
          </div>
        );
      })}

      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5, textWrap: 'pretty' }}>
        {data.daylight ? (
          <>These are string inverters — an unreachable dongle in <strong style={{ color: 'var(--text-1)' }}>daylight</strong> is a real outage and pages you.</>
        ) : (
          <>It's <strong style={{ color: 'var(--text-1)' }}>night</strong> — the inverters and their WiNet-S dongles sleep with the sun, so "Asleep" is normal and never alerts.</>
        )}
      </div>
    </Card>
  );
}
