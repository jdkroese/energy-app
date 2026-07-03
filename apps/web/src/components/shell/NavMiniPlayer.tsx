import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type {
  RadioNowPlayingResponse,
  SpotifyNowPlayingResponse,
  SpeakersResponse,
  SonosSpeaker,
} from '../../lib/types';
import { Icon } from '../ui/Icon';
import { PlayingOnControl } from '../music/PlayingOnControl';
import { useAuth } from '../../auth/AuthProvider';

/* ============================================================================
 * Global NOW-PLAYING mini player — a compact, persistent transport pinned in the
 * navigation so whatever is playing (Spotify or Sonos radio) is visible + pausable
 * from ANY screen, and one tap opens the full Music view.
 *
 *  - useNowPlaying():  shared 5 s poll of BOTH sources (+ the Sonos fleet). Spotify
 *                      wins when both are active; radio is the fallback. Returns a
 *                      normalized shape (source · title · isPlaying + toggle) PLUS the
 *                      fleet, the in-scope zone ids, and a live setSpeakers() so the
 *                      speaker popover can re-group without leaving the screen.
 *  - RailMiniPlayer:   mounted above the Rail footer. A speaker button opens the shared
 *                      PlayingOnControl in a floating popover.
 *  - MobileMiniPlayer: a slim bar above the TabBar (clear of the alarm FAB); the speaker
 *                      button opens the same control in a bottom sheet.
 *
 * Renders NOTHING when nothing is playing. Pause/resume calls the matching source's
 * endpoint; the body click routes to /music.
 * ==========================================================================*/

const POLL_MS = 5_000;

type Source = 'spotify' | 'radio' | 'sonos';

/** Friendly label for a now-playing source (used in tooltips + the Speakers section). */
export function sourceLabel(source: Source): string {
  if (source === 'spotify') return 'Spotify';
  if (source === 'radio') return 'Radio';
  return 'Sonos';
}

interface NowPlaying {
  source: Source;
  /** Track (Spotify) or station name (radio). */
  title: string;
  /** Spotify exposes real play/pause; radio is treated as playing when present. */
  isPlaying: boolean;
  /** Toggle play/pause on the active source. */
  toggle: () => Promise<void>;
  /** The full Sonos fleet (all zones) for the speaker popover. */
  fleet: SonosSpeaker[];
  /** Zone ids currently in scope (playing). */
  inScopeIds: string[];
  /** Live-edit which zones are playing (reconciles the group). */
  setSpeakers: (ids: string[]) => Promise<void>;
}

/** Shared now-playing state across both sources (+ the fleet). Null np = nothing playing. */
export function useNowPlaying(): { np: NowPlaying | null; refetch: () => void } {
  const { data: spotifyData, refetch: refetchSpotify } = usePolling<SpotifyNowPlayingResponse>(
    api.spotify.nowPlaying,
    POLL_MS,
  );
  const { data: radioData, refetch: refetchRadio } = usePolling<RadioNowPlayingResponse>(
    api.radio.nowPlaying,
    POLL_MS,
  );
  const { data: fleetData, refetch: refetchFleet } = usePolling<SpeakersResponse>(
    api.speakers.list,
    POLL_MS,
  );
  const fleet = fleetData?.speakers ?? [];

  const refetch = () => {
    void refetchSpotify();
    void refetchRadio();
    void refetchFleet();
  };

  const spotify = spotifyData?.nowPlaying ?? null;
  const radio = radioData?.nowPlaying ?? null;

  // Spotify takes precedence when it has an active track (playing or paused-with-track).
  if (spotify && spotify.track) {
    const inScopeIds = spotify.sonosIds.filter((id) => fleet.some((s) => s.id === id));
    return {
      np: {
        source: 'spotify',
        title: spotify.track,
        isPlaying: spotify.isPlaying,
        toggle: async () => {
          await (spotify.isPlaying ? api.spotify.pause() : api.spotify.resume());
          refetch();
        },
        fleet,
        inScopeIds,
        setSpeakers: async (ids) => { await api.spotify.setSpeakers(ids); refetch(); },
      },
      refetch,
    };
  }

  if (radio) {
    const inScopeIds = radio.wholeHouse || radio.speakerIds.length === 0
      ? fleet.map((s) => s.id)
      : radio.speakerIds.filter((id) => fleet.some((s) => s.id === id));
    return {
      np: {
        source: 'radio',
        title: radio.name,
        // Radio has no paused state in now-playing — present means playing.
        isPlaying: true,
        toggle: async () => {
          // Stop the radio on the speakers it's playing on (pause == stop for radio).
          await api.radio.stop(radio.speakerIds);
          refetch();
        },
        fleet,
        inScopeIds,
        setSpeakers: async (ids) => { await api.radio.setSpeakers(ids); refetch(); },
      },
      refetch,
    };
  }

  // Fallback: native Sonos playback the app didn't start (Sonos app, TV, AirPlay, a favourite).
  // Read straight off the live transport state so it's still visible + stoppable here. Comes last
  // so app-started Spotify/radio (which carry richer metadata) always take precedence.
  const sonosPb = fleetData?.playback ?? null;
  if (sonosPb && sonosPb.isPlaying) {
    const inScopeIds = sonosPb.speakerIds.filter((id) => fleet.some((s) => s.id === id));
    return {
      np: {
        source: 'sonos',
        title: sonosPb.title || sonosPb.source || 'Playing on Sonos',
        isPlaying: true,
        toggle: async () => {
          // No app-side session to pause — stop the speakers it's playing on (pause == stop).
          await api.speakers.stop();
          refetch();
        },
        fleet,
        inScopeIds,
        setSpeakers: async (ids) => { await api.speakers.setPlaying(ids); refetch(); },
      },
      refetch,
    };
  }

  return { np: null, refetch };
}

