import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { useAuth } from '../../auth/AuthProvider';
import type {
  BlindUnit,
  BlindsResponse,
  DeviceView,
  DevicesResponse,
  HomeScenesResponse,
  LightUnit,
  LightsResponse,
  LiveResponse,
  RadioFavoritesResponse,
  SpeakersResponse,
} from '../../lib/types';
import { Icon } from '../../components/ui';
import { EnergyFlow, type FlowData } from '../../components/energy/EnergyFlow';
import { HomeSceneBuilder } from '../../components/home/HomeSceneBuilder';
import { BigToggle } from './TabletLights';
import { OrderStatusCard, QuickAddGrid, TonightCard, WeekStrip, useTonight } from './kitchenWidgets';

/* ============================================================================
 * TabletHome — the wall-tablet landing screen. A glance strip (clock · weather ·
 * tariff · online), the TONIGHT section (today's planned dinner + "we're out
 * of…" quick-add + week strip + order status — Kitchen Hub P3, integrated on
 * the kiosk home per the owner decision in docs/38 §12), four big status tiles
 * + the live EnergyFlow, a row of one-tap whole-home Scenes (admins get a
 * "Manage" button → the scene builder), and a Favorites grid of the handiest
 * quick controls. Everything reuses the existing control APIs; nothing here
 * can arm batteries, change settings or touch the Mercadona cart.
 * ==========================================================================*/

const fmtKw = (kw: number) => Math.abs(kw).toFixed(1);

function toFlow(d: LiveResponse): FlowData {
  return {
    solar: { name: 'Solar', val: fmtKw(d.solar.kw), unit: 'kW', sub: `${d.solar.arrays?.length || 2} arrays`, kw: d.solar.kw },
    sonnen: { name: 'Sonnen', val: String(Math.round(d.sonnen.soc)), unit: '%', sub: `${d.sonnen.kwh} kWh`, kw: d.sonnen.kw, dir: d.sonnen.dir },
    tesla: { name: 'Tesla', val: String(Math.round(d.tesla.soc)), unit: '%', sub: `${d.tesla.kwh} kWh`, kw: d.tesla.kw, dir: d.tesla.dir },
    grid: { name: 'Grid', val: fmtKw(d.grid.kw), unit: 'kW', sub: d.grid.dir === 'exporting' ? 'Export' : d.grid.dir === 'importing' ? 'Import' : 'Idle', kw: d.grid.kw, dir: d.grid.dir },
    home: { name: 'Home', val: fmtKw(d.home.kw), unit: 'kW', sub: 'Load', kw: d.home.kw },
  };
}

const bandWord = (b: string) => (b === 'P1' ? 'peak' : b === 'P2' ? 'shoulder' : 'off-peak');

export function TabletHome() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const tonight = useTonight();
  const { data: live } = usePolling<LiveResponse>(api.live, 10_000);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  const battSoc = live ? Math.round((live.sonnen.soc + live.tesla.soc) / 2) : null;

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* glance strip */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em' }}>{time}</span>
          <div style={{ lineHeight: 1.3 }}>
            <div style={{ fontSize: 14, color: 'var(--text-1)' }}>{date}</div>
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
              <Icon name="sun" size={13} /> Jávea · 26° clear
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {live && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--solar)', background: 'var(--solar-wash)', border: '1px solid var(--border-1)', padding: '6px 12px', borderRadius: 'var(--radius-pill)' }}>
              {live.tariff.band} · {bandWord(live.tariff.band)} · €{live.tariff.rateEur.toFixed(3)}
            </span>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--solar)' }} /> Online
          </span>
        </div>
      </div>

      {/* Tonight (Kitchen Hub P3, v4 mockup frame 5): dinner card + the kitchen quick column */}
      <div style={{ display: 'flex', gap: 18, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div style={{ flex: '1.3 1 340px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <TonightCard t={tonight} />
        </div>
        <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <QuickAddGrid />
          <WeekStrip t={tonight} />
          <OrderStatusCard />
        </div>
      </div>

      {/* status tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <StatTileBig label="Solar now" icon="sun" tone="var(--solar)" value={live ? fmtKw(live.solar.kw) : '—'} unit="kW" />
        <StatTileBig label="Batteries" icon="battery-charging" tone="var(--battery)" value={battSoc != null ? String(battSoc) : '—'} unit="%" />
        <StatTileBig label="Grid" icon={live?.grid.dir === 'exporting' ? 'upload' : 'download'} tone="var(--grid)" value={live ? fmtKw(live.grid.kw) : '—'} unit={live?.grid.dir === 'exporting' ? 'kW out' : live?.grid.dir === 'importing' ? 'kW in' : 'kW'} />
        <StatTileBig label="Saved today" icon="piggy-bank" tone="var(--solar)" value={live ? `€${live.today.savedEur.toFixed(2)}` : '—'} unit="" />
      </div>

      {/* live flow */}
      {live && (
        <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 16, display: 'flex', justifyContent: 'center' }}>
          <EnergyFlow flow={toFlow(live)} size="lg" />
        </div>
      )}

      {/* scenes */}
      <ScenesRow isAdmin={isAdmin} />

      {/* favorites */}
      <FavoritesGrid />
    </div>
  );
}

