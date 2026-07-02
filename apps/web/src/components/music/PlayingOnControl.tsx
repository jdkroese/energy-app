import { useEffect, useMemo, useRef, useState } from 'react';
import type { SonosSpeaker } from '../../lib/types';
import { Icon, Slider } from '../ui';

/* ============================================================================
 * PlayingOnControl — ONE reusable "Playing on" control, shared by the Spotify
 * now-playing panel, the Radio now-playing banner, and the global mini-player
 * popover/sheet. It consolidates what used to be three near-identical speaker +
 * volume UIs so behaviour is identical everywhere.
 *
 * It shows, top to bottom:
 *   1. GROUP master volume — one slider that moves every in-scope speaker together.
 *   2. The FULL zone list — all fleet zones as toggle rows; in-scope = checked.
 *      Toggling a zone calls onSetSpeakers() so the change is LIVE (added zones join
 *      the coordinator in sync; removed zones leave + stop) — no need to re-press play.
 *   3. Per-zone volume — an expandable slider per in-scope zone (writes that one zone).
 *
 * Source-agnostic: the parent wires `onSetSpeakers` (POST /api/{radio|spotify}/speakers)
 * and `onSetVolume` (POST /api/speakers/:id/volume). Debounced volume writes; optimistic
 * toggle with a reconcile from the refreshed now-playing (the parent re-fetches on change).
 * ==========================================================================*/

/** A volume slider whose writes are coalesced (~250ms) so dragging doesn't flood the API.
 *  It follows the live value only while the user isn't actively dragging. */
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

export interface PlayingOnControlProps {
  /** The full Sonos fleet (all zones). Stereo pairs already collapse to one zone. */
  fleet: SonosSpeaker[];
  /** The zone ids currently in scope (playing). */
  inScopeIds: string[];
  /** Toggle the active playback's zone set → reconciles the group live. */
  onSetSpeakers: (ids: string[]) => Promise<void>;
  /** Write one zone's volume (0–100). */
  onSetVolume: (id: string, pct: number) => Promise<unknown> | void;
  /** Refresh the now-playing/fleet after a change so live values reflect it. */
  onChanged: () => void;
  /** Read-only (non-admin) — hide the interactive controls. */
  canControl: boolean;
  /** Default volume shown when no zone volume is known yet. */
  fallbackVolume?: number;
  /** Compact spacing (used in the mini-player popover/sheet). */
  compact?: boolean;
  /**
   * Standalone / idle mode: nothing is playing, so there's no active group to add or
   * remove from. Every fleet zone is shown as a plain per-zone volume row (volume is
   * settable anytime — Sonos volume is persistent), the group master moves ALL zones,
   * and the join/leave toggle semantics are disabled (`onSetSpeakers` is never called).
   * The playing-mode behaviour is unchanged when this is false.
   */
  standalone?: boolean;
}

