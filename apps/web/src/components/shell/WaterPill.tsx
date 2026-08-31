import { Link } from 'react-router-dom';
import { Icon } from '../ui';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { HoverPanel } from './HoverPanel';

// The BI-WATER/Contazara meter reports HOURLY totals uploaded roughly once a
// day — there is no instantaneous flow reading, and there never will be from
// this hardware. Poll gently; 5 min is already far more often than the data
// changes, this just keeps the "Xh ago" age line honest without hammering it.
const WATER_POLL_MS = 5 * 60_000;

const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } as const;
const labelStyle = { color: 'var(--text-3)', fontSize: 12 } as const;
const valueStyle = { fontFamily: 'var(--font-mono)', color: 'var(--text-1)', fontSize: 12.5 } as const;

function fmtL(l: number): string {
  return `${Math.round(l).toLocaleString('en-GB')} L`;
}

function fmtAge(hours: number | null): string | null {
  if (hours == null) return null;
  if (hours < 1) return 'under 1h ago';
  return `${Math.round(hours)}h ago`;
}

/**
 * WaterPill — TopBar/MobileHeader trailing pill, next to the weather. Shows the
 * freshest KNOWN litres, always with an explicit age — this meter is a
 * ~daily-upload hourly feed, not live, so there is deliberately no pulsing
 * "live" dot or "now" language anywhere in this component. Renders nothing
 * when the meter isn't configured yet (the state the app actually ships in
 * until the owner connects it) — an empty pill would just be noise.
 */
export function WaterPill({ compact = false }: { compact?: boolean }) {
  const { data } = usePolling(api.water.snapshot, WATER_POLL_MS);
  if (!data || !data.configured) return null;

  const { today, meter, period } = data;
  const age = fmtAge(meter?.staleHours ?? null);

  return (
    <HoverPanel
      triggerLabel={`Water. ${fmtL(today.totalL)} so far today${age ? `, as of ${age}` : ''}. Show detail.`}
      panelLabel="Water detail"
      triggerStyle={compact ? { padding: '5px 10px', gap: 6 } : undefined}
      trigger={
        <>
          <Icon name="droplet" size={16} color="var(--water)" />
          <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtL(today.totalL)}</span>
          {age && <span style={{ color: 'var(--text-3)' }}>· {age}</span>}
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
            Today
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={rowStyle}>
              <span style={labelStyle}>Total</span>
              <span style={valueStyle}>{fmtL(today.totalL)}</span>
            </div>
            <div style={rowStyle}>
              <span style={{ ...labelStyle, color: 'var(--series-water-household)' }}>Household</span>
              <span style={valueStyle}>{fmtL(today.householdL)}</span>
            </div>
            <div style={rowStyle}>
              <span style={{ ...labelStyle, color: 'var(--series-water-irrigation)' }}>Irrigation</span>
              <span style={valueStyle}>{fmtL(today.irrigationL)}</span>
            </div>
            <div style={rowStyle}>
              <span style={{ ...labelStyle, color: 'var(--series-water-unexplained)' }}>Unexplained</span>
              <span style={valueStyle}>{fmtL(today.unexplainedL)}</span>
            </div>
          </div>
        </div>

        {period && (
          <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 10 }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
              This billing period
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={rowStyle}>
                <span style={labelStyle}>Used of projected</span>
                <span style={valueStyle}>
                  {period.m3ToDate.toFixed(1)} of {period.projectedM3.toFixed(1)} m³
                </span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Band rate</span>
                <span style={valueStyle}>€{period.bandRateEurM3.toFixed(2)}/m³</span>
              </div>
            </div>
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {meter?.lastReadingIso
              ? `Last read ${new Date(meter.lastReadingIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${age ? `, ${age}` : ''}`
              : 'No reading yet'}
            {' · not a live flow — the meter uploads hourly totals roughly once a day'}
          </div>
          <Link
            to="/water"
            style={{ fontSize: 12.5, color: 'var(--water)', display: 'flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}
          >
            View Water <Icon name="chevron-right" size={13} />
          </Link>
        </div>
      </div>
    </HoverPanel>
  );
}
