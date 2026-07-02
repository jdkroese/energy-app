import { useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { DecisionRecord } from '../../lib/types';
import { Card, Eyebrow, Icon, EmptyState } from '../ui';

/* Decisions panel (Phase 0 rule visibility) — "why is the battery doing X right now?"
 * Reads the coordinator's per-tick decision trace (GET /api/control/decisions): the
 * CURRENT stance per actuator (winner + reason + since-when) and an expandable list of
 * the recent stance CHANGES. Deliberately modest — the full Rules screen comes with the
 * rule-engine redesign; this is the visibility slice. Both viewports (wide 2-col grid,
 * narrow stacked). */

const POLL_MS = 12_000;

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Compact "how long has this stance held" — 45s / 12m / 3.5h. */
function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

/** Walk the newest-first ring while the stance matches the current one → when it began. */
function stanceSince(decisions: DecisionRecord[], match: (d: DecisionRecord) => boolean): number | null {
  let since: number | null = null;
  for (const d of decisions) {
    if (!match(d)) break;
    since = d.ts;
  }
  return since;
}

function StanceCard({ label, value, reason, since }: { label: string; value: string; reason: string; since: number | null }) {
  return (
    <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="pwr-eyebrow" style={{ fontSize: 10 }}>{label}</span>
        {since !== null && (
          <span className="pwr-mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-3)' }}>
            since {fmtTime(since)} · {fmtAgo(since)}
          </span>
        )}
      </div>
      <span className="pwr-mono" style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-1)', overflowWrap: 'anywhere' }}>{value || '—'}</span>
      <span style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.4 }}>{reason || 'no decision recorded yet'}</span>
    </div>
  );
}

export function DecisionsPanel({ wide }: { wide: boolean }) {
  const { data } = usePolling(() => api.control.decisions(100), POLL_MS);
  const [showAll, setShowAll] = useState(false);
  const [showStoodDown, setShowStoodDown] = useState(false);

  const decisions = data?.decisions ?? [];
  const cur = data?.current ?? null;

  const changes = decisions.filter((d) => d.changed.length > 0);
  const visibleChanges = showAll ? changes.slice(0, 30) : changes.slice(0, 5);

  const teslaSince = cur ? stanceSince(decisions, (d) => d.tesla.mode.value === cur.tesla.mode.value) : null;
  const sonnenSince = cur ? stanceSince(decisions, (d) => d.sonnen.branch === cur.sonnen.branch) : null;

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Eyebrow>Decisions — why is the battery doing this?</Eyebrow>
        {cur && (
          <span className="pwr-mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
            {cur.band} · {cur.armed ? `armed/${cur.mode}` : 'disarmed'} · tick {fmtTime(cur.ts)}
          </span>
        )}
      </div>

      {!cur ? (
        <EmptyState
          icon="git-branch"
          title="No decisions recorded yet."
          subtitle="The coordinator records one per tick while Autopilot is armed in Auto."
          style={{ padding: '20px 16px' }}
        />
      ) : (
        <>
          {/* Current stance per actuator (winner + reason + since-when). */}
          <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1fr' : '1fr', gap: 8 }}>
            <StanceCard label="Tesla · mode" value={cur.tesla.mode.value} reason={cur.tesla.mode.reason} since={teslaSince} />
            <StanceCard label="Sonnen · branch" value={cur.sonnen.branch} reason={cur.sonnen.reason} since={sonnenSince} />
          </div>

          {/* Inputs the tick reasoned on. */}
          <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)', display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
            <span>import {cur.inputs.gridImportKw.toFixed(2)} kW</span>
            <span>export {cur.inputs.gridExportKw.toFixed(2)} kW</span>
            <span>meter: {cur.inputs.gridSource}</span>
            <span>Sonnen {cur.inputs.sonnenSoc ?? '—'}%</span>
            <span>Tesla {cur.inputs.teslaSoc ?? '—'}% (res {cur.tesla.reservePct}%)</span>
          </div>

          {/* Rules that stood down this tick (collapsed by default). */}
          {cur.stoodDown.length > 0 && (
            <div>
              <button
                type="button"
                className="pwr-press"
                onClick={() => setShowStoodDown((v) => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-3)', font: 'inherit', fontSize: 11.5 }}
              >
                <Icon name={showStoodDown ? 'chevron-down' : 'chevron-right'} size={12} color="var(--text-3)" />
                {cur.stoodDown.length} rule{cur.stoodDown.length === 1 ? '' : 's'} stood down
              </button>
              {showStoodDown && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                  {cur.stoodDown.map((s) => (
                    <div key={s.rule} style={{ fontSize: 11.5, color: 'var(--text-3)', display: 'flex', gap: 6, minWidth: 0 }}>
                      <span className="pwr-mono" style={{ color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{s.rule}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.reason}>{s.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Recent stance changes (the events the coordinator also logs to the Event Viewer). */}
          <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="pwr-eyebrow" style={{ fontSize: 10 }}>Recent stance changes</span>
            {changes.length === 0 ? (
              <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>None in the recorded window — steady state.</span>
            ) : (
              <>
                {visibleChanges.map((d) => (
                  <div key={d.ts} style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
                    <span className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{fmtTime(d.ts)}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.changed.includes('sonnen') ? d.sonnen.reason : d.tesla.mode.reason}>
                      {d.changed.includes('tesla.mode') && (
                        <>Tesla → <span className="pwr-mono" style={{ color: 'var(--text-1)' }}>{d.tesla.mode.value}</span></>
                      )}
                      {d.changed.includes('tesla.mode') && d.changed.includes('sonnen') && ' · '}
                      {d.changed.includes('sonnen') && (
                        <>Sonnen → <span className="pwr-mono" style={{ color: 'var(--text-1)' }}>{d.sonnen.branch}</span></>
                      )}
                      <span style={{ color: 'var(--text-3)' }}> — {d.changed.includes('sonnen') ? d.sonnen.reason : d.tesla.mode.reason}</span>
                    </span>
                  </div>
                ))}
                {changes.length > 5 && (
                  <button
                    type="button"
                    className="pwr-press"
                    onClick={() => setShowAll((v) => !v)}
                    style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--battery)', font: 'inherit', fontSize: 11.5 }}
                  >
                    {showAll ? 'Show fewer' : `Show all ${Math.min(changes.length, 30)}`}
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
