import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { setKioskEnabled } from '../../lib/kiosk';
import type { AlarmStatus, LiveResponse } from '../../lib/types';
import { Icon } from '../ui/Icon';
import { TabletHome } from '../../screens/tablet/TabletHome';
import { TabletLights } from '../../screens/tablet/TabletLights';
import { TabletClimate } from '../../screens/tablet/TabletClimate';
import { TabletShades } from '../../screens/tablet/TabletShades';

/* ============================================================================
 * TabletShell — the WALL-TABLET (kiosk) frame. A landscape, big-touch, dark
 * surface for a kitchen display: scrollable content on top, a fat bottom nav
 * with a persistent Panic button, an idle/ambient clock after 90s, and a
 * hidden long-press/3-tap escape hatch back to the normal app. It renders its
 * own routes (tab state), so AppShell mounts it standalone — no children.
 *
 * The four content screens (Home/Lights/Climate/Shades) self-fetch; this shell
 * only owns chrome: nav, panic, idle overlay, and the exit affordance.
 * ==========================================================================*/

type TabId = 'home' | 'lights' | 'climate' | 'shades';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'lights', label: 'Lights', icon: 'lightbulb' },
  { id: 'climate', label: 'Climate', icon: 'thermometer' },
  { id: 'shades', label: 'Shades', icon: 'blinds' },
];

/** Idle timeout (ms) before the ambient clock fades in. */
const IDLE_MS = 90_000;

export function TabletShell() {
  const [tab, setTab] = useState<TabId>('home');

  // ---- House alarm (panic) — same 5s status poll the rest of the app uses ----
  const { data: alarm, refetch: refetchAlarm } = usePolling<AlarmStatus>(api.alarm.status, 5_000);
  const alarmActive = alarm?.active ?? false;
  const [alarmBusy, setAlarmBusy] = useState(false);

  const onPanic = async () => {
    if (alarmBusy) return;
    if (alarmActive) {
      setAlarmBusy(true);
      try {
        await api.alarm.stop();
        refetchAlarm();
      } finally {
        setAlarmBusy(false);
      }
      return;
    }
    // Big touch target → a plain confirm is fine for v1 (the screens agent may
    // swap in a tablet-styled ConfirmDialog later).
    if (!window.confirm('Trigger the house alarm? Siren + blinking lights until you stop it.')) return;
    setAlarmBusy(true);
    try {
      await api.alarm.trigger();
      refetchAlarm();
    } finally {
      setAlarmBusy(false);
    }
  };

  // ---- Idle / ambient overlay -----------------------------------------------
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);
  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    const onActivity = () => wake();
    const opts = { passive: true } as const;
    window.addEventListener('pointerdown', onActivity, opts);
    window.addEventListener('pointermove', onActivity, opts);
    window.addEventListener('keydown', onActivity);
    return () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('pointermove', onActivity);
      window.removeEventListener('keydown', onActivity);
    };
  }, [wake]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg-0)',
        color: 'var(--text-1)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {alarmActive && (
        <div
          role="alert"
          style={{
            flex: 'none',
            textAlign: 'center',
            padding: '8px 16px',
            background: 'var(--danger)',
            color: '#fff',
            fontWeight: 800,
            letterSpacing: '0.06em',
            fontSize: 14,
          }}
        >
          HOUSE ALARM ACTIVE — tap PANIC to stop
        </div>
      )}

      {/* Scrollable content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative' }}>
        <ExitAffordance />
        {tab === 'home' && <TabletHome />}
        {tab === 'lights' && <TabletLights />}
        {tab === 'climate' && <TabletClimate />}
        {tab === 'shades' && <TabletShades />}
      </div>

      {/* Fat bottom nav + persistent Panic */}
      <nav
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'stretch',
          gap: 4,
          padding: 6,
          borderTop: '1px solid var(--border-1)',
          background: 'var(--surface-1)',
        }}
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={active}
              style={{
                flex: 1,
                minHeight: 64,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                border: '1px solid transparent',
                borderRadius: 'var(--radius-md)',
                background: active ? 'var(--surface-3)' : 'transparent',
                color: active ? 'var(--solar)' : 'var(--text-2)',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 700,
              }}
            >
              <Icon name={t.icon} size={26} />
              <span>{t.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          disabled={alarmBusy}
          onClick={() => void onPanic()}
          aria-label={alarmActive ? 'Stop the house alarm' : 'Trigger the house alarm'}
          style={{
            flex: 'none',
            minWidth: 110,
            minHeight: 64,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            border: '1px solid var(--danger)',
            borderRadius: 'var(--radius-md)',
            background: alarmActive ? 'var(--danger)' : 'var(--danger-wash, rgba(255,90,90,0.12))',
            color: alarmActive ? '#fff' : 'var(--danger)',
            cursor: alarmBusy ? 'default' : 'pointer',
            opacity: alarmBusy ? 0.7 : 1,
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: '0.04em',
          }}
        >
          <Icon name={alarmActive ? 'square' : 'siren'} size={26} color={alarmActive ? '#fff' : 'var(--danger)'} />
          <span>{alarmActive ? 'STOP' : 'PANIC'}</span>
        </button>
      </nav>

      {idle && <IdleScreen onWake={wake} />}
    </div>
  );
}

