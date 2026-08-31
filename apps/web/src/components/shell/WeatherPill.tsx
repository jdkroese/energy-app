import { Icon } from '../ui';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { WeatherDay } from '../../lib/types';
import { HoverPanel } from './HoverPanel';

// Current conditions barely change minute to minute — poll gently so the pill
// stays fresh without hammering the Open-Meteo passthrough.
const WEATHER_POLL_MS = 5 * 60_000;

/**
 * Pick a glyph for one forecast day. The daily outlook has no WMO weatherCode
 * (only `current` does), so this derives a look from the three fields it does
 * carry — rain likelihood first (it dominates how the day reads), then cloud
 * cover, then sunshine hours as a tiebreaker for a mostly-clear vs hazy day.
 * Kept as the one place this mapping lives so it doesn't drift per call site.
 */
export function dayWeatherIcon(d: Pick<WeatherDay, 'precipProbabilityPct' | 'cloudPct' | 'sunshineHours'>): string {
  if (d.precipProbabilityPct >= 50) return 'cloud-rain';
  if (d.cloudPct >= 70) return 'cloud';
  if (d.cloudPct >= 30 || d.sunshineHours < 4) return 'cloud-sun';
  return 'sun';
}

function fmtDay(dateIso: string): string {
  // Midday anchor sidesteps a UTC date string rolling to the previous local day.
  return new Date(`${dateIso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short' });
}

const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } as const;
const labelStyle = { color: 'var(--text-3)', fontSize: 12 } as const;
const valueStyle = { fontFamily: 'var(--font-mono)', color: 'var(--text-1)', fontSize: 12.5 } as const;

/**
 * WeatherPill — TopBar/MobileHeader trailing pill: current conditions, expanding
 * on hover/focus/tap into current detail + a 5-day outlook. Every reading is
 * independently nullable (the upstream fetch can fail field-by-field) — each
 * line renders only when its value is present, never a fake number.
 */
export function WeatherPill({ compact = false }: { compact?: boolean }) {
  // Fail-soft: usePolling's `data` is null until the first fetch resolves, and
  // every field on a resolved response is independently nullable (upstream
  // fetch can fail per-field) — the pill still renders (icon + location) with
  // whatever numbers it has, never a fake reading.
  const { data: weather } = usePolling(api.weatherCurrent, WEATHER_POLL_MS);
  const temp = weather?.temperatureC;
  const wind = weather?.windSpeedKmh;
  const feelsLike = weather?.apparentC;
  const humidity = weather?.humidityPct;
  const cloud = weather?.cloudPct;
  const precip = weather?.precipMm;
  const days = weather?.daily ?? [];

  return (
    <HoverPanel
      triggerLabel="Weather. Show current conditions and the 5-day outlook."
      panelLabel="Weather detail"
      triggerStyle={compact ? { padding: '5px 10px', gap: 6 } : undefined}
      trigger={
        <>
          <Icon name="sun" size={16} color="var(--grid)" />
          {temp != null && <span style={{ fontFamily: 'var(--font-mono)' }}>{Math.round(temp)}°</span>}
          {!compact && (
            <span style={{ color: 'var(--text-3)' }}>
              · Jávea{wind != null ? ` · ${Math.round(wind)} km/h` : ''}
            </span>
          )}
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
            Jávea now
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {temp != null && (
              <div style={rowStyle}>
                <span style={labelStyle}>Temperature</span>
                <span style={valueStyle}>{Math.round(temp)}°C</span>
              </div>
            )}
            {feelsLike != null && (
              <div style={rowStyle}>
                <span style={labelStyle}>Feels like</span>
                <span style={valueStyle}>{Math.round(feelsLike)}°C</span>
              </div>
            )}
            {wind != null && (
              <div style={rowStyle}>
                <span style={labelStyle}>Wind</span>
                <span style={valueStyle}>{Math.round(wind)} km/h</span>
              </div>
            )}
            {humidity != null && (
              <div style={rowStyle}>
                <span style={labelStyle}>Humidity</span>
                <span style={valueStyle}>{Math.round(humidity)}%</span>
              </div>
            )}
            {cloud != null && (
              <div style={rowStyle}>
                <span style={labelStyle}>Cloud cover</span>
                <span style={valueStyle}>{Math.round(cloud)}%</span>
              </div>
            )}
            {precip != null && (
              <div style={rowStyle}>
                <span style={labelStyle}>Precipitation</span>
                <span style={valueStyle}>{precip.toFixed(1)} mm</span>
              </div>
            )}
            {temp == null && feelsLike == null && wind == null && humidity == null && cloud == null && precip == null && (
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No live reading right now.</div>
            )}
          </div>
        </div>

        {days.length > 0 && (
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6, borderTop: '1px solid var(--border-1)', paddingTop: 10 }}>
              Next {days.length} days
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {days.map((d) => (
                <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 30, fontSize: 12, color: 'var(--text-2)' }}>{fmtDay(d.date)}</span>
                  <Icon name={dayWeatherIcon(d)} size={15} color="var(--text-3)" />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-1)', width: 34, textAlign: 'right' }}>
                    {Math.round(d.tMaxC)}°
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)', flex: 1 }}>
                    {d.precipMm > 0 || d.precipProbabilityPct > 0
                      ? `${Math.round(d.precipProbabilityPct)}% · ${d.precipMm.toFixed(1)}mm`
                      : 'dry'}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{d.sunshineHours.toFixed(1)}h sun</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </HoverPanel>
  );
}
