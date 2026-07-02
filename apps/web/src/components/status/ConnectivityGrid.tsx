import { Card, StatusDot, Icon, Eyebrow } from '../ui';

/* Connectivity grid (docs/36 §5.2) — per-connector reachability tiles. Composes
 * the real settings.connections probes (Tesla/Sonnen/Weather) with subsystem-
 * derived status (fleetError/lastError + online counts) for the rest. Phase 1 has
 * no per-connector lastSeenTs (that's the Phase-2 probeAll extension), so tiles
 * show icon + name + StatusDot + detail only.
 *
 * Desktop: repeat(4,1fr); mobile: repeat(2,1fr). */

export type ConnTone = 'ok' | 'warning' | 'danger' | 'offline' | 'nosetup';

export interface ConnectorTile {
  key: string;
  name: string;
  icon: string;
  tone: ConnTone;
  detail: string;
}

const DOT: Record<ConnTone, 'solar' | 'grid' | 'danger' | 'offline'> = {
  ok: 'solar',
  warning: 'grid',
  danger: 'danger',
  offline: 'offline',
  nosetup: 'offline',
};

function Tile({ t }: { t: ConnectorTile }) {
  const dim = t.tone === 'nosetup';
  return (
    <div
      style={{
        background: 'var(--surface-1)',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--radius-md)',
        padding: '11px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        opacity: dim ? 0.6 : 1,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name={t.icon} size={16} color="var(--text-2)" />
        <span style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {t.name}
        </span>
      </div>
      <StatusDot tone={DOT[t.tone]} live={t.tone === 'ok'}>
        <span style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {t.detail}
        </span>
      </StatusDot>
    </div>
  );
}

export function ConnectivityGrid({ tiles, wide }: { tiles: ConnectorTile[]; wide: boolean }) {
  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Eyebrow>Connectivity</Eyebrow>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: wide ? 'repeat(4, 1fr)' : 'repeat(2, 1fr)',
          gap: 8,
        }}
      >
        {tiles.map((t) => (
          <Tile key={t.key} t={t} />
        ))}
      </div>
    </Card>
  );
}
