// THROWAWAY SPIKE — debug page proving we can detect a press on button 1 of the
// Tuya 4-button Zigbee scene switch and flip an ON/OFF toggle. Polls
// /api/button-test every 1s; the big dot flips each time a new button-1 press is
// detected server-side (via Tuya device logs). Touches no control logic.
//
// Responsive per CLAUDE.md: one centered card that works on desktop (>=768) and
// mobile (<768). Power design system (dark control-room, mono numerals).

import { useEffect, useState } from 'react';
import { getJSON } from '../lib/api';
import { Card, Icon, StatusDot } from '../components/ui';
import type { ShellContext } from '../components/shell/AppShell';

interface PressEvent {
  gesture: string;
  at: number;
}
interface ButtonTestResponse {
  resolved: boolean;
  deviceId: string | null;
  deviceName: string | null;
  online: boolean;
  on: boolean;
  lastPress: PressEvent | null;
  recent: PressEvent[];
  lastError: string | null;
}

function relTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function ButtonTest({ ctx }: { ctx: ShellContext }) {
  const wide = ctx.desktop;
  const [data, setData] = useState<ButtonTestResponse | null>(null);
  // Re-render once a second so relative times tick even without new data.
  const [, setNow] = useState(0);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await getJSON<ButtonTestResponse>('/api/button-test');
        if (alive) setData(d);
      } catch {
        /* keep last good — page must not crash while polling */
      }
      if (alive) setNow((n) => n + 1);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const on = data?.on ?? false;

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        padding: wide ? '32px 24px' : '20px 14px',
      }}
    >
      <Card
        style={{
          width: '100%',
          maxWidth: 440,
          textAlign: 'center',
        }}
      >
        {/* Big circular ON/OFF indicator */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
            padding: wide ? '20px 0 8px' : '12px 0 4px',
          }}
        >
          <div
            aria-label={on ? 'ON' : 'OFF'}
            style={{
              width: wide ? 176 : 148,
              height: wide ? 176 : 148,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all .25s ease',
              background: on ? 'var(--solar-wash)' : 'var(--surface-3)',
              border: `2px solid ${on ? 'var(--solar)' : 'var(--line, var(--grid-line))'}`,
              boxShadow: on
                ? '0 0 36px var(--solar-wash), inset 0 0 24px var(--solar-wash)'
                : 'inset 0 0 18px rgba(0,0,0,0.35)',
            }}
          >
            <Icon
              name="power"
              size={wide ? 64 : 54}
              color={on ? 'var(--solar)' : 'var(--text-2)'}
            />
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: wide ? 30 : 26,
              fontWeight: 600,
              letterSpacing: '0.14em',
              color: on ? 'var(--solar)' : 'var(--text-2)',
            }}
          >
            {on ? 'ON' : 'OFF'}
          </div>
        </div>

        {/* Device line */}
        <div style={{ marginTop: 18, minHeight: 24 }}>
          {data?.resolved ? (
            <StatusDot tone={data.online ? 'solar' : 'offline'} live={data.online}>
              <span style={{ color: 'var(--text-1)', fontSize: 14 }}>
                {data.deviceName ?? data.deviceId}
              </span>
            </StatusDot>
          ) : (
            <span style={{ color: 'var(--text-2)', fontSize: 14 }}>
              Searching for the scene switch in your Tuya fleet…
            </span>
          )}
        </div>

        {/* Last press */}
        <div style={{ marginTop: 16 }}>
          <div style={{ color: 'var(--text-2)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Last press
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 18,
              color: 'var(--text-1)',
              marginTop: 4,
            }}
          >
            {data?.lastPress
              ? `${data.lastPress.gesture} · ${relTime(data.lastPress.at)}`
              : '—'}
          </div>
        </div>

        {/* Recent events */}
        {data?.recent && data.recent.length > 0 && (
          <div
            style={{
              marginTop: 14,
              borderTop: '1px solid var(--grid-line)',
              paddingTop: 10,
              textAlign: 'left',
            }}
          >
            {data.recent.map((e, i) => (
              <div
                key={`${e.at}-${i}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  color: 'var(--text-2)',
                  padding: '3px 4px',
                }}
              >
                <span style={{ color: 'var(--text-1)' }}>{e.gesture}</span>
                <span>{relTime(e.at)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Helper + error */}
        <div style={{ marginTop: 18, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5 }}>
          Press button 1 on the switch — this dot should flip on/off.
        </div>
        {data?.lastError && (
          <div style={{ marginTop: 10, color: 'var(--text-3, var(--text-2))', fontSize: 11, opacity: 0.7 }}>
            {data.lastError}
          </div>
        )}
      </Card>
    </div>
  );
}
