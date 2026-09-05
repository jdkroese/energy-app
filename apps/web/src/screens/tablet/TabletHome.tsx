import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { useAuth } from '../../auth/AuthProvider';
import type {
  BlindUnit,
  BlindsResponse,
  BrainPlanResponse,
  DeviceView,
  DevicesResponse,
  HistoryDayResponse,
  HomeScenesResponse,
  LightUnit,
  LightsResponse,
  LiveResponse,
  RadioFavoritesResponse,
  SpeakersResponse,
} from '../../lib/types';
import { Badge, Card, Eyebrow, Icon } from '../../components/ui';
import { EnergyFlow, type FlowData } from '../../components/energy/EnergyFlow';
import { combinedSoc, deriveVerdict } from '../../components/energy/VerdictHero';
import { aggregateDay, eur } from '../../lib/dayMetrics';
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

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* The V2 wall board (docs/53): clock + verdict + four glanceable tiles beside
          the live flow. Everything the room needs from across the kitchen, in one
          screenful. The Tonight / Scenes / Favorites sections below are the
          reach-out-and-touch half of the wall tablet and are unchanged. */}
      <KioskBoard live={live ?? null} time={time} date={date} />

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

      {/* scenes */}
      <ScenesRow isAdmin={isAdmin} />

      {/* favorites */}
      <FavoritesGrid />
    </div>
  );
}

/* ---- V2 wall board -------------------------------------------------------- */

/**
 * The kiosk's first screen: the verdict, big enough to read from the doorway,
 * beside the live flow. It shares deriveVerdict() with the Live screen, so the
 * wall and the phone can never disagree about what Autopilot is doing.
 */
function KioskBoard({ live, time, date }: { live: LiveResponse | null; time: string; date: string }) {
  const { data: plan } = usePolling<BrainPlanResponse>(api.brainPlan, 60_000);
  const { data: day } = usePolling<HistoryDayResponse>(api.historyDayToday, 60_000);

  if (!live) return null;

  const now = plan?.now ?? new Date().getHours();
  const next = plan?.actions.find((a) => a.startH > now) ?? plan?.actions[0] ?? null;
  const hhmm = (h: number) =>
    String(Math.floor(h) % 24).padStart(2, '0') + ':' + String(Math.round((h % 1) * 60) % 60).padStart(2, '0');
  const v = deriveVerdict(live, next?.title ?? null, next ? hhmm(next.startH) : null);
  const agg = day ? aggregateDay(day) : null;

  const tiles: { label: string; value: string; unit: string; tone: string }[] = [
    { label: 'Solar', value: fmtKw(live.solar.kw), unit: 'kW', tone: 'solar' },
    { label: 'Load', value: fmtKw(live.home.kw), unit: 'kW', tone: 'home' },
    { label: 'Storage', value: String(combinedSoc(live)), unit: '%', tone: 'battery' },
    { label: 'Saved', value: agg ? eur(agg.savedEur) : `€${live.today.savedEur.toFixed(2)}`, unit: '', tone: 'solar' },
  ];

  return (
    <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'minmax(0,1.12fr) minmax(0,.88fr)', gap: 20, alignItems: 'stretch' }}>
      {/* The wall's one decorative layer — a slow drift so the board reads as live
          from across the room without anything actually moving. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: '-40% -12% auto -12%',
          height: '110%',
          background:
            'radial-gradient(55% 60% at 28% 45%, var(--solar-wash), transparent 70%), radial-gradient(50% 60% at 80% 25%, var(--battery-wash), transparent 70%)',
          filter: 'blur(34px)',
          animation: 'v2amb 30s var(--ease-in-out) infinite',
          pointerEvents: 'none',
        }}
      />

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <div style={{ animation: 'v2rise .5s var(--ease-out)' }}>
          <div className="pwr-mono" style={{ fontSize: 60, fontWeight: 500, letterSpacing: '-.02em', lineHeight: 1 }}>{time}</div>
          <div style={{ fontSize: 14, color: 'var(--text-2)', marginTop: 4 }}>
            {date} · {live.tariff.band} {bandWord(live.tariff.band)} · €{live.tariff.rateEur.toFixed(3)}/kWh
          </div>
        </div>

        <Card
          accent={v.tone}
          glow
          padded={false}
          style={{ flex: 1, padding: 20, display: 'flex', flexDirection: 'column', gap: 11, justifyContent: 'center', animation: 'v2rise .5s var(--ease-out) .08s' }}
        >
          <Eyebrow>Autopilot · {v.state}</Eyebrow>
          <div style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-.02em', lineHeight: 1.15, textWrap: 'pretty' }}>{v.title}</div>
          <div style={{ fontSize: 15, color: 'var(--text-2)', lineHeight: 1.5, textWrap: 'pretty' }}>{v.because}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
            <Badge tone="solar" variant="soft">Self-sufficient {agg ? agg.selfSufficiencyPct : live.today.selfSufficiencyPct}%</Badge>
            <Badge tone="battery" variant="soft">Storage {combinedSoc(live)}%</Badge>
          </div>
        </Card>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, animation: 'v2rise .5s var(--ease-out) .16s' }}>
          {tiles.map((t) => (
            <Card key={t.label} padded={false} style={{ padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-2)' }}>{t.label}</div>
              <div className="pwr-mono" style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 10, fontWeight: 500, color: `var(--${t.tone})`, lineHeight: 1 }}>
                <span style={{ fontSize: 24 }}>{t.value}</span>
                {t.unit && <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t.unit}</span>}
              </div>
            </Card>
          ))}
        </div>
      </div>

      <Card
        accent="solar"
        title="Live flow"
        subtitle="10-second polling"
        actions={
          <Badge tone="solar" variant="soft">
            <i style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--solar)', animation: 'v2breathe 2.2s var(--ease-in-out) infinite' }} />
            Live
          </Badge>
        }
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0, animation: 'v2rise .5s var(--ease-out) .12s' }}
      >
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <EnergyFlow flow={toFlow(live)} size="lg" />
        </div>
      </Card>
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
