import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type {
  RadioStation, RadioFavoritesResponse, RadioSearchResult, SonosFavoritesResponse,
  RadioSchedule, RadioSchedulesResponse, SonosSpeaker,
  RadioNowPlaying, RadioNowPlayingResponse,
} from '../../lib/types';
import { RADIO_FAVORITE_SLOTS } from '../../lib/types';
import { Card, Icon, Button, Switch, Slider, SegmentedControl, Input, Select } from '../ui';

/* ============================================================================
 * Sonos internet radio — a 10-slot favourites grid + an add-station flow (search
 * the online directory / paste a URL / import from the Sonos system), play a saved
 * station on chosen speakers at a chosen volume with a now-playing + Stop, and a
 * radio schedule editor (mirrors the light-schedule model). Built to the Power
 * design system; responsive across desktop + mobile.
 * ==========================================================================*/

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/* ---- modal shell --------------------------------------------------------- */
function Overlay({ title, icon = 'radio', onClose, children, footer, wide }: {
  title: string; icon?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,8,10,0.66)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center', padding: 16 }}
    >
      <div style={{ width: '100%', maxWidth: wide ? 560 : 460, maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--surface-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '15px 18px', borderBottom: '1px solid var(--border-1)' }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--solar-wash)', color: 'var(--solar)', flex: 'none' }}><Icon name={icon} size={16} /></span>
          <div style={{ fontSize: 15.5, fontWeight: 600, flex: 1 }}>{title}</div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4 }}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
        {footer && <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 18px', borderTop: '1px solid var(--border-1)' }}>{footer}</div>}
      </div>
    </div>
  );
}

