import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { Capability, ConfiguredResponse, DeviceDiagnosticsResponse } from '../lib/types';
import { Card, Icon, Button } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { GenericControl } from '../components/GenericControl';
import { resolveTypeMeta } from '../lib/deviceTypes';
import { SetupSheet } from './SetupSheet';
import type { DiscoveredDevice } from '../lib/types';

/* ============================================================================
 * GenericDeviceDetail (/devices/generic/:id) — the expanded view for a set-up
 * generic (Tuya onboarding) device: header + the full generic capability
 * renderer + a Re-classify affordance (re-opens the setup sheet) and a Remove
 * (un-setup → returns the device to the inbox). All writes are admin-gated.
 * ==========================================================================*/

export function GenericDeviceDetail({ ctx }: { ctx: ShellContext }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, stale, updatedAt, refetch } = usePolling<ConfiguredResponse>(api.devices.configured, 15_000);
  const [reclassify, setReclassify] = useState(false);

  const device = data?.devices.find((x) => x.id === id) ?? null;
  const customTypes = data?.customDeviceTypes ?? [];

  const writeCap = (dp: string, kind: Capability['kind'], value: unknown) =>
    api.devices.commandCap(id ?? '', dp, kind, value).finally(() => refetch());

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      {!device ? (
        <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>
          {data ? 'This device is not set up (or no longer reported).' : 'Loading…'}
        </Card>
      ) : (() => {
        const meta = resolveTypeMeta(device.typeId, customTypes);
        return (
          <>
            <Card padded style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 42, height: 42, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: meta.hue, flex: 'none' }}>
                <Icon name={meta.icon} size={21} />
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)' }}>{device.name}</div>
                <div className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {meta.label} · Tuya · {device.category || '?'}{!device.online ? ' · offline' : ''}
                </div>
              </div>
            </Card>

            <Card padded style={{ padding: 16 }}>
              <div className="pwr-eyebrow" style={{ marginBottom: 10 }}>Controls</div>
              <GenericControl capabilities={device.capabilities} values={device.values} onWrite={writeCap} disabled={!isAdmin} variant="detail" />
            </Card>

            <DiagnosticsSection id={device.id} />

            {isAdmin && (
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" size="sm" iconLeft={<Icon name="shuffle" size={14} />} onClick={() => setReclassify(true)}>Re-classify</Button>
                <Button variant="ghost" size="sm" iconLeft={<Icon name="trash-2" size={14} />} onClick={() => {
                  void api.devices.unsetup(device.id).then(() => nav('/devices?type=needs-setup'));
                }}>Remove from group</Button>
              </div>
            )}

            {reclassify && (
              <SetupSheet
                device={configuredToDiscovered(device)}
                wide={wide}
                customTypes={customTypes}
                initialName={device.name}
                initialTypeId={device.typeId}
                onClose={() => setReclassify(false)}
                onTypesChanged={() => refetch()}
                onDone={() => { setReclassify(false); refetch(); }}
              />
            )}
          </>
        );
      })()}
    </div>
  );

  if (wide) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}>
        <button type="button" onClick={() => nav('/devices?type=switching')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 13, marginBottom: 12 }}>
          <Icon name="chevron-left" size={16} /> Devices
        </button>
        {body}
      </div>
    );
  }
  return (
    <>
      <MobileHeader eyebrow="Devices" title="Device" right={<Avatar />} />
      <div style={{ padding: '8px 14px 22px' }}>
        <button type="button" onClick={() => nav('/devices?type=switching')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 13, marginBottom: 10 }}>
          <Icon name="chevron-left" size={16} /> Devices
        </button>
        {body}
      </div>
    </>
  );
}

/* ---- Diagnostics (id / ip / mac / datapoint table) ------------------------ *
 * Collapsed by default; fetches on first expand (on-demand — not polled). Surfaces
 * the device's identity + network + every datapoint, and (for set-up lights) which
 * DP the on/off toggle + scenes/schedules actually drive — for debugging control. */
function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function DiagRow({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '5px 0' }}>
      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{label}</span>
      <span className="pwr-mono" style={{ fontSize: 12, color: accent ? 'var(--solar)' : 'var(--text-1)', textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

function DiagnosticsSection({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DeviceDiagnosticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.devices
      .diagnostics(id)
      .then((r) => setData(r))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data && !loading) load();
  };

  const dev = data?.device ?? null;

  return (
    <Card padded style={{ padding: 16 }}>
      <button type="button" onClick={toggle} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        <Icon name="bug" size={14} color="var(--text-3)" />
        <span className="pwr-eyebrow" style={{ flex: 1, textAlign: 'left' }}>Diagnostics</span>
        {open && <button type="button" onClick={(e) => { e.stopPropagation(); load(); }} aria-label="Refresh" style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 2, display: 'inline-flex' }}><Icon name="refresh-cw" size={13} /></button>}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color="var(--text-3)" />
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {loading && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Loading…</div>}
          {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>Could not load diagnostics: {err}</div>}
          {dev && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <DiagRow label="Device ID" value={dev.id} />
                <DiagRow label="Category" value={dev.category || '—'} />
                <DiagRow label="Online" value={dev.online ? 'yes' : 'no'} />
                <DiagRow label="IP address" value={dev.ip ?? '—'} />
                <DiagRow label="MAC address" value={dev.mac ?? '—'} />
                {dev.primarySwitchDp && <DiagRow label="On/off datapoint" value={dev.primarySwitchDp} accent />}
              </div>
              <div className="pwr-eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Datapoints · {dev.dps.length}</div>
              <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                {dev.dps.map((p, i) => (
                  <div key={p.dp} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center', padding: '7px 10px', borderTop: i === 0 ? 'none' : '1px solid var(--border-1)', background: p.dp === dev.primarySwitchDp ? 'var(--solar-wash)' : 'transparent' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="pwr-mono" style={{ fontSize: 12, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.dp}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{p.kind}{p.readOnly ? ' · read-only' : ''}</div>
                    </div>
                    <div className="pwr-mono" style={{ fontSize: 12, color: 'var(--text-2)', textAlign: 'right', wordBreak: 'break-all', maxWidth: 170 }}>{fmtVal(p.value)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
          {data && !dev && !loading && !err && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No device data (Tuya not connected or device not reported).</div>}
        </div>
      )}
    </Card>
  );
}

/** Adapt a configured device back into the DiscoveredDevice shape the SetupSheet
 *  expects, for the Re-classify flow (capabilities + proposed icon/label). */
function configuredToDiscovered(d: { id: string; name: string; category: string; online: boolean; capabilities: Capability[]; roomGuess: string | null }): DiscoveredDevice {
  return {
    id: d.id,
    name: d.name,
    category: d.category,
    productName: null,
    online: d.online,
    proposedType: { label: 'Device', icon: 'plug' },
    capabilities: d.capabilities,
    confidence: 'high',
    roomGuess: d.roomGuess,
    readout: null,
  };
}
