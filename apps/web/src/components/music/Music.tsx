import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type {
  SonosSpeaker,
  SpotifyStatus,
  SpotifyBrowseItem,
  SpotifyBrowseResponse,
  SpotifySearchResponse,
  SpotifyNowPlaying,
  SpotifyNowPlayingResponse,
} from '../../lib/types';
import { Card, Icon, Button, Slider, SegmentedControl, Input } from '../ui';

/* ============================================================================
 * Music (Spotify) — Phase 1. Surfaced on the Speakers page as a "Music" section
 * alongside Radio. Playback runs through the Spotify Web API + Spotify Connect
 * (the owner's Sonos rooms appear as Connect devices). Browse your playlists +
 * Liked Songs, search, and a now-playing panel with transport + speaker chips +
 * per-speaker volume (mirrors the Radio now-playing pattern). Built to the Power
 * design system; responsive across desktop + mobile.
 *
 * Credentials + the OAuth connect flow live in Settings → Connections (per owner
 * request) — this screen only shows a gentle "connect in Settings" prompt when
 * not connected, and a Premium-required note when the account isn't Premium.
 * ==========================================================================*/

const POLL_NOW_MS = 4000;

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/* ---- album / item art ---------------------------------------------------- */
function Art({ url, size = 44, round = 8 }: { url: string | null; size?: number; round?: number }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    return (
      <img src={url} alt="" width={size} height={size} onError={() => setBroken(true)}
        style={{ width: size, height: size, borderRadius: round, objectFit: 'cover', flex: 'none', background: 'var(--surface-3)' }} />
    );
  }
  return (
    <span style={{ width: size, height: size, borderRadius: round, flex: 'none', display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--solar)' }}>
      <Icon name="music" size={Math.round(size * 0.46)} />
    </span>
  );
}