/** The small source glyph — Spotify green dot-icon, radio broadcast icon. */
function SourceGlyph({ source, size = 16 }: { source: Source; size?: number }) {
  if (source === 'spotify') {
    return <Icon name="music" size={size} color="#1DB954" />;
  }
  if (source === 'sonos') {
    return <Icon name="cast" size={size} color="var(--solar)" />;
  }
  return <Icon name="radio" size={size} color="var(--solar)" />;
}

/* ---- Speaker button + floating "Playing on" panel ------------------------- */
// A small cast/speaker button that opens the shared PlayingOnControl. On desktop it's a
// floating popover anchored to the mini player; on mobile it's a bottom sheet. Both use the
// same control so behaviour matches the now-playing panels exactly.

function SpeakerButton({ np, canControl, refetch, variant, size = 30 }: {
  np: NowPlaying; canControl: boolean; refetch: () => void; variant: 'popover' | 'sheet'; size?: number;
}) {
  const [open, setOpen] = useState(false);
  const label = `${np.inScopeIds.length}/${np.fleet.length || '?'} zones`;

  const control = (
    <PlayingOnControl
      fleet={np.fleet}
      inScopeIds={np.inScopeIds}
      canControl={canControl}
      compact
      onSetSpeakers={np.setSpeakers}
      onSetVolume={(id, pct) => api.speakers.setVolume(id, pct)}
      onChanged={refetch}
    />
  );

  return (
    <>
      <button
        type="button"
        aria-label={`Speakers · ${label}`}
        title={`Speakers · ${label}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        style={{
          width: size, height: size, flex: 'none', borderRadius: '50%', border: 'none',
          background: open ? 'var(--solar)' : 'var(--surface-2)', color: open ? 'var(--accent-contrast)' : 'var(--text-2)',
          cursor: 'pointer', display: 'grid', placeItems: 'center',
        }}
      >
        <Icon name="cast" size={Math.round(size * 0.5)} />
      </button>

      {open && variant === 'popover' && (
        <>
          {/* click-away scrim */}
          <div onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            style={{ position: 'fixed', inset: 0, zIndex: 70 }} />
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, right: 0, zIndex: 71,
              minWidth: 250, padding: 12, borderRadius: 'var(--radius-lg)',
              background: 'var(--surface-1)', border: '1px solid var(--border-2)', boxShadow: 'var(--shadow-2)',
              maxHeight: 360, overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <SourceGlyph source={np.source} size={15} />
              <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{np.title}</div>
            </div>
            {control}
          </div>
        </>
      )}

      {open && variant === 'sheet' && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setOpen(false); }}
          style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(4,8,10,0.6)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-end' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%', maxHeight: '78vh', overflowY: 'auto',
              background: 'var(--surface-1)', borderTopLeftRadius: 'var(--radius-lg)', borderTopRightRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-2)', padding: '16px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <SourceGlyph source={np.source} size={17} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="pwr-eyebrow" style={{ color: 'var(--text-3)', fontSize: 9.5 }}>Playing on</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{np.title}</div>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close"
                style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4 }}>
                <Icon name="x" size={20} />
              </button>
            </div>
            {control}
          </div>
        </div>
      )}
    </>
  );
}

/* ---- Desktop Rail mini player (mounted above the footer controls) --------- */

export function RailMiniPlayer({ expanded }: { expanded: boolean }) {
  const { user } = useAuth();
  const canControl = user?.role === 'admin';
  const navigate = useNavigate();
  const { np, refetch } = useNowPlaying();
  const [busy, setBusy] = useState(false);
  if (!np) return null;

  const onToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canControl) return;
    setBusy(true);
    try {
      await np.toggle();
    } finally {
      setBusy(false);
    }
  };
  const openMusic = () => navigate('/music');

  if (!expanded) {
    // Collapsed: source glyph + a small "playing" dot, title hidden.
    return (
      <button
        type="button"
        onClick={openMusic}
        title={`${sourceLabel(np.source)} · ${np.title}`}
        aria-label={`Now playing: ${np.title}. Open Music.`}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 42,
          border: '1px solid var(--border-1)',
          background: 'var(--surface-1)',
          borderRadius: 'var(--radius-md)',
          cursor: 'pointer',
        }}
      >
        <SourceGlyph source={np.source} size={18} />
        <span
          style={{
            position: 'absolute',
            top: 7,
            right: 7,
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: np.isPlaying ? 'var(--solar)' : 'var(--text-3)',
            boxShadow: np.isPlaying ? '0 0 6px var(--solar)' : 'none',
          }}
        />
      </button>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openMusic}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openMusic(); }}
      title={`${np.source === 'spotify' ? 'Spotify' : 'Radio'} · ${np.title}`}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        border: '1px solid var(--border-1)',
        background: 'var(--surface-1)',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
      }}
    >
      <SourceGlyph source={np.source} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="pwr-eyebrow" style={{ color: 'var(--text-3)', fontSize: 9.5 }}>Now playing</div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {np.title}
        </div>
      </div>
      <SpeakerButton np={np} canControl={canControl} refetch={refetch} variant="popover" size={28} />
      {canControl && (
        <button
          type="button"
          disabled={busy}
          onClick={(e) => void onToggle(e)}
          aria-label={np.isPlaying ? 'Pause' : 'Play'}
          title={np.isPlaying ? 'Pause' : 'Play'}
          style={{
            width: 30,
            height: 30,
            flex: 'none',
            borderRadius: '50%',
            border: 'none',
            background: 'var(--solar-wash)',
            color: 'var(--solar)',
            cursor: busy ? 'default' : 'pointer',
            display: 'grid',
            placeItems: 'center',
            opacity: busy ? 0.6 : 1,
          }}
        >
          <Icon name={np.isPlaying ? 'pause' : 'play'} size={15} />
        </button>
      )}
    </div>
  );
}

/* ---- Mobile mini player (slim bar anchored above the TabBar) -------------- */

export function MobileMiniPlayer() {
  const { user } = useAuth();
  const canControl = user?.role === 'admin';
  const navigate = useNavigate();
  const { np, refetch } = useNowPlaying();
  const [busy, setBusy] = useState(false);
  if (!np) return null;

  const onToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canControl) return;
    setBusy(true);
    try {
      await np.toggle();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate('/music')}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/music'); }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        // Keep the buttons + body clear of the alarm FAB (right: 16, width 56).
        padding: '8px 78px 8px 14px',
        borderTop: '1px solid var(--border-1)',
        background: 'var(--glass-fill, rgba(15,22,25,.9))',
        backdropFilter: 'blur(var(--blur-glass, 18px))',
        WebkitBackdropFilter: 'blur(var(--blur-glass, 18px))',
        cursor: 'pointer',
      }}
    >
      <SourceGlyph source={np.source} size={17} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {np.title}
        </div>
      </div>
      <SpeakerButton np={np} canControl={canControl} refetch={refetch} variant="sheet" size={34} />
      {canControl && (
        <button
          type="button"
          disabled={busy}
          onClick={(e) => void onToggle(e)}
          aria-label={np.isPlaying ? 'Pause' : 'Play'}
          style={{
            width: 34,
            height: 34,
            flex: 'none',
            borderRadius: '50%',
            border: 'none',
            background: 'var(--solar-wash)',
            color: 'var(--solar)',
            cursor: busy ? 'default' : 'pointer',
            display: 'grid',
            placeItems: 'center',
            opacity: busy ? 0.6 : 1,
          }}
        >
          <Icon name={np.isPlaying ? 'pause' : 'play'} size={16} />
        </button>
      )}
    </div>
  );
}