function StatTileBig({ label, icon, tone, value, unit }: { label: string; icon: string; tone: string; value: string; unit: string }) {
  return (
    <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
      <div style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name={icon} size={14} color={tone} /> {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 600, color: tone }}>{value}</span>
        {unit && <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{unit}</span>}
      </div>
    </div>
  );
}

/* ---- Scenes row ----------------------------------------------------------- */

function ScenesRow({ isAdmin }: { isAdmin: boolean }) {
  const { data, refetch } = usePolling<HomeScenesResponse>(api.homeScenes.list, 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);

  const apply = (id: string) => {
    if (busy) return;
    setBusy(id);
    setDone(null);
    api.homeScenes
      .apply(id)
      .then(() => {
        setDone(id);
        window.setTimeout(() => setDone((d) => (d === id ? null : d)), 1800);
      })
      .catch(() => undefined)
      .finally(() => setBusy(null));
  };

  const toggleFavorite = (s: { id: string; favorite?: boolean }) => {
    api.homeScenes.favorite(s.id, !s.favorite).then(refetch).catch(() => undefined);
  };

  // Favorites first (the handy ones live at the top of the wall), order otherwise preserved.
  const scenes = useMemo(
    () => [...(data?.scenes ?? [])].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite)),
    [data],
  );

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--text-3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Scenes</h2>
        {isAdmin && (
          <button type="button" onClick={() => setBuilderOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)', color: 'var(--text-2)', padding: '6px 12px', fontSize: 13, cursor: 'pointer' }}>
            <Icon name="sliders-horizontal" size={15} /> Manage
          </button>
        )}
      </div>
      {scenes.length === 0 ? (
        <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: '18px 16px', color: 'var(--text-3)', fontSize: 14 }}>
          {isAdmin ? 'No scenes yet — tap Manage to create one.' : 'No scenes set up yet.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
          {scenes.map((s) => {
            const active = busy === s.id;
            const flash = done === s.id;
            return (
              <div key={s.id} style={{ position: 'relative' }}>
                <button
                  type="button"
                  disabled={active}
                  onClick={() => apply(s.id)}
                  style={{
                    width: '100%',
                    minHeight: 92,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    border: `1px solid ${flash ? 'var(--solar)' : 'var(--border-1)'}`,
                    borderRadius: 'var(--radius-lg)',
                    background: flash ? 'var(--solar-wash)' : 'var(--surface-2)',
                    color: 'var(--text-1)',
                    cursor: active ? 'default' : 'pointer',
                    opacity: active ? 0.6 : 1,
                    transition: 'background .2s, border-color .2s',
                  }}
                >
                  <Icon name={flash ? 'check' : s.icon || 'sparkles'} size={26} color={flash ? 'var(--solar)' : 'var(--text-2)'} />
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={s.favorite ? `Unstar ${s.name}` : `Star ${s.name}`}
                  aria-pressed={!!s.favorite}
                  onClick={() => toggleFavorite(s)}
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    width: 36,
                    height: 36,
                    display: 'grid',
                    placeItems: 'center',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <Icon name="star" size={18} color={s.favorite ? 'var(--solar)' : 'var(--text-3)'} fill={s.favorite ? 'var(--solar)' : 'none'} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {isAdmin && <HomeSceneBuilder open={builderOpen} onClose={() => setBuilderOpen(false)} onSaved={refetch} />}
    </section>
  );
}

/* ---- Favorites ------------------------------------------------------------ */

/** A small, deterministic set of the handiest quick controls (no config in v1):
 *  the first few lights, one climate unit, one blind, and a default radio toggle. */
function FavoritesGrid() {
  const { data: lights, refetch: rLights } = usePolling<LightsResponse>(api.lights.list, 15_000);
  const { data: devices, refetch: rDevices } = usePolling<DevicesResponse>(api.devices.list, 15_000);
  const { data: blinds, refetch: rBlinds } = usePolling<BlindsResponse>(api.blinds.list, 15_000);
  const { data: radio } = usePolling<RadioFavoritesResponse>(api.radio.favorites, 0);
  const { data: speakers } = usePolling<SpeakersResponse>(api.speakers.list, 0);

  const favLights = useMemo(
    () => [...(lights?.devices ?? [])].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 3),
    [lights],
  );
  const favClimate = useMemo(
    () => [...(devices?.devices ?? [])].filter((d) => d.type === 'cooling' || d.type === 'heating').sort((a, b) => (a.roomName || a.name).localeCompare(b.roomName || b.name))[0],
    [devices],
  );
  const favBlind = useMemo(
    () => [...(blinds?.devices ?? [])].sort((a, b) => a.name.localeCompare(b.name))[0],
    [blinds],
  );
  const station = radio?.favorites?.[0];
  const speakerIds = useMemo(() => (speakers?.speakers ?? []).filter((s) => s.online).map((s) => s.id), [speakers]);

  const hasAny = favLights.length > 0 || favClimate || favBlind || (station && speakerIds.length > 0);
  if (!hasAny) return null;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--text-3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Favorites</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
        {favLights.map((l) => <FavLight key={l.id} l={l} refetch={rLights} />)}
        {favClimate && <FavClimate d={favClimate} refetch={rDevices} />}
        {favBlind && <FavBlind b={favBlind} refetch={rBlinds} />}
        {station && speakerIds.length > 0 && <FavRadio name={station.name} stationId={station.id} streamUrl={station.streamUrl} speakerIds={speakerIds} />}
      </div>
    </section>
  );
}

function FavCard({ children }: { children: React.ReactNode }) {
  return <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 14, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 110 }}>{children}</div>;
}