/* ---- Idle / ambient screen — huge live clock + a one-line house status ----- */

function IdleScreen({ onWake }: { onWake: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  // Slow ambient poll — the idle screen isn't a control surface.
  const { data: live } = usePolling<LiveResponse>(api.live, 30_000);

  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const statusLine = live
    ? `${live.solar.kw.toFixed(1)} kW solar · ${Math.round(live.sonnen.soc)}% battery · grid ${live.grid.dir} · ${Math.round(
        live.today.selfSufficiencyPct,
      )}% self-sufficient`
    : '—';

  return (
    <div
      onPointerDown={onWake}
      onKeyDown={onWake}
      role="button"
      tabIndex={0}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1000,
        background: 'var(--bg-0)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        cursor: 'pointer',
        textAlign: 'center',
        padding: 24,
      }}
    >
      <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: '22vw', lineHeight: 1, color: 'var(--text-1)' }}>
        {time}
      </div>
      <div style={{ fontSize: '3.2vw', color: 'var(--text-2)' }}>{date}</div>
      <div style={{ fontSize: '2.8vw', color: 'var(--text-3)' }}>Jávea · 26°</div>
      <div style={{ marginTop: 18, fontSize: '2.2vw', fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>{statusLine}</div>
      <div style={{ marginTop: 24, fontSize: '1.8vw', color: 'var(--text-3)' }}>Tap anywhere to wake</div>
    </div>
  );
}

/* ---- Exit affordance — hidden gear, long-press (~2s) OR 3-tap reveals Exit -- */

function ExitAffordance() {
  const [revealed, setRevealed] = useState(false);
  const taps = useRef(0);
  const tapTimer = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);

  const clearHold = () => {
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };
  const onDown = () => {
    holdTimer.current = window.setTimeout(() => setRevealed(true), 2_000);
  };
  const onUp = () => {
    clearHold();
    // 3-tap fallback within a short window.
    taps.current += 1;
    if (tapTimer.current) window.clearTimeout(tapTimer.current);
    if (taps.current >= 3) {
      taps.current = 0;
      setRevealed(true);
      return;
    }
    tapTimer.current = window.setTimeout(() => {
      taps.current = 0;
    }, 1_200);
  };

  return (
    <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 5, display: 'flex', alignItems: 'center', gap: 8 }}>
      {revealed && (
        <button
          type="button"
          onClick={() => setKioskEnabled(false)}
          style={{
            minHeight: 40,
            padding: '0 14px',
            border: '1px solid var(--border-2)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-2)',
            color: 'var(--text-1)',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Exit tablet mode
        </button>
      )}
      <button
        type="button"
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerLeave={clearHold}
        aria-label="Tablet settings"
        title="Hold or triple-tap to exit"
        style={{
          width: 40,
          height: 40,
          display: 'grid',
          placeItems: 'center',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          background: 'transparent',
          color: 'var(--text-3)',
          opacity: 0.4,
          cursor: 'pointer',
        }}
      >
        <Icon name="settings" size={18} />
      </button>
    </div>
  );
}
