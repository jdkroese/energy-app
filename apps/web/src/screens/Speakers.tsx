import { useState } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { SpeakersResponse, AlarmStatus, SonosSpeaker } from '../lib/types';
import { Card, Icon, Slider, Button } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { RadioPanel, RadioSchedulesSection } from '../components/radio/Radio';

/* ============================================================================
 * Speakers — the Sonos fleet (local UPnP): per-speaker volume + Test. The house
 * alarm is triggered from the nav alarm button (everywhere) and configured in
 * Settings → Notifications, so this screen no longer carries a trigger button.
 * Music-from-the-app is a later phase. Responsive across desktop + mobile per the
 * web+mobile standing rule. Reads poll /api/speakers; writes are admin-gated
 * server-side.
 * ==========================================================================*/

/** Compact mm:ss for the alarm countdown. */
function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ---- ALARM panel (trigger + active state) -------------------------------- */

export function AlarmControl({
  alarm,
  canControl,
  onChanged,
  compact,
}: {
  alarm: AlarmStatus | null;
  canControl: boolean;
  onChanged: () => void;
  compact?: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = alarm?.active ?? false;

  const trigger = async () => {
    setBusy(true);
    try {
      await api.alarm.trigger(); // defaults: all lights, ~120s, ~70% volume
      onChanged();
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await api.alarm.stop();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  if (active) {
    return (
      <Card
        padded
        style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: compact ? '12px 14px' : 18,
          background: 'var(--danger-wash, rgba(255,90,90,0.12))', border: '1px solid var(--danger)',
        }}
      >
        <span style={{ width: 40, height: 40, borderRadius: 11, flex: 'none', display: 'grid', placeItems: 'center', background: 'var(--danger)', color: '#fff', animation: 'pwrAlarmPulse 0.9s ease-in-out infinite' }}>
          <Icon name="siren" size={22} />
        </span>
        <style>{`@keyframes pwrAlarmPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.45 } }`}</style>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--danger)', letterSpacing: '0.02em' }}>ALARM ACTIVE</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
            Siren + lights blinking
            {alarm?.remainingSec != null && alarm.remainingSec > 0 ? ` · auto-stop in ${mmss(alarm.remainingSec)}` : ''}
          </div>
        </div>
        {canControl ? (
          <Button variant="danger" size={compact ? 'sm' : 'md'} loading={busy} onClick={() => void stop()}>STOP</Button>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>admin only</span>
        )}
      </Card>
    );
  }

  return (
    <>
      <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: compact ? 14 : 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, flex: 'none', display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--danger)' }}>
            <Icon name="siren" size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)' }}>House alarm</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Siren on all speakers + all lights blink</div>
          </div>
        </div>
        <button
          type="button"
          disabled={!canControl}
          onClick={() => setConfirm(true)}
          style={{
            width: '100%', padding: '16px 18px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--danger)',
            background: 'var(--danger)', color: '#fff', fontSize: 17, fontWeight: 800, letterSpacing: '0.06em',
            cursor: canControl ? 'pointer' : 'not-allowed', opacity: canControl ? 1 : 0.5,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          }}
        >
          <Icon name="siren" size={20} color="#fff" />
          TRIGGER ALARM
        </button>
        {!canControl && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Read-only — only an admin can trigger the alarm.</div>}
      </Card>
      <ConfirmDialog
        open={confirm}
        title="Sound the house alarm?"
        body="This plays a loud siren on every Sonos speaker and blinks all lights. It auto-stops after ~2 minutes, or use STOP."
        confirmLabel="Sound alarm"
        cancelLabel="Cancel"
        tone="danger"
        onConfirm={() => void trigger()}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

/* ---- one speaker row (volume + test) ------------------------------------- */

function SpeakerRow({ s, wide, canControl, onChanged }: {
  s: SonosSpeaker; wide: boolean; canControl: boolean; onChanged: () => void;
}) {
  const [vol, setVol] = useState<number>(s.volumePct ?? 30);
  const [testing, setTesting] = useState(false);

  const sendVol = (v: number) => {
    setVol(v);
    void api.speakers.setVolume(s.id, v);
  };
  const test = async () => {
    setTesting(true);
    try {
      await api.speakers.test(s.id);
    } finally {
      setTesting(false);
      onChanged();
    }
  };

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 10, opacity: s.online ? 1 : 0.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, flex: 'none', display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--solar)' }}>
          <Icon name="volume-2" size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-3)' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.online ? 'var(--solar)' : 'var(--text-3)', flex: 'none' }} />
            {s.groupName || s.name}{s.coordinator ? '' : ' · grouped'}
          </div>
        </div>
        {canControl && (
          <Button variant="secondary" size="sm" loading={testing} onClick={() => void test()}>Test</Button>
        )}
      </div>
      <Slider
        label="Volume"
        min={0}
        max={100}
        value={vol}
        unit="%"
        onChange={(v) => canControl && sendVol(v)}
      />
    </Card>
  );
}

