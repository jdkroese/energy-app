import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { DeviceDetailResponse, ClimateLever, DeviceWarmth } from '../lib/types';
import { Card, Icon, Button, IconButton, SegmentedControl } from '../components/ui';
import { StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * DeviceDetail (/devices/:id) — per-unit control, to the approved design:
 *   • header (name · model · state pill)
 *   • two cards: big SETPOINT stepper + ROOM-NOW (temp, target, delta)
 *   • mode + fan segmented controls
 *   • governing-automation banner
 *   • advanced grid (temp limit / range / comfort bounds)
 * All writes are admin + arm gated server-side.
 * ==========================================================================*/

const MODES = [
  { value: 'auto', label: 'Auto' },
  { value: 'heat', label: 'Heat' },
  { value: 'dry', label: 'Dry' },
  { value: 'fan', label: 'Fan' },
  { value: 'cool', label: 'Cool' },
];
const FANS = [
  { value: '0', label: 'Auto' },
  { value: '1', label: 'Low' },
  { value: '2', label: 'Med' },
  { value: '3', label: 'High' },
];
const WARMTH_COLOR: Record<DeviceWarmth, string> = {
  cold: 'var(--battery)', cool: 'var(--battery)', comfortable: 'var(--text-1)',
  warm: 'var(--grid)', hot: 'var(--danger)', unknown: 'var(--text-3)',
};

export function DeviceDetail({ ctx }: { ctx: ShellContext }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt, refetch } = usePolling<DeviceDetailResponse>(() => api.devices.detail(id ?? ''), 15_000, [id]);
  const [busy, setBusy] = useState(false);
  const [pendingSetpoint, setPendingSetpoint] = useState<number | null>(null);

  const dev = data?.device ?? null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch { /* keep last-good */ } finally { setBusy(false); setPendingSetpoint(null); refetch(); }
  };
  const cmd = (lever: ClimateLever, value: boolean | number | string) => run(() => api.devices.command(id ?? '', lever, value));

  if (!dev) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto', width: '100%', padding: wide ? 0 : '16px 14px' }}>
        <Card padded style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', padding: 28 }}>
          <Icon name="thermometer" size={26} color="var(--text-3)" />
          <div style={{ fontSize: 15, fontWeight: 600 }}>{loading ? 'Loading device…' : data && !data.connected ? 'AC Cloud not connected' : 'Device not found'}</div>
          <Button variant="secondary" iconLeft={<Icon name="chevron-left" size={15} />} onClick={() => nav('/devices')}>Back to devices</Button>
        </Card>
      </div>
    );
  }

  const canWrite = isAdmin;
  const setpoint = pendingSetpoint ?? dev.setpointC ?? 24;
  const lo = Math.max(16, dev.minSetpointC ?? 16, dev.comfortFloorC ?? 16);
  const hi = Math.min(30, dev.maxSetpointC ?? 30, dev.comfortCeilingC ?? 30);
  const step = (delta: number) => {
    const next = Math.min(hi, Math.max(lo, Math.round((setpoint + delta) * 2) / 2));
    setPendingSetpoint(next);
    void cmd('setpoint', next);
  };
  const toggleAutomation = (on: boolean) => run(() => api.devices.setSettings(id ?? '', { automationEnabled: on }));
  const releaseHold = () => run(() => api.devices.release(id ?? ''));
  const holdMins = dev.manualOverrideUntil ? Math.max(0, Math.round((dev.manualOverrideUntil - Date.now()) / 60_000)) : 0;

  const stateOn = dev.power;
  const stateLabel = !stateOn ? 'OFF' : dev.mode === 'cool' ? 'COOLING' : dev.mode === 'heat' ? 'HEATING' : dev.mode.toUpperCase();
  const stateColor = !stateOn ? 'var(--text-3)' : dev.mode === 'heat' ? 'var(--grid)' : 'var(--solar)';
  const delta = dev.currentTempC != null ? Math.round((dev.currentTempC - setpoint) * 10) / 10 : null;

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', width: '100%', padding: wide ? 0 : '8px 14px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: wide ? 0 : 8 }}>
        <IconButton variant="solid" aria-label="Back" onClick={() => nav('/devices')}><Icon name="chevron-left" size={18} /></IconButton>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>{dev.name}</h1>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Panasonic Etherea{dev.installation ? ` · ${dev.installation}` : ''}</div>
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', padding: '4px 10px', borderRadius: 'var(--radius-pill)', background: stateOn ? (dev.mode === 'heat' ? 'var(--grid-wash)' : 'var(--solar-wash)') : 'var(--surface-3)', color: stateColor }}>{stateLabel}</span>
      </div>

      {stale && <StaleBanner updatedAt={updatedAt} />}

      {/* SETPOINT + ROOM-NOW */}
      <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1.1fr' : '1fr', gap: 12 }}>
        <Card padded style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
          <div className="pwr-eyebrow">Setpoint</div>
          <div className="pwr-mono" style={{ fontSize: 44, fontWeight: 600, lineHeight: 1.1, color: 'var(--solar)' }}>{setpoint.toFixed(1)}°</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <IconButton variant="solid" aria-label="Lower setpoint" disabled={!canWrite || busy || setpoint <= lo} onClick={() => step(-0.5)}><Icon name="minus" size={18} /></IconButton>
            <IconButton variant="solid" aria-label="Raise setpoint" disabled={!canWrite || busy || setpoint >= hi} onClick={() => step(0.5)}><Icon name="plus" size={18} /></IconButton>
          </div>
        </Card>
        <Card padded style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div className="pwr-eyebrow">Room now</div>
              <div className="pwr-mono" style={{ fontSize: 26, fontWeight: 600, color: WARMTH_COLOR[dev.warmth] }}>{dev.currentTempC != null ? `${dev.currentTempC.toFixed(1)}°` : '—'}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="pwr-eyebrow">Δ to target</div>
              <div className="pwr-mono" style={{ fontSize: 15, marginTop: 6, color: delta != null && delta > 0 ? 'var(--grid)' : 'var(--solar)' }}>{delta != null ? `${delta > 0 ? '+' : ''}${delta}°` : '—'}</div>
            </div>
          </div>
          {dev.currentTempC != null && (
            <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-3)', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, Math.max(0, ((dev.currentTempC - lo) / (hi - lo)) * 100))}%`, background: WARMTH_COLOR[dev.warmth] }} />
            </div>
          )}
          <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>cooling to {setpoint.toFixed(1)}° · range {lo}–{hi}°</div>
        </Card>
      </div>

      {/* POWER */}
      <Button variant={stateOn ? 'secondary' : 'primary'} disabled={!canWrite || busy} iconLeft={<Icon name={stateOn ? 'power-off' : 'power'} size={16} />} onClick={() => cmd('power', !stateOn)}>
        {stateOn ? 'Turn off' : 'Turn on'}
      </Button>

      {/* MODE */}
      <div>
        <div className="pwr-eyebrow" style={{ marginBottom: 6 }}>Mode</div>
        <SegmentedControl size="sm" block options={MODES} value={dev.mode} onChange={(m) => canWrite && cmd('mode', m)} />
      </div>
      {/* FAN */}
      <div>
        <div className="pwr-eyebrow" style={{ marginBottom: 6 }}>Fan</div>
        <SegmentedControl size="sm" block options={FANS} onChange={(f) => canWrite && cmd('fan', Number(f))} />
      </div>

      {/* MANUAL HOLD BANNER — manual control overrides automation for a window. */}
      {holdMins > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: '10px 13px' }}>
          <Icon name="hand" size={17} color="var(--text-1)" />
          <div style={{ flex: 1, fontSize: 12 }}>
            <span style={{ fontWeight: 600 }}>Manual hold</span>
            <span style={{ color: 'var(--text-2)' }}> — automation won’t touch this unit for ~{holdMins} min</span>
          </div>
          <button type="button" disabled={!canWrite || busy} onClick={releaseHold} style={{ fontSize: 11, color: 'var(--solar)', background: 'none', border: 'none', cursor: canWrite ? 'pointer' : 'default', fontWeight: 600 }}>
            Release
          </button>
        </div>
      )}

      {/* AUTOMATION BANNER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, background: dev.automationEnabled ? 'var(--solar-wash)' : 'var(--surface-1)', border: `1px solid ${dev.automationEnabled ? 'rgba(46,230,160,0.2)' : 'var(--border-1)'}`, borderRadius: 'var(--radius-lg)', padding: '10px 13px' }}>
        <Icon name="zap" size={17} color={dev.automationEnabled ? 'var(--solar)' : 'var(--text-3)'} />
        <div style={{ flex: 1, fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>Solar-surplus pre-cool</span>
          <span style={{ color: 'var(--text-2)' }}> {dev.automationEnabled ? 'may drive this unit on surplus' : 'is excluded from this unit'}</span>
        </div>
        <button type="button" disabled={!canWrite || busy} onClick={() => toggleAutomation(!dev.automationEnabled)} style={{ fontSize: 11, color: 'var(--solar)', background: 'none', border: 'none', cursor: canWrite ? 'pointer' : 'default', fontWeight: 600 }}>
          {dev.automationEnabled ? 'Exclude' : 'Include'}
        </button>
      </div>

      {/* ADVANCED */}
      <div className="pwr-eyebrow">Advanced (Intesis)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <AdvTile label="Temp limit" value={`${dev.minSetpointC ?? 16}–${dev.maxSetpointC ?? 30}°`} />
        <AdvTile label="Comfort band" value={`${dev.comfortFloorC ?? 16}–${dev.comfortCeilingC ?? 30}°`} />
        <AdvTile label="Mode" value={dev.mode} />
        <AdvTile label="Installation" value={dev.installation ?? '—'} />
      </div>

      {!canWrite && <div style={{ fontSize: 11.5, color: 'var(--grid)', textAlign: 'center' }}>Read-only — only an admin can command devices, and control must be armed.</div>}
    </div>
  );
}

function AdvTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '9px 12px' }}>
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{label}</span>
      <span className="pwr-mono" style={{ fontSize: 12, color: 'var(--text-1)' }}>{value}</span>
    </div>
  );
}
