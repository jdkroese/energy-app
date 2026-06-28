import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { Capability, ConfiguredResponse } from '../lib/types';
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