/* ---- speaker chips (multi-select, reused by play + now-playing) ---------- */
function SpeakerChips({ speakers, selected, onToggle }: {
  speakers: SonosSpeaker[]; selected: string[]; onToggle: (id: string) => void;
}) {
  if (speakers.length === 0) return <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No speakers found.</div>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
      {speakers.map((s) => {
        const on = selected.includes(s.id);
        return (
          <button key={s.id} type="button" onClick={() => onToggle(s.id)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
            fontSize: 12.5, fontWeight: 600,
            border: `1px solid ${on ? 'var(--solar)' : 'var(--border-2)'}`,
            background: on ? 'var(--solar-wash)' : 'transparent', color: on ? 'var(--solar)' : 'var(--text-2)',
          }}>
            {on && <Icon name="check" size={12} />}
            <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ---- debounced volume slider (coalesced writes) -------------------------- */
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

/* ============================================================================
 * Now-playing panel — album art, track/artist, progress, transport, speaker
 * chips + group/per-speaker volume. Drives the active Connect device back to a
 * Sonos zone so the right chips highlight.
 * ==========================================================================*/
function NowPlayingPanel({ np, speakers, canControl, wide, onChanged }: {
  np: SpotifyNowPlaying; speakers: SonosSpeaker[]; canControl: boolean; wide: boolean; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // The in-scope speakers = those the active Connect device maps to (its Sonos group).
  const inScope = useMemo(() => {
    if (np.sonosIds.length === 0) return [];
    const want = new Set(np.sonosIds);
    return speakers.filter((s) => want.has(s.id));
  }, [np.sonosIds, speakers]);

  const scopeLabel = inScope.length
    ? (inScope.length <= 2 ? inScope.map((s) => s.name).join(', ') : `${inScope.length} speakers`)
    : (np.deviceName ?? '—');

  const vols = inScope.map((s) => (typeof s.volumePct === 'number' ? s.volumePct : 0));
  const groupVol = vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : 30;

  const call = async (fn: () => Promise<unknown>) => {
    if (!canControl) return;
    setBusy(true);
    try { await fn(); onChanged(); } finally { setBusy(false); }
  };
  const setOne = (id: string, pct: number) => { void api.speakers.setVolume(id, pct).then(onChanged).catch(() => {}); };
  const setGroup = (pct: number) => { inScope.forEach((s) => { void api.speakers.setVolume(s.id, pct).catch(() => {}); }); onChanged(); };

  const progressPct = np.durationMs > 0 ? Math.min(100, (np.progressMs / np.durationMs) * 100) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: wide ? '14px 16px' : '12px 13px', borderRadius: 'var(--radius-md)', background: 'var(--solar-wash)', border: '1px solid var(--border-solar)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: wide ? 14 : 11 }}>
        <Art url={np.image} size={wide ? 64 : 52} round={10} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: wide ? 16 : 14.5, fontWeight: 700, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{np.track ?? 'Nothing playing'}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{np.artist ?? ''}</div>
          <div style={{ fontSize: 11, color: 'var(--solar-dim, var(--text-3))', marginTop: 2 }}>On {scopeLabel}</div>
        </div>
      </div>

      {/* progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)', flex: 'none', width: 34, textAlign: 'right' }}>{fmtTime(np.progressMs)}</span>
        <div style={{ flex: 1, height: 4, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}>
          <div style={{ width: `${progressPct}%`, height: '100%', background: 'var(--solar)', transition: 'width .4s linear' }} />
        </div>
        <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)', flex: 'none', width: 34 }}>{fmtTime(np.durationMs)}</span>
      </div>

      {/* transport */}
      {canControl && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: wide ? 18 : 14 }}>
          <TransportBtn icon="shuffle" active={np.shuffle} disabled={busy} onClick={() => void call(() => api.spotify.setShuffle(!np.shuffle))} />
          <TransportBtn icon="skip-back" disabled={busy} onClick={() => void call(() => api.spotify.previous())} />
          <button type="button" disabled={busy} aria-label={np.isPlaying ? 'Pause' : 'Play'}
            onClick={() => void call(() => (np.isPlaying ? api.spotify.pause() : api.spotify.resume()))}
            style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', flex: 'none', cursor: busy ? 'default' : 'pointer', display: 'grid', placeItems: 'center', background: 'var(--solar)', color: 'var(--accent-contrast)' }}>
            <Icon name={np.isPlaying ? 'pause' : 'play'} size={22} />
          </button>
          <TransportBtn icon="skip-forward" disabled={busy} onClick={() => void call(() => api.spotify.next())} />
          <TransportBtn icon="repeat" active={np.repeat !== 'off'} disabled={busy}
            onClick={() => void call(() => api.spotify.setRepeat(np.repeat === 'off' ? 'context' : np.repeat === 'context' ? 'track' : 'off'))} />
        </div>
      )}

      {/* group + per-speaker volume */}
      {canControl && inScope.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="volume-2" size={15} color="var(--text-3)" />
            <div style={{ flex: 1 }}><DebouncedSlider value={groupVol} onCommit={setGroup} /></div>
          </div>
          {inScope.length > 1 && (
            <>
              <button type="button" onClick={() => setExpanded((v) => !v)}
                style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--solar)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, padding: 0 }}>
                <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} />
                {expanded ? 'Hide' : 'Per-speaker'} volume
              </button>
              {expanded && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {inScope.map((s) => (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ flex: '0 0 92px', fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                      <div style={{ flex: 1 }}><DebouncedSlider value={typeof s.volumePct === 'number' ? s.volumePct : 0} onCommit={(pct) => setOne(s.id, pct)} /></div>
                    </div>
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

function TransportBtn({ icon, active, disabled, onClick }: { icon: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} style={{
      width: 34, height: 34, borderRadius: '50%', border: 'none', flex: 'none', cursor: disabled ? 'default' : 'pointer',
      display: 'grid', placeItems: 'center', background: 'transparent', color: active ? 'var(--solar)' : 'var(--text-2)',
    }}>
      <Icon name={icon} size={18} />
    </button>
  );
}

/* ============================================================================
 * Browse row (playlist / liked / track) → opens the play sheet
 * ==========================================================================*/
function BrowseRow({ item, onPlay, canControl }: { item: SpotifyBrowseItem; onPlay: () => void; canControl: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 4px' }}>
      <Art url={item.image} size={40} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.subtitle}</div>
      </div>
      <Button size="sm" variant="primary" disabled={!canControl} iconLeft={<Icon name="play" size={13} />} onClick={onPlay}>Play</Button>
    </div>
  );
}

/* ---- play sheet: choose speakers + volume, then play --------------------- */
function PlaySheet({ item, speakers, wide, onClose, onPlayed }: {
  item: SpotifyBrowseItem; speakers: SonosSpeaker[]; wide: boolean; onClose: () => void; onPlayed: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(() => (speakers[0] ? [speakers[0].id] : []));
  const [vol, setVol] = useState(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = (id: string) => setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const allSelected = selected.length === speakers.length && speakers.length > 0;

  const play = async () => {
    setBusy(true); setErr(null);
    try {
      // Playlists play as a context; single tracks / liked songs play by uri.
      const body = item.kind === 'playlist'
        ? { contextUri: item.uri, speakerIds: selected, volumePct: vol }
        : { uris: [item.uri], speakerIds: selected, volumePct: vol };
      await api.spotify.play(body);
      onPlayed(); onClose();
    } catch (e) { setErr((e as Error).message || 'Could not start playback'); setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,8,10,0.66)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div style={{ width: '100%', maxWidth: wide ? 480 : 440, background: 'var(--surface-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-2)', display: 'flex', flexDirection: 'column', maxHeight: '88vh' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: '1px solid var(--border-1)' }}>
          <Art url={item.image} size={38} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{item.subtitle}</div>
          </div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4 }}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="pwr-eyebrow">Speakers · {selected.length} selected</span>
              <button type="button" onClick={() => setSelected(allSelected ? [] : speakers.map((s) => s.id))} style={{ background: 'none', border: 'none', color: 'var(--solar)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
                {allSelected ? 'Clear' : 'Select all'}
              </button>
            </div>
            <SpeakerChips speakers={speakers} selected={selected} onToggle={toggle} />
          </div>
          <div>
            <div className="pwr-eyebrow" style={{ marginBottom: 7 }}>Volume</div>
            <Slider min={0} max={100} unit="%" value={vol} onChange={setVol} />
          </div>
          {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 18px', borderTop: '1px solid var(--border-1)' }}>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" loading={busy} disabled={selected.length === 0} iconLeft={<Icon name="play" size={14} />} onClick={() => void play()}>Play</Button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * Library browse (Playlists / Liked / Search)
 * ==========================================================================*/
type SourceTab = 'playlists' | 'liked' | 'search';

function LibrarySection({ speakers, canControl, wide, onPlayed }: {
  speakers: SonosSpeaker[]; canControl: boolean; wide: boolean; onPlayed: () => void;
}) {
  const [tab, setTab] = useState<SourceTab>('playlists');
  const [playing, setPlaying] = useState<SpotifyBrowseItem | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SegmentedControl block value={tab} options={[
        { value: 'playlists', label: 'Playlists' },
        { value: 'liked', label: 'Liked' },
        { value: 'search', label: 'Search' },
      ]} onChange={(v) => setTab(v as SourceTab)} />
      {tab === 'playlists' && <BrowseList load={api.spotify.playlists} empty="No playlists found." canControl={canControl} onPick={setPlaying} />}
      {tab === 'liked' && <BrowseList load={api.spotify.liked} empty="No liked songs found." canControl={canControl} onPick={setPlaying} />}
      {tab === 'search' && <SearchList canControl={canControl} onPick={setPlaying} />}

      {playing && <PlaySheet item={playing} speakers={speakers} wide={wide} onClose={() => setPlaying(null)} onPlayed={onPlayed} />}
    </div>
  );
}

function BrowseList({ load, empty, canControl, onPick }: {
  load: () => Promise<SpotifyBrowseResponse>; empty: string; canControl: boolean; onPick: (i: SpotifyBrowseItem) => void;
}) {
  const { data, loading } = usePolling<SpotifyBrowseResponse>(load, 0);
  const items = data?.items ?? [];
  if (loading && !data) return <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '8px 4px' }}>Loading…</div>;
  if (items.length === 0) return <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '8px 4px' }}>{empty}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 360, overflowY: 'auto' }}>
      {items.map((it, i) => (
        <div key={`${it.uri}-${i}`} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
          <BrowseRow item={it} canControl={canControl} onPlay={() => onPick(it)} />
        </div>
      ))}
    </div>
  );
}

function SearchList({ canControl, onPick }: { canControl: boolean; onPick: (i: SpotifyBrowseItem) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SpotifyBrowseItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ran, setRan] = useState(false);

  const run = async () => {
    const term = q.trim();
    if (!term) return;
    setSearching(true); setErr(null); setRan(true);
    try {
      const r: SpotifySearchResponse = await api.spotify.search(term);
      setItems(r.items);
    } catch (e) { setErr((e as Error).message); } finally { setSearching(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <form onSubmit={(e) => { e.preventDefault(); void run(); }} style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}><Input placeholder="Search tracks & playlists…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Button size="md" variant="primary" type="submit" loading={searching}>Search</Button>
      </form>
      {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
      {ran && !searching && items.length === 0 && !err && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No results.</div>}
      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 340, overflowY: 'auto' }}>
          {items.map((it, i) => (
            <div key={`${it.uri}-${i}`} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
              <BrowseRow item={it} canControl={canControl} onPlay={() => onPick(it)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * The Music panel — surfaced on the Speakers page below Radio.
 * ==========================================================================*/
export function MusicPanel({ speakers, canControl, wide }: {
  speakers: SonosSpeaker[]; canControl: boolean; wide: boolean;
}) {
  const { data: status } = usePolling<SpotifyStatus>(api.spotify.status, 0);
  const { data: npData, refetch: refetchNp } = usePolling<SpotifyNowPlayingResponse>(api.spotify.nowPlaying, POLL_NOW_MS);
  const nowPlaying = npData?.nowPlaying ?? null;

  const connected = status?.connected ?? false;
  const premium = status?.premium ?? false;

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="music" size={16} color="var(--solar)" />
        <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Music</div>
        {connected && status?.displayName && (
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Spotify · {status.displayName}</span>
        )}
      </div>

      {!connected ? (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '13px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-2)', background: 'var(--surface-2)' }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, flex: 'none', display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--solar)' }}><Icon name="music" size={16} /></span>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-1)', marginBottom: 2 }}>Spotify not connected</div>
            Connect your Spotify account in <strong style={{ color: 'var(--text-1)' }}>Settings → Connections → Spotify</strong> to browse and play music on your Sonos speakers. Spotify Premium is required for playback.
          </div>
        </div>
      ) : (
        <>
          {!premium && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-2)', background: 'var(--surface-2)' }}>
              <Icon name="alert-triangle" size={15} color="var(--grid)" />
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Spotify Premium is required to play on speakers. You can still browse and search.</div>
            </div>
          )}

          {nowPlaying && (
            <NowPlayingPanel np={nowPlaying} speakers={speakers} canControl={canControl && premium} wide={wide} onChanged={refetchNp} />
          )}

          <LibrarySection speakers={speakers} canControl={canControl && premium} wide={wide} onPlayed={refetchNp} />

          {!canControl && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Read-only — only an admin can play music.</div>}
        </>
      )}
    </Card>
  );
}