function FavHeader({ icon, tone, name, sub }: { icon: string; tone: string; name: string; sub: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 40, height: 40, borderRadius: 12, flex: 'none', display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: tone }}><Icon name={icon} size={20} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{sub}</div>
      </div>
    </div>
  );
}

function FavLight({ l, refetch }: { l: LightUnit; refetch: () => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const power = on ?? l.power;
  const toggle = () => {
    const next = !power;
    setOn(next);
    api.lights.command(l.id, 'power', next).then(() => setTimeout(refetch, 1200)).catch(() => setOn(null));
  };
  return (
    <FavCard>
      <FavHeader icon="lightbulb" tone={power ? 'var(--grid)' : 'var(--text-3)'} name={l.name} sub={power ? 'On' : 'Off'} />
      <BigToggle on={power} disabled={!l.online} onToggle={toggle} accent="var(--grid)" accentWash="var(--grid-wash)" />
    </FavCard>
  );
}

function FavClimate({ d, refetch }: { d: DeviceView; refetch: () => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const power = on ?? d.power;
  const accent = d.type === 'heating' ? 'var(--grid)' : 'var(--battery)';
  const toggle = () => {
    const next = !power;
    setOn(next);
    api.devices.command(d.id, 'power', next).then(() => setTimeout(refetch, 1200)).catch(() => setOn(null));
  };
  return (
    <FavCard>
      <FavHeader icon={d.type === 'heating' ? 'flame' : 'snowflake'} tone={accent} name={d.roomName || d.name} sub={d.currentTempC != null ? `${d.currentTempC.toFixed(1)}° now` : (power ? 'On' : 'Off')} />
      <BigToggle on={power} disabled={!d.online} onToggle={toggle} accent={accent} accentWash={d.type === 'heating' ? 'var(--grid-wash)' : 'var(--battery-wash)'} />
    </FavCard>
  );
}

function FavBlind({ b, refetch }: { b: BlindUnit; refetch: () => void }) {
  const cmd = (lever: 'open' | 'close') => api.blinds.command(b.id, lever).then(() => setTimeout(refetch, 1500)).catch(() => undefined);
  return (
    <FavCard>
      <FavHeader icon="blinds" tone="var(--home)" name={b.name} sub={(b.positionPct ?? 0) > 1 ? 'Open' : 'Closed'} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" disabled={!b.online} onClick={() => cmd('open')} style={favBtn}><Icon name="chevron-up" size={18} /> Open</button>
        <button type="button" disabled={!b.online} onClick={() => cmd('close')} style={favBtn}><Icon name="chevron-down" size={18} /> Close</button>
      </div>
    </FavCard>
  );
}

const favBtn: React.CSSProperties = {
  flex: 1,
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  border: '1px solid var(--border-2)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-3)',
  color: 'var(--text-1)',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

function FavRadio({ name, stationId, streamUrl, speakerIds }: { name: string; stationId: string; streamUrl: string; speakerIds: string[] }) {
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    if (playing) {
      setPlaying(false);
      api.radio.stop(speakerIds).catch(() => undefined);
    } else {
      setPlaying(true);
      api.radio.play({ stationId, streamUrl, name, speakerIds, volumePct: 25 }).catch(() => setPlaying(false));
    }
  };
  return (
    <FavCard>
      <FavHeader icon="radio" tone="var(--solar)" name={name} sub={playing ? 'Playing' : 'Tap to play'} />
      <button type="button" onClick={toggle} style={{ ...favBtn, background: playing ? 'var(--solar-wash)' : 'var(--surface-3)', color: playing ? 'var(--solar)' : 'var(--text-1)' }}>
        <Icon name={playing ? 'square' : 'play'} size={18} /> {playing ? 'Stop' : 'Play'}
      </button>
    </FavCard>
  );
}
