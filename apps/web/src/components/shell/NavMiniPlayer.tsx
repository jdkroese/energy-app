import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { RadioNowPlayingResponse, SpotifyNowPlayingResponse } from '../../lib/types';
import { Icon } from '../ui/Icon';
import { useAuth } from '../../auth/AuthProvider';

/* ============================================================================
 * Global NOW-PLAYING mini player — a compact, persistent transport pinned in the
 * navigation so whatever is playing (Spotify or Sonos radio) is visible + pausable
 * from ANY screen, and one tap opens the full Music view.
 *
 *  - useNowPlaying():  shared 5 s poll of BOTH sources. Spotify wins when both are
 *                      active; radio is the fallback. Returns a normalized shape
 *                      (source · title · isPlaying + a toggle) or null when idle.
 *  - RailMiniPlayer:   mounted above the Rail footer. Expanded = glyph + title +
 *                      play/pause; collapsed = just the source glyph + a "playing"
 *                      dot (title hidden).
 *  - MobileMiniPlayer: a slim bar anchored above the TabBar, clear of the alarm FAB.
 *
 * Renders NOTHING when nothing is playing (no empty bar). Pause/resume calls the
 * matching source's endpoint; the body click routes to /music.
 * ==========================================================================*/

const POLL_MS = 5_000;

type Source = 'spotify' | 'radio';

interface NowPlaying {
  source: Source;
  /** Track (Spotify) or station name (radio). */
  title: string;
  /** Spotify exposes real play/pause; radio is treated as playing when present. */
  isPlaying: boolean;
  /** Toggle play/pause on the active source. */
  toggle: () => Promise<void>;
}

/** Shared now-playing state across both sources. Null = nothing playing. */
export function useNowPlaying(): { np: NowPlaying | null; refetch: () => void } {
  const { data: spotifyData, refetch: refetchSpotify } = usePolling<SpotifyNowPlayingResponse>(
    api.spotify.nowPlaying,
    POLL_MS,
  );
  const { data: radioData, refetch: refetchRadio } = usePolling<RadioNowPlayingResponse>(
    api.radio.nowPlaying,
    POLL_MS,
  );

  const refetch = () => {
    void refetchSpotify();
    void refetchRadio();
  };

  const spotify = spotifyData?.nowPlaying ?? null;
  const radio = radioData?.nowPlaying ?? null;

  // Spotify takes precedence when it has an active track (playing or paused-with-track).
  if (spotify && spotify.track) {
    return {
      np: {
        source: 'spotify',
        title: spotify.track,
        isPlaying: spotify.isPlaying,
        toggle: async () => {
          await (spotify.isPlaying ? api.spotify.pause() : api.spotify.resume());
          refetch();
        },
      },
      refetch,
    };
  }

  if (radio) {
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
  return <Icon name="radio" size={size} color="var(--solar)" />;
}

/* ---- Desktop Rail mini player (mounted above the footer controls) --------- */

export function RailMiniPlayer({ expanded }: { expanded: boolean }) {
  const { user } = useAuth();
  const canControl = user?.role === 'admin';
  const navigate = useNavigate();
  const { np } = useNowPlaying();
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
        title={`${np.source === 'spotify' ? 'Spotify' : 'Radio'} · ${np.title}`}
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
        display: 'flex',
        alignItems: 'center',
        gap: 10,
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
  const { np } = useNowPlaying();
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
        gap: 10,
        // Keep the play/pause and body clear of the alarm FAB (right: 16, width 56).
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
