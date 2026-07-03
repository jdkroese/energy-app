import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { IrrigationActiveResponse, IrrigationActiveZone } from '../../lib/types';
import { Icon } from '../ui/Icon';
import { StatusDot } from '../ui/StatusDot';
import { useAuth } from '../../auth/AuthProvider';

/* ============================================================================
 * Global WATERING-NOW indicator — mirrors the now-playing mini player: a compact,
 * persistent chip pinned in the nav so any running irrigation (a scheduled zone or
 * a manual Water-now) is visible from ANY screen, with time remaining and a Stop.
 *
 *  - useActiveIrrigation(): light 8 s poll of /api/irrigation/active (getZones is
 *      ~10 s-cached server-side, so this is cheap even fleet-wide).
 *  - RailWatering:   mounted above the Rail footer (desktop). Collapsed → glyph + dot.
 *  - MobileWatering: a slim bar above the TabBar (below the music bar).
 *
 * Renders NOTHING when nothing is watering. Body tap → /irrigation; Stop (admin) stops all.
 * ==========================================================================*/

const POLL_MS = 8_000;

export function useActiveIrrigation(): {
  active: IrrigationActiveZone[];
  refetch: () => void;
} {
  const { data, refetch } = usePolling<IrrigationActiveResponse>(
    api.irrigation.active,
    POLL_MS,
  );
  return { active: data?.active ?? [], refetch };
}

/** Title + sub-label for the chip from the active-zone list. */
function summarize(active: IrrigationActiveZone[]): { title: string; sub: string } {
  if (active.length === 1) {
    const z = active[0];
    return {
      title: z.name,
      sub: z.remainingMin ? `~${z.remainingMin}m left` : 'running',
    };
  }
  const rems = active
    .map((z) => z.remainingMin)
    .filter((m): m is number => typeof m === 'number');
  const soonest = rems.length ? Math.min(...rems) : null;
  return {
    title: `${active.length} zones watering`,
    sub: soonest ? `~${soonest}m left` : 'running',
  };
}

function useStopAll(refetch: () => void) {
  const { user } = useAuth();
  const canControl = user?.role === 'admin';
  const [busy, setBusy] = useState(false);
  const stop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canControl) return;
    setBusy(true);
    try {
      await api.irrigation.command('rb-all', 'stop');
      refetch();
    } finally {
      setBusy(false);
    }
  };
  return { canControl, busy, stop };
}

function StopButton({
  busy,
  onStop,
  size = 30,
}: {
  busy: boolean;
  onStop: (e: React.MouseEvent) => void;
  size?: number;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={(e) => void onStop(e)}
      aria-label="Stop watering"
      title="Stop watering"
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: '50%',
        border: 'none',
        background: 'var(--grid-wash)',
        color: 'var(--grid)',
        cursor: busy ? 'default' : 'pointer',
        display: 'grid',
        placeItems: 'center',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Icon name="square" size={Math.round(size * 0.42)} />
    </button>
  );
}

/* ---- Desktop Rail (mounted above the footer controls) --------------------- */

export function RailWatering({ expanded }: { expanded: boolean }) {
  const navigate = useNavigate();
  const { active, refetch } = useActiveIrrigation();
  const { canControl, busy, stop } = useStopAll(refetch);
  if (active.length === 0) return null;

  const { title, sub } = summarize(active);
  const open = () => navigate('/irrigation');

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={open}
        title={`Watering: ${title} · ${sub}`}
        aria-label={`Watering ${title}. Open irrigation.`}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 42,
          border: '1px solid var(--solar)',
          background: 'var(--surface-1)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--solar)',
          cursor: 'pointer',
        }}
      >
        <Icon name="droplets" size={18} />
        <span
          style={{
            position: 'absolute',
            top: 7,
            right: 7,
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--solar)',
            boxShadow: '0 0 6px var(--solar)',
          }}
        />
      </button>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') open();
      }}
      title={`Watering: ${title} · ${sub}`}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        border: '1px solid var(--solar)',
        background: 'var(--surface-1)',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
      }}
    >
      <StatusDot tone="solar" live />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="pwr-eyebrow" style={{ color: 'var(--solar)', fontSize: 9.5 }}>
          Watering · {sub}
        </div>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--text-1)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
      </div>
      {canControl && <StopButton busy={busy} onStop={stop} size={28} />}
    </div>
  );
}

/* ---- Mobile (slim bar anchored above the TabBar) -------------------------- */

export function MobileWatering() {
  const navigate = useNavigate();
  const { active, refetch } = useActiveIrrigation();
  const { canControl, busy, stop } = useStopAll(refetch);
  if (active.length === 0) return null;

  const { title, sub } = summarize(active);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate('/irrigation')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') navigate('/irrigation');
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        // Keep clear of the alarm FAB (right: 16, width 56).
        padding: '8px 78px 8px 14px',
        borderTop: '1px solid var(--border-1)',
        background: 'var(--glass-fill, rgba(15,22,25,.9))',
        backdropFilter: 'blur(var(--blur-glass, 18px))',
        WebkitBackdropFilter: 'blur(var(--blur-glass, 18px))',
        cursor: 'pointer',
      }}
    >
      <span style={{ color: 'var(--solar)', display: 'grid', placeItems: 'center' }}>
        <StatusDot tone="solar" live />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-1)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--solar)', fontFamily: 'var(--font-mono)' }}>
          Watering · {sub}
        </div>
      </div>
      {canControl && <StopButton busy={busy} onStop={stop} size={34} />}
    </div>
  );
}