/* ---- station logo (favicon, falls back to an icon) ----------------------- */
function StationLogo({ logo, size = 36 }: { logo?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (logo && !broken) {
    return (
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
        style={{ width: size, height: size, borderRadius: 9, objectFit: 'cover', flex: 'none', background: 'var(--surface-3)' }}
      />
    );
  }
  return (
    <span style={{ width: size, height: size, borderRadius: 9, flex: 'none', display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--solar)' }}>
      <Icon name="radio" size={Math.round(size * 0.5)} />
    </span>
  );
}

/* ---- days picker --------------------------------------------------------- */
function DaysPicker({ days, onToggle }: { days: number[]; onToggle: (d: number) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {DOW.map((label, d) => {
        const on = days.includes(d);
        return (
          <button key={d} type="button" onClick={() => onToggle(d)} style={{
            flex: 1, padding: '7px 0', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            border: `1px solid ${on ? 'var(--solar)' : 'var(--border-2)'}`,
            background: on ? 'var(--solar-wash)' : 'transparent', color: on ? 'var(--solar)' : 'var(--text-3)',
          }}>{label}</button>
        );
      })}
    </div>
  );
}

/* ---- speaker multi-select ------------------------------------------------ */
function SpeakerPicker({ speakers, selected, onToggle }: {
  speakers: SonosSpeaker[]; selected: string[]; onToggle: (id: string) => void;
}) {
  if (speakers.length === 0) return <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No speakers found.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
      {speakers.map((s, i) => {
        const on = selected.includes(s.id);
        return (
          <button key={s.id} type="button" onClick={() => onToggle(s.id)} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'pointer', textAlign: 'left',
            border: 'none', borderTop: i === 0 ? 'none' : '1px solid var(--border-1)',
            background: on ? 'var(--surface-2)' : 'transparent', color: 'var(--text-1)',
          }}>
            <span style={{
              width: 18, height: 18, borderRadius: 5, flex: 'none', display: 'grid', placeItems: 'center', color: 'var(--accent-contrast)',
              border: on ? 'none' : '1.5px solid var(--border-3)', background: on ? 'var(--solar)' : 'transparent',
            }}>{on && <Icon name="check" size={12} />}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================================
 * Add-station flow (3 tabs: Search / Paste URL / Import from Sonos)
 * ==========================================================================*/
type AddTab = 'search' | 'url' | 'import';

function AddStationModal({ slot, wide, onClose, onSaved }: {
  slot: number; wide: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [tab, setTab] = useState<AddTab>('search');
  const [busy, setBusy] = useState(false);

  const save = async (station: { name: string; streamUrl: string; logo?: string; codec?: string }) => {
    setBusy(true);
    try {
      await api.radio.createFavorite({ ...station, slot });
      onSaved();
      onClose();
    } catch { setBusy(false); }
  };

  return (
    <Overlay title={`Add station · slot ${slot + 1}`} onClose={onClose} wide={wide}>
      <SegmentedControl block value={tab} options={[
        { value: 'search', label: 'Search' },
        { value: 'url', label: 'Paste URL' },
        { value: 'import', label: 'From Sonos' },
      ]} onChange={(v) => setTab(v as AddTab)} />
      {tab === 'search' && <SearchTab busy={busy} onPick={save} />}
      {tab === 'url' && <UrlTab busy={busy} onSave={save} onCancel={onClose} />}
      {tab === 'import' && <ImportTab busy={busy} onPick={save} />}
    </Overlay>
  );
}

function SearchTab({ busy, onPick }: { busy: boolean; onPick: (s: { name: string; streamUrl: string; logo?: string; codec?: string }) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<RadioSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    const term = q.trim();
    if (!term) return;
    setSearching(true); setErr(null);
    try {
      const r = await api.radio.search(term);
      setResults(r.results);
      if (r.results.length === 0) setErr(r.error || 'No stations found.');
    } catch (e) { setErr((e as Error).message); } finally { setSearching(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <form onSubmit={(e) => { e.preventDefault(); void run(); }} style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}><Input placeholder="Search stations (e.g. BBC, jazz, Cadena…)" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
        <Button size="md" variant="primary" type="submit" loading={searching}>Search</Button>
      </form>
      {err && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{err}</div>}
      {results.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', overflow: 'hidden', maxHeight: 320, overflowY: 'auto' }}>
          {results.map((r, i) => (
            <div key={`${r.streamUrl}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
              <StationLogo logo={r.logo} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {[r.countryCode, r.codec, r.bitrate ? `${r.bitrate}kbps` : null, r.tags[0]].filter(Boolean).join(' · ')}
                </div>
              </div>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => onPick({ name: r.name, streamUrl: r.streamUrl, logo: r.logo ?? undefined, codec: r.codec ?? undefined })}>Save</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UrlTab({ busy, onSave, onCancel }: { busy: boolean; onSave: (s: { name: string; streamUrl: string }) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const valid = /^https?:\/\//i.test(url.trim());
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Input label="Station name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My favourite radio" />
      <Input label="Stream URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://stream.example.com/listen" />
      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Paste a direct MP3/stream URL (http or https).</div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={!valid} onClick={() => onSave({ name: name.trim() || 'Station', streamUrl: url.trim() })}>Save</Button>
      </div>
    </div>
  );
}

function ImportTab({ busy, onPick }: { busy: boolean; onPick: (s: { name: string; streamUrl: string }) => void }) {
  const { data, loading } = usePolling<SonosFavoritesResponse>(api.radio.sonosFavorites, 0);
  const favorites = data?.favorites ?? [];
  const skipped = data?.skipped ?? [];
  if (loading && !data) return <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Reading the Sonos system's favourites…</div>;
  // Honest empty state: the owner's favourites are typically Spotify/SoundCloud playlists,
  // which Sonos rejects over local control — explain that instead of showing a blank list.
  if (favorites.length === 0) {
    const services = Array.from(new Set(skipped.map((s) => s.service).filter((x): x is string => !!x && x !== 'a streaming service')));
    const egList = services.length ? ` (e.g. ${services.slice(0, 3).join(', ')})` : '';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 13px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-2)', background: 'var(--surface-2)' }}>
          <Icon name="info" size={16} color="var(--text-3)" />
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-1)', marginBottom: 3 }}>No radio stations saved in Sonos</div>
            {skipped.length > 0
              ? <>You have {skipped.length} other favourite{skipped.length === 1 ? '' : 's'}{egList} — playlists like these can't be added as radio here.</>
              : <>There are no radio favourites in your Sonos system to import.</>}
            <div style={{ marginTop: 6, color: 'var(--text-3)' }}>
              Tip: save a station under TuneIn / Radio in the Sonos app and it'll show up here. Or use Search / Paste URL to add one directly.
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', overflow: 'hidden', maxHeight: 340, overflowY: 'auto' }}>
      {favorites.map((f, i) => {
        const playable = !!f.streamUrl;
        return (
          <div key={`${f.uri}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderTop: i === 0 ? 'none' : '1px solid var(--border-1)', opacity: playable ? 1 : 0.55 }}>
            <StationLogo size={32} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title}</div>
              {!playable && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Not a direct stream — can't import</div>}
            </div>
            <Button size="sm" variant="secondary" disabled={busy || !playable} onClick={() => playable && onPick({ name: f.title, streamUrl: f.streamUrl! })}>Save</Button>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================================
 * Play sheet (speaker multi-select + volume → Play)
 * ==========================================================================*/
function PlayStationModal({ station, speakers, wide, onClose, onPlayed }: {
  station: RadioStation; speakers: SonosSpeaker[]; wide: boolean; onClose: () => void; onPlayed: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(() => (speakers[0] ? [speakers[0].id] : []));
  const [vol, setVol] = useState(25);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const allSelected = selected.length === speakers.length && speakers.length > 0;

  const play = async () => {
    setBusy(true);
    try {
      await api.radio.play({ stationId: station.id, name: station.name, speakerIds: selected, volumePct: vol });
      onPlayed();
      onClose();
    } catch { setBusy(false); }
  };

  return (
    <Overlay title={`Play · ${station.name}`} onClose={onClose} wide={wide} footer={
      <>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={selected.length === 0} iconLeft={<Icon name="play" size={14} />} onClick={() => void play()}>Play</Button>
      </>
    }>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
          <span className="pwr-eyebrow">Speakers · {selected.length} selected</span>
          <button type="button" onClick={() => setSelected(allSelected ? [] : speakers.map((s) => s.id))} style={{ background: 'none', border: 'none', color: 'var(--solar)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
            {allSelected ? 'Clear' : 'Select all'}
          </button>
        </div>
        <SpeakerPicker speakers={speakers} selected={selected} onToggle={toggle} />
      </div>
      <div>
        <div className="pwr-eyebrow" style={{ marginBottom: 7 }}>Volume</div>
        <Slider min={0} max={100} unit="%" value={vol} onChange={setVol} />
      </div>
    </Overlay>
  );
}

/* ============================================================================
 * Now-playing banner — real target speakers + group/per-speaker volume
 * ==========================================================================*/

/** Human label for the speakers a station is playing on. "All speakers" only when the play
 *  targeted the whole house (or the resolved set equals the entire fleet). Otherwise a name,
 *  a short list, or "N speakers". */
function speakerScopeLabel(np: RadioNowPlaying, speakers: SonosSpeaker[]): string {
  const total = speakers.length;
  const ids = np.speakerIds;
  const allFleet = total > 0 && ids.length >= total;
  if (np.wholeHouse || allFleet) return 'All speakers';
  const names = ids
    .map((id) => speakers.find((s) => s.id === id)?.name)
    .filter((n): n is string => !!n);
  if (names.length === 0) return ids.length ? `${ids.length} speaker${ids.length === 1 ? '' : 's'}` : 'All speakers';
  if (names.length <= 2) return names.join(', ');
  return `${names.length} speakers`;
}

/** A volume slider whose writes are coalesced (~250ms) so dragging doesn't flood the API. It
 *  follows the live value only while the user isn't actively dragging. */
function DebouncedSlider({ value, onCommit }: { value: number; onCommit: (pct: number) => void }) {
  const [local, setLocal] = useState(value);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { if (!dirty.current) setLocal(value); }, [value]);
  const change = (v: number) => {
    dirty.current = true;
    setLocal(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { dirty.current = false; onCommit(v); }, 250);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <Slider min={0} max={100} unit="%" value={local} onChange={change} />;
}

/** A per-speaker volume row: name + debounced slider writing to /api/speakers/:id/volume. */
function VolumeRow({ label, value, onCommit }: { label: string; value: number; onCommit: (pct: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ flex: '0 0 92px', fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ flex: 1 }}><DebouncedSlider value={value} onCommit={onCommit} /></div>
    </div>
  );
}

function NowPlayingBanner({ np, speakers, canControl, onChanged }: {
  np: RadioNowPlaying; speakers: SonosSpeaker[]; canControl: boolean; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // The in-scope speakers actually playing (resolved primaries). Whole-house = the full fleet.
  const inScope = useMemo(() => {
    if (np.wholeHouse || np.speakerIds.length === 0) return speakers;
    const want = new Set(np.speakerIds);
    return speakers.filter((s) => want.has(s.id));
  }, [np, speakers]);

  const scopeLabel = speakerScopeLabel(np, speakers);
  // Group master = the average of the in-scope speakers' current volumes (best-effort).
  const vols = inScope.map((s) => (typeof s.volumePct === 'number' ? s.volumePct : 0));
  const groupVol = vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : 25;

  const setOne = (id: string, pct: number) => {
    void api.speakers.setVolume(id, pct).then(onChanged).catch(() => {});
  };
  const setGroup = (pct: number) => {
    // Apply to every in-scope speaker together.
    inScope.forEach((s) => { void api.speakers.setVolume(s.id, pct).catch(() => {}); });
    onChanged();
  };
  const stop = async () => {
    setBusy(true);
    try { await api.radio.stop(np.wholeHouse ? [] : np.speakerIds); onChanged(); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--solar-wash)', border: '1px solid var(--border-solar)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, flex: 'none', display: 'grid', placeItems: 'center', background: 'var(--solar)', color: 'var(--accent-contrast)' }}>
          <Icon name="radio" size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{np.name}</div>
          <div style={{ fontSize: 11, color: 'var(--solar-dim, var(--text-3))' }}>Playing on {scopeLabel}</div>
        </div>
        {canControl && <Button size="sm" variant="secondary" loading={busy} iconLeft={<Icon name="square" size={13} />} onClick={() => void stop()}>Stop</Button>}
      </div>

      {canControl && inScope.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2 }}>
          {/* Group master — adjusts every in-scope speaker together (debounced). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="volume-2" size={15} color="var(--text-3)" />
            <div style={{ flex: 1 }}>
              <DebouncedSlider value={groupVol} onCommit={setGroup} />
            </div>
          </div>
          {inScope.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--solar)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, padding: 0 }}
              >
                <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} />
                {expanded ? 'Hide' : 'Per-speaker'} volume
              </button>
              {expanded && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {inScope.map((s) => (
                    <VolumeRow
                      key={s.id}
                      label={s.name}
                      value={typeof s.volumePct === 'number' ? s.volumePct : 0}
                      onCommit={(pct) => setOne(s.id, pct)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * Favourites grid + now-playing
 * ==========================================================================*/
export function RadioPanel({ speakers, canControl, wide }: {
  speakers: SonosSpeaker[]; canControl: boolean; wide: boolean;
}) {
  const { data, refetch } = usePolling<RadioFavoritesResponse>(api.radio.favorites, 0);
  // Drive the now-playing banner from server state so it shows the REAL target speakers and
  // survives a refresh/restart (scheduled plays land here too).
  const { data: npData, refetch: refetchNp } = usePolling<RadioNowPlayingResponse>(api.radio.nowPlaying, 8_000);
  const favorites = useMemo(() => [...(data?.favorites ?? [])].sort((a, b) => a.slot - b.slot), [data]);
  const bySlot = useMemo(() => new Map(favorites.map((f) => [f.slot, f])), [favorites]);
  const nowPlaying = npData?.nowPlaying ?? null;

  const [adding, setAdding] = useState<number | null>(null); // slot index being filled
  const [editing, setEditing] = useState<RadioStation | null>(null);
  const [playing, setPlaying] = useState<RadioStation | null>(null);

  const slots = Array.from({ length: RADIO_FAVORITE_SLOTS }, (_, i) => i);

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="radio" size={16} color="var(--solar)" />
        <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Radio</div>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{favorites.length}/{RADIO_FAVORITE_SLOTS} saved</span>
      </div>

      {nowPlaying && (
        <NowPlayingBanner
          np={nowPlaying}
          speakers={speakers}
          canControl={canControl}
          onChanged={refetchNp}
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(auto-fill, minmax(150px, 1fr))' : 'repeat(2, 1fr)', gap: 9 }}>
        {slots.map((slot) => {
          const fav = bySlot.get(slot);
          if (!fav) {
            return (
              <button
                key={slot}
                type="button"
                disabled={!canControl}
                onClick={() => canControl && setAdding(slot)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
                  minHeight: 96, borderRadius: 'var(--radius-md)', border: '1px dashed var(--border-2)', background: 'transparent',
                  color: 'var(--text-3)', cursor: canControl ? 'pointer' : 'default', opacity: canControl ? 1 : 0.5,
                }}
              >
                <Icon name="plus" size={18} />
                <span style={{ fontSize: 11.5 }}>Add station</span>
              </button>
            );
          }
          return (
            <div key={slot} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 96, padding: 11, borderRadius: 'var(--radius-md)', border: '1px solid var(--border-1)', background: 'var(--surface-1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <StationLogo logo={fav.logo} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fav.name}</div>
                  {fav.codec && <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{fav.codec}</div>}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 'auto' }}>
                <Button size="sm" variant="primary" disabled={!canControl} iconLeft={<Icon name="play" size={13} />} onClick={() => setPlaying(fav)} style={{ flex: 1 }}>Play</Button>
                {canControl && <button type="button" aria-label="Edit station" onClick={() => setEditing(fav)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4 }}><Icon name="pencil" size={13} /></button>}
              </div>
            </div>
          );
        })}
      </div>

      {!canControl && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Read-only — only an admin can manage or play radio.</div>}

      {adding !== null && <AddStationModal slot={adding} wide={wide} onClose={() => setAdding(null)} onSaved={refetch} />}
      {editing && <EditStationModal station={editing} wide={wide} onClose={() => setEditing(null)} onSaved={refetch} />}
      {playing && (
        <PlayStationModal
          station={playing}
          speakers={speakers}
          wide={wide}
          onClose={() => setPlaying(null)}
          onPlayed={refetchNp}
        />
      )}
    </Card>
  );
}

/* ---- edit/delete a saved station ----------------------------------------- */
function EditStationModal({ station, wide, onClose, onSaved }: {
  station: RadioStation; wide: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(station.name);
  const [url, setUrl] = useState(station.streamUrl);
  const [busy, setBusy] = useState(false);
  const valid = /^https?:\/\//i.test(url.trim());

  const save = async () => {
    setBusy(true);
    try { await api.radio.updateFavorite(station.id, { name: name.trim() || 'Station', streamUrl: url.trim() }); onSaved(); onClose(); } catch { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await api.radio.deleteFavorite(station.id); onSaved(); onClose(); } catch { setBusy(false); }
  };

  return (
    <Overlay title="Edit station" onClose={onClose} wide={wide} footer={
      <>
        <Button size="sm" variant="ghost" onClick={() => void remove()} style={{ marginRight: 'auto', color: 'var(--danger)' }}>Delete</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>Save</Button>
      </>
    }>
      <Input label="Station name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input label="Stream URL" value={url} onChange={(e) => setUrl(e.target.value)} />
    </Overlay>
  );
}

/* ============================================================================
 * Radio schedules (mirrors the light-schedule model)
 * ==========================================================================*/
function summarize(s: RadioSchedule, stations: RadioStation[]): string {
  const days = s.days.length === 7 ? 'Every day' : s.days.length === 0 ? 'No days' : s.days.slice().sort().map((d) => DOW[d]).join(' ');
  const tgt = stations.find((x) => x.id === s.stationId)?.name ?? 'station';
  const win = s.offTime ? `${s.onTime}–${s.offTime}` : `at ${s.onTime}`;
  const where = s.speakerIds.length ? `${s.speakerIds.length} speaker${s.speakerIds.length === 1 ? '' : 's'}` : 'all speakers';
  return `${days} · ${win} · ${tgt} · ${where}`;
}

function RadioScheduleEditor({ stations, speakers, sched, wide, onClose, onSaved }: {
  stations: RadioStation[]; speakers: SonosSpeaker[]; sched: RadioSchedule | null; wide: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(sched?.name ?? '');
  const [days, setDays] = useState<number[]>(sched?.days ?? [1, 2, 3, 4, 5]);
  const [onTime, setOnTime] = useState(sched?.onTime ?? '08:00');
  const [autoOff, setAutoOff] = useState<boolean>(!!sched?.offTime);
  const [offTime, setOffTime] = useState(sched?.offTime ?? '09:00');
  const [stationId, setStationId] = useState(sched?.stationId ?? stations[0]?.id ?? '');
  const [speakerIds, setSpeakerIds] = useState<string[]>(sched?.speakerIds ?? []);
  const [vol, setVol] = useState(sched?.volumePct ?? 25);
  const [busy, setBusy] = useState(false);

  const toggleDay = (d: number) => setDays((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d].sort()));
  const toggleSpeaker = (id: string) => setSpeakerIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const valid = days.length > 0 && !!stationId;

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        name: name.trim() || 'Radio schedule',
        days, onTime,
        offTime: autoOff ? offTime : null,
        stationId, speakerIds, volumePct: vol,
        enabled: sched?.enabled ?? true,
      };
      if (sched) await api.radio.updateSchedule(sched.id, payload);
      else await api.radio.createSchedule(payload);
      onSaved(); onClose();
    } catch { setBusy(false); }
  };
  const remove = async () => { if (!sched) return; setBusy(true); try { await api.radio.deleteSchedule(sched.id); onSaved(); onClose(); } catch { setBusy(false); } };

  return (
    <Overlay title={sched ? 'Edit radio schedule' : 'New radio schedule'} icon="calendar-clock" onClose={onClose} wide={wide} footer={
      <>
        {sched && <Button size="sm" variant="ghost" onClick={() => void remove()} style={{ marginRight: 'auto', color: 'var(--danger)' }}>Delete</Button>}
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>Save</Button>
      </>
    }>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Morning radio" />
      <div>
        <div className="pwr-eyebrow" style={{ marginBottom: 7 }}>Days</div>
        <DaysPicker days={days} onToggle={toggleDay} />
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div className="pwr-eyebrow" style={{ marginBottom: 7 }}>Start at</div>
          <Input type="time" value={onTime} onChange={(e) => setOnTime(e.target.value)} />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
            <span className="pwr-eyebrow">Stop at</span>
            <Switch checked={autoOff} onChange={(e) => setAutoOff(e.target.checked)} />
          </div>
          {autoOff && <Input type="time" value={offTime} onChange={(e) => setOffTime(e.target.value)} />}
        </div>
      </div>
      {stations.length ? (
        <Select label="Station" value={stationId} onChange={(e) => setStationId(e.target.value)} options={stations.map((s) => ({ value: s.id, label: s.name }))} />
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Save a favourite station first, then schedule it.</div>
      )}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
          <span className="pwr-eyebrow">Speakers · {speakerIds.length ? `${speakerIds.length} selected` : 'all'}</span>
          <button type="button" onClick={() => setSpeakerIds(speakerIds.length === speakers.length ? [] : speakers.map((s) => s.id))} style={{ background: 'none', border: 'none', color: 'var(--solar)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
            {speakerIds.length === speakers.length && speakers.length > 0 ? 'Clear' : 'Select all'}
          </button>
        </div>
        <SpeakerPicker speakers={speakers} selected={speakerIds} onToggle={toggleSpeaker} />
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>None selected = play on all speakers.</div>
      </div>
      <div>
        <div className="pwr-eyebrow" style={{ marginBottom: 7 }}>Volume</div>
        <Slider min={0} max={100} unit="%" value={vol} onChange={setVol} />
      </div>
    </Overlay>
  );
}

export function RadioSchedulesSection({ speakers, canControl, wide }: {
  speakers: SonosSpeaker[]; canControl: boolean; wide: boolean;
}) {
  const { data, refetch } = usePolling<RadioSchedulesResponse>(api.radio.schedules, 0);
  const { data: favData } = usePolling<RadioFavoritesResponse>(api.radio.favorites, 0);
  const schedules = useMemo(() => data?.schedules ?? [], [data]);
  const stations = useMemo(() => [...(favData?.favorites ?? [])].sort((a, b) => a.slot - b.slot), [favData]);
  const [editing, setEditing] = useState<RadioSchedule | null | undefined>(undefined); // undefined=closed, null=new

  const toggle = (s: RadioSchedule, enabled: boolean) => { void api.radio.updateSchedule(s.id, { enabled }).then(refetch); };
  const del = (s: RadioSchedule) => { void api.radio.deleteSchedule(s.id).then(refetch); };

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="calendar-clock" size={16} color="var(--solar)" />
        <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Radio schedules</div>
        {canControl && <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={14} />} disabled={stations.length === 0} onClick={() => setEditing(null)}>New</Button>}
      </div>
      {schedules.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {stations.length === 0 ? 'Save a favourite station first to schedule radio.' : `No radio schedules yet. ${canControl ? 'Play a station on a timer.' : ''}`}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {schedules.map((s, i) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 2px', borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>{summarize(s, stations)}</div>
              </div>
              {canControl && <button type="button" aria-label="Edit schedule" onClick={() => setEditing(s)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4 }}><Icon name="pencil" size={14} /></button>}
              {canControl && <button type="button" aria-label="Delete schedule" onClick={() => del(s)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4 }}><Icon name="trash-2" size={14} /></button>}
              <Switch checked={s.enabled} disabled={!canControl} onChange={(e) => toggle(s, e.target.checked)} />
            </div>
          ))}
        </div>
      )}
      {editing !== undefined && (
        <RadioScheduleEditor stations={stations} speakers={speakers} sched={editing} wide={wide} onClose={() => setEditing(undefined)} onSaved={refetch} />
      )}
    </Card>
  );
}