/* ---- the Speakers content (embedded in Devices → Speakers tab) ------------ */

export function SpeakersPanel({ ctx }: { ctx: ShellContext }) {
  const { user } = useAuth();
  const canControl = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt, refetch } = usePolling<SpeakersResponse>(api.speakers.list, 20_000);

  const speakers = [...(data?.speakers ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      {!data && loading && <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>Discovering speakers…</Card>}

      {data && !data.enabled && (
        <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)', flex: 'none' }}>
            <Icon name="volume-x" size={16} />
          </span>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
            Sonos is turned off. Enable it in <strong style={{ color: 'var(--text-1)' }}>Settings → Sonos</strong>.
          </div>
        </Card>
      )}

      {data && data.enabled && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, maxWidth: wide ? 360 : '100%' }}>
            <SChip label="Speakers" value={String(data.context.deviceCount)} />
            <SChip label="Discovered" value={String(data.discoveredCount)} color="var(--solar)" accent />
          </div>
          {data.lastError && (
            <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>
              {data.lastError}
            </div>
          )}
          {speakers.length === 0 ? (
            <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
              No Sonos speakers found on the LAN. If this host has multiple network adapters, set a seed IP in Settings → Sonos.
            </Card>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(auto-fill, minmax(260px, 1fr))' : '1fr', gap: 12 }}>
              {speakers.map((s) => (
                <SpeakerRow key={s.id} s={s} wide={wide} canControl={canControl} onChanged={refetch} />
              ))}
            </div>
          )}

          {/* Internet radio — favourites grid + play on chosen speakers + schedules. */}
          <RadioPanel speakers={speakers} canControl={canControl} wide={wide} />
          <RadioSchedulesSection speakers={speakers} canControl={canControl} wide={wide} />
        </>
      )}
    </div>
  );
}

function SChip({ label, value, color, accent }: { label: string; value: string; color?: string; accent?: boolean }) {
  return (
    <div style={{
      background: accent ? 'var(--solar-wash)' : 'var(--surface-1)',
      border: `1px solid ${accent ? 'var(--border-solar)' : 'var(--border-1)'}`,
      borderRadius: 'var(--radius-md)', padding: '8px 12px', textAlign: 'right', minWidth: 0,
    }}>
      <div className="pwr-eyebrow" style={{ color: accent ? 'var(--solar-dim)' : 'var(--text-3)' }}>{label}</div>
      <div className="pwr-mono" style={{ fontSize: 16, marginTop: 2, color: color ?? 'var(--text-1)' }}>{value}</div>
    </div>
  );
}

/* ---- app-wide active banner — a thin STOP strip shown on every screen while the
 *  alarm is sounding. Cheap: one shared 5s poll. Hidden when idle. ----------- */

export function AlarmActiveBanner() {
  const { user } = useAuth();
  const canControl = user?.role === 'admin';
  const { data: alarm, refetch } = usePolling<AlarmStatus>(api.alarm.status, 5_000);
  const [busy, setBusy] = useState(false);
  if (!alarm?.active) return null;
  const stop = async () => {
    setBusy(true);
    try { await api.alarm.stop(); refetch(); } finally { setBusy(false); }
  };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
      background: 'var(--danger)', color: '#fff', position: 'sticky', top: 0, zIndex: 900,
    }}>
      <Icon name="siren" size={16} color="#fff" />
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, letterSpacing: '0.03em' }}>
        ALARM ACTIVE
        {alarm.remainingSec != null && alarm.remainingSec > 0 ? ` · ${mmss(alarm.remainingSec)}` : ''}
      </span>
      {canControl && (
        <button type="button" disabled={busy} onClick={() => void stop()} style={{ background: '#fff', color: 'var(--danger)', border: 'none', borderRadius: 'var(--radius-pill)', padding: '4px 14px', fontSize: 12.5, fontWeight: 800, cursor: 'pointer' }}>STOP</button>
      )}
    </div>
  );
}

/* ---- standalone /alarm route — a big button for a phone home-screen shortcut */

export function AlarmScreen({ ctx }: { ctx: ShellContext }) {
  const { user } = useAuth();
  const canControl = user?.role === 'admin';
  const { data: alarm, refetch } = usePolling<AlarmStatus>(api.alarm.status, 4_000);
  const wide = ctx.desktop;
  return (
    <div style={{ maxWidth: 520, margin: '0 auto', width: '100%', padding: wide ? '24px 0' : '16px 14px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ textAlign: 'center' }}>
        <div className="pwr-eyebrow" style={{ color: 'var(--text-3)' }}>Home</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-1)' }}>House alarm</div>
      </div>
      <AlarmControl alarm={alarm ?? null} canControl={canControl} onChanged={refetch} />
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', textAlign: 'center', lineHeight: 1.5 }}>
        Add this page to your phone home screen, or wire a phone Shortcut to POST /api/alarm/trigger, for a one-tap panic button.
      </div>
    </div>
  );
}