export function PlayingOnControl({
  fleet, inScopeIds, onSetSpeakers, onSetVolume, onChanged, canControl,
  fallbackVolume = 25, compact = false, standalone = false,
}: PlayingOnControlProps) {
  // In standalone/idle mode start expanded so every zone's volume slider is visible.
  const [expanded, setExpanded] = useState(standalone);
  // Optimistic scope while a toggle is in flight — snaps back to props once the parent refetches.
  const [pending, setPending] = useState<string[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Standalone = the whole fleet is the "scope" for group-volume purposes, but no zone is
  // ever "checked" (there's no active group to reconcile), so toggles are inert.
  const scope = standalone ? [] : (pending ?? inScopeIds);
  const scopeSet = useMemo(() => new Set(scope), [scope]);
  const inScope = useMemo(() => fleet.filter((s) => scopeSet.has(s.id)), [fleet, scopeSet]);

  // Group master = the average of the current volumes. In standalone it spans the full
  // fleet; while playing it's the in-scope zones only (best-effort).
  const volSource = standalone ? fleet : inScope;
  const vols = volSource.map((s) => (typeof s.volumePct === 'number' ? s.volumePct : 0));
  const groupVol = vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : fallbackVolume;

  const setGroup = (pct: number) => {
    volSource.forEach((s) => { void Promise.resolve(onSetVolume(s.id, pct)).catch(() => {}); });
    onChanged();
  };
  const setOne = (id: string, pct: number) => {
    void Promise.resolve(onSetVolume(id, pct)).then(onChanged).catch(() => {});
  };

  const toggleZone = async (id: string) => {
    if (!canControl || busyId) return;
    const next = scopeSet.has(id) ? scope.filter((x) => x !== id) : [...scope, id];
    setPending(next);
    setBusyId(id);
    try {
      await onSetSpeakers(next);
      onChanged();
    } catch {
      setPending(null); // revert on failure
    } finally {
      setBusyId(null);
      // Clear the optimistic overlay shortly after so props (refetched) take over.
      setTimeout(() => setPending(null), 400);
    }
  };

  const gap = compact ? 9 : 11;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {/* Group master volume — shown while playing (in-scope zones) or, in standalone
          mode, whenever there's more than one zone (moves the whole fleet together). */}
      {(standalone ? fleet.length > 1 : inScope.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="volume-2" size={15} color="var(--text-3)" />
          <div style={{ flex: 1 }}>
            <DebouncedSlider value={groupVol} onCommit={canControl ? setGroup : () => {}} />
          </div>
          <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)', width: 30, textAlign: 'right' }}>{groupVol}%</span>
        </div>
      )}

      {/* Zone list. While playing: every fleet zone as a toggle (in-scope = checked; tap
          to add/remove live). In standalone/idle: a plain per-zone volume row for each
          zone — no checkbox, no join/leave (volume only, which is always settable). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
          <span className="pwr-eyebrow" style={{ color: 'var(--text-3)' }}>
            {standalone ? `Speakers · ${fleet.length}` : `Playing on · ${inScope.length}/${fleet.length}`}
          </span>
          {!standalone && canControl && inScope.length > 1 && (
            <button type="button" onClick={() => setExpanded((v) => !v)}
              style={{ background: 'none', border: 'none', color: 'var(--solar)', fontSize: 11, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3, padding: 0 }}>
              <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} />
              {expanded ? 'Hide' : 'Per-zone'} volume
            </button>
          )}
        </div>
        {fleet.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '6px 2px' }}>No speakers found.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
            {fleet.map((s, i) => {
              const on = scopeSet.has(s.id);
              const busy = busyId === s.id;

              // Standalone / idle: no toggle — each row is just a labelled volume slider.
              if (standalone) {
                return (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 11, padding: '10px 11px',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border-1)',
                  }}>
                    <span style={{ flex: 'none', width: compact ? 92 : 108, minWidth: 0, fontSize: 13, fontWeight: 500, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                    <div style={{ flex: 1 }}>
                      <DebouncedSlider value={typeof s.volumePct === 'number' ? s.volumePct : 0} onCommit={canControl ? (pct) => setOne(s.id, pct) : () => {}} />
                    </div>
                    <span className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)', flex: 'none', width: 30, textAlign: 'right' }}>{typeof s.volumePct === 'number' ? s.volumePct : 0}%</span>
                  </div>
                );
              }

              return (
                <div key={s.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                  <button
                    type="button"
                    disabled={!canControl || !!busyId}
                    onClick={() => void toggleZone(s.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44,
                      padding: '9px 11px', cursor: canControl && !busyId ? 'pointer' : 'default', textAlign: 'left',
                      border: 'none', background: on ? 'var(--solar-wash)' : 'transparent', color: 'var(--text-1)',
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    <span style={{
                      width: 18, height: 18, borderRadius: 5, flex: 'none', display: 'grid', placeItems: 'center',
                      color: 'var(--accent-contrast)',
                      border: on ? 'none' : '1.5px solid var(--border-3)', background: on ? 'var(--solar)' : 'transparent',
                    }}>{on && <Icon name="check" size={12} />}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: on ? 600 : 500, color: on ? 'var(--solar)' : 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                    {typeof s.volumePct === 'number' && on && (
                      <span className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)', flex: 'none' }}>{s.volumePct}%</span>
                    )}
                  </button>
                  {/* Per-zone volume (inline, only when expanded + in-scope). */}
                  {canControl && expanded && on && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 11px 10px 39px' }}>
                      <div style={{ flex: 1 }}>
                        <DebouncedSlider value={typeof s.volumePct === 'number' ? s.volumePct : 0} onCommit={(pct) => setOne(s.id, pct)} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!standalone && canControl && inScope.length <= 1 && (
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 5 }}>
            Removing the last zone stops playback.
          </div>
        )}
        {standalone && canControl && (
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 5 }}>
            Volume is saved per speaker. Start a station or a playlist to group zones.
          </div>
        )}
      </div>
    </div>
  );
}
