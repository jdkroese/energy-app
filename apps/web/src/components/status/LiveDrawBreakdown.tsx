import { Card, Eyebrow, StatTile, Icon } from '../ui';
import type { LiveResponse, DeviceView, ConfiguredDeviceView } from '../../lib/types';

/* Live-draw breakdown (docs/36 §5.3b) — "where the power is going right now": a
 * ranked horizontal-bar list of known consumers, plus a computed
 * "other / unaccounted" = home.kw − Σ known. Unmetered HVAC draws are ESTIMATED
 * and labelled "est." pending the doc-28 breaker metering. Below: today totals.
 *
 * Estimated per-running-HVAC-unit draw (kW). A Panasonic Etherea mid-load is ~1 kW;
 * this is a coarse placeholder until real per-circuit metering lands. */
const HVAC_EST_KW = 1.0;

interface Consumer {
  id: string;
  name: string;
  kw: number;
  tone: string;
  estimated: boolean;
  sub?: string;
}

export function LiveDrawBreakdown({
  live,
  climateDevices,
  configuredDevices,
  wide,
}: {
  live: LiveResponse;
  climateDevices: DeviceView[];
  configuredDevices: ConfiguredDeviceView[];
  wide: boolean;
}) {
  const consumers: Consumer[] = [];

  // Metered breaker (real). live.breaker.powerW is the whole-circuit draw.
  if (live.breaker && live.breaker.powerW > 0) {
    consumers.push({
      id: `breaker-${live.breaker.id}`,
      name: live.breaker.name,
      kw: Math.round((live.breaker.powerW / 1000) * 100) / 100,
      tone: 'var(--grid)',
      estimated: false,
      sub: 'metered',
    });
  }

  // Car charger (real reserved draw) — only when its rule is on.
  for (const d of configuredDevices) {
    const ev = d.evState;
    if (ev && ev.ruleOn && ev.reservedW > 0) {
      consumers.push({
        id: `ev-${d.id}`,
        name: d.name,
        kw: Math.round((ev.reservedW / 1000) * 100) / 100,
        tone: 'var(--ev)',
        estimated: false,
        sub: ev.reason === 'p3' ? 'P3 charging' : ev.reason === 'surplus' ? 'solar charging' : 'reserved',
      });
    }
  }

  // HVAC units currently running (estimated draw until metered).
  const runningHvac = climateDevices.filter((d) => d.online && d.power && (d.type === 'cooling' || d.type === 'heating'));
  for (const d of runningHvac) {
    consumers.push({
      id: `hvac-${d.id}`,
      name: d.name,
      kw: HVAC_EST_KW,
      tone: 'var(--battery)',
      estimated: true,
      sub: `${d.mode}${d.setpointC != null ? ` ${d.setpointC}°` : ''}`,
    });
  }

  const knownKw = consumers.reduce((s, c) => s + c.kw, 0);
  const other = Math.round((live.home.kw - knownKw) * 100) / 100;
  if (other > 0.1) {
    consumers.push({
      id: 'other',
      name: 'Other / unaccounted',
      kw: other,
      tone: 'var(--text-3)',
      estimated: false,
      sub: 'balance of home load',
    });
  }

  consumers.sort((a, b) => b.kw - a.kw);
  const maxKw = Math.max(live.home.kw, ...consumers.map((c) => c.kw), 0.1);
  const anyEstimated = consumers.some((c) => c.estimated);

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <Eyebrow>Live draw</Eyebrow>
        <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
          home {live.home.kw.toFixed(1)} kW
        </span>
      </div>

      {consumers.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>No measurable draw right now.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {consumers.map((c) => (
            <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
                <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                {c.sub && <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{c.sub}</span>}
                <span className="pwr-mono" style={{ marginLeft: 'auto', color: 'var(--text-2)' }}>
                  {c.kw.toFixed(2)} kW
                  {c.estimated && <span style={{ color: 'var(--grid)', marginLeft: 4 }}>est.</span>}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(100, (c.kw / maxKw) * 100)}%`,
                    background: c.tone,
                    opacity: c.estimated ? 0.65 : 1,
                    borderRadius: 3,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {anyEstimated && (
        <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
          "est." draws are unmetered HVAC estimates — real per-circuit figures arrive with breaker metering (doc 28).
        </div>
      )}

      {/* Today totals row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: wide ? 'repeat(4, 1fr)' : 'repeat(2, 1fr)',
          gap: 8,
          marginTop: 2,
          paddingTop: 10,
          borderTop: '1px solid var(--border-1)',
        }}
      >
        <StatTile size="sm" label="Produced" value={live.today.producedKwh.toFixed(1)} unit="kWh" tone="solar" icon={<Icon name="sun" size={13} />} />
        <StatTile size="sm" label="Consumed" value={live.today.consumedKwh.toFixed(1)} unit="kWh" tone="home" icon={<Icon name="house" size={13} />} />
        <StatTile size="sm" label="Grid feed-in" value={live.today.gridFeedInKwh.toFixed(1)} unit="kWh" tone="grid" icon={<Icon name="upload" size={13} />} />
        <StatTile size="sm" label="Saved" value={`€${live.today.savedEur.toFixed(2)}`} tone="solar" icon={<Icon name="piggy-bank" size={13} />} />
      </div>
    </Card>
  );
}
