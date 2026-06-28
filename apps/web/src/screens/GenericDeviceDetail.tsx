import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { Capability, ConfiguredResponse, DeviceDiagnosticsResponse, Schedule, SchedulesResponse } from '../lib/types';
import { Card, Icon, Button } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { GenericControl } from '../components/GenericControl';
import { primaryCapabilities, secondaryCapabilities, hasPowerSwitch } from '../lib/capabilities';
import { resolveTypeMeta } from '../lib/deviceTypes';
import { UnitScheduleBox } from '../components/schedules/UnitScheduleBox';
import { EditRuleOverlay } from '../components/schedules/EditRuleOverlay';
import { newRuleDraft } from '../lib/scheduleRules';
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
  const { data: schedData, refetch: refetchSchedules } = usePolling<SchedulesResponse>(api.schedules.list, 0);
  const [reclassify, setReclassify] = useState(false);
  const [editingRule, setEditingRule] = useState<{ rule: Schedule; isNew: boolean } | null>(null);

  const device = data?.devices.find((x) => x.id === id) ?? null;
  const customTypes = data?.customDeviceTypes ?? [];

  const writeCap = (dp: string, kind: Capability['kind'], value: unknown) =>
    api.devices.commandCap(id ?? '', dp, kind, value).finally(() => refetch());

  // ---- Schedule (rule) editing — same overlay/box as the climate device page ----
  const allRules = schedData?.schedules ?? [];
  const unitRules = id ? allRules.filter((s) => s.scope.kind === 'unit' && s.scope.deviceId === id) : [];
  const refetchSched = () => refetchSchedules();
  const toggleRuleEnabled = (s: Schedule, enabled: boolean) =>
    api.schedules.update(s.id, { enabled }).finally(refetchSched);
  const toggleRuleDay = (s: Schedule, day: number) => {
    const days = s.days.includes(day) ? s.days.filter((x) => x !== day) : [...s.days, day].sort();
    return api.schedules.update(s.id, { days }).finally(refetchSched);
  };
  const saveRule = async (rule: Schedule, copyTo: string[]) => {
    const { id: _rid, ...payload } = rule;
    if (rule.id) await api.schedules.update(rule.id, payload);
    else await api.schedules.create(payload);
    for (const deviceId of copyTo) await api.schedules.create({ ...payload, scope: { kind: 'unit', deviceId } });
    setEditingRule(null);
    refetchSched();
  };
  const deleteRule = (s: Schedule) => { setEditingRule(null); void api.schedules.remove(s.id).finally(refetchSched); };
  const openAddRule = () => {
    if (!device) return;
    setEditingRule({ rule: newRuleDraft({ type: 'circuit', deviceId: device.id, name: device.name }), isNew: true });
  };

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
              <GenericControl capabilities={primaryCapabilities(device.capabilities)} values={device.values} onWrite={writeCap} disabled={!isAdmin} variant="detail" />
            </Card>

            <MoreControlsSection
              caps={secondaryCapabilities(device.capabilities)}
              values={device.values}
              onWrite={writeCap}
              disabled={!isAdmin}
            />

            {/* SCHEDULE — switchable devices only: on/off windows (+ speed/direction),
                the same UnitScheduleBox + overlay as the climate device page. */}
            {hasPowerSwitch(device.capabilities) && (
              <UnitScheduleBox
                name={device.name}
                type="circuit"
                rules={unitRules}
                canConfig={isAdmin}
                busy={false}
                onAddRule={openAddRule}
                onEditRule={(s) => setEditingRule({ rule: s, isNew: false })}
                onToggleEnabled={toggleRuleEnabled}
                onToggleDay={toggleRuleDay}
              />
            )}

            <DiagnosticsSection id={device.id} isAdmin={isAdmin} />

            {editingRule && (
              <EditRuleOverlay
                rule={editingRule.rule}
                unitName={device.name}
                wide={wide}
                peers={[]}
                allRules={allRules}
                capabilities={device.capabilities}
                canDelete={isAdmin && !editingRule.isNew}
                onCancel={() => setEditingRule(null)}
                onSave={saveRule}
                onDelete={() => deleteRule(editingRule.rule)}
              />
            )}

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

/* ---- More controls & configuration (the long tail, collapsed) ------------- *
 * Everything that isn't an everyday primary lever (countdown, mode, direction,
 * measures, statuses, actions). Collapsed by default; same GenericControl renderer
 * + writeCap path as the primary Controls card. Only rendered when there ARE
 * secondary caps (the caller passes secondaryCapabilities(...)). */
function MoreControlsSection({ caps, values, onWrite, disabled }: {
  caps: Capability[];
  values: Record<string, unknown>;
  onWrite: (dp: string, kind: Capability['kind'], value: unknown) => Promise<unknown> | void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (caps.length === 0) return null;
  return (
    <Card padded style={{ padding: 16 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        <span className="pwr-eyebrow" style={{ flex: 1, textAlign: 'left' }}>More controls &amp; configuration</span>
        <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{caps.length}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color="var(--text-3)" />
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          <GenericControl capabilities={caps} values={values} onWrite={onWrite} disabled={disabled} variant="detail" />
        </div>
      )}
    </Card>
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

function DiagnosticsSection({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DeviceDiagnosticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testLog, setTestLog] = useState<string[]>([]);

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

  const runTest = (dp: string, value: boolean, cmdApi: 'v1' | 'v2') => {
    setTesting(true);
    api.devices
      .testCommand(id, dp, value, cmdApi)
      .then((r) => {
        const p = r.probe;
        setTestLog((l) => [
          `${cmdApi} · ${dp}=${String(value)} → success=${p.success} result=${JSON.stringify(p.result)}${p.code != null ? ` code=${p.code}` : ''}${p.msg ? ` msg=${p.msg}` : ''}`,
          ...l,
        ].slice(0, 8));
      })
      .catch((e) => setTestLog((l) => [`${cmdApi} · ${dp}=${String(value)} → ERROR ${(e as Error).message}`, ...l].slice(0, 8)))
      .finally(() => setTesting(false));
  };

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

              {/* Command test — fire the on/off DP through both Tuya APIs to see which
                  one the device actually obeys (legacy v1 vs newer v2 thing-model). */}
              {isAdmin && dev.primarySwitchDp && (
                <div style={{ marginTop: 14 }}>
                  <div className="pwr-eyebrow" style={{ marginBottom: 6 }}>Test relay · {dev.primarySwitchDp}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {(['v1', 'v2'] as const).map((cmdApi) => (
                      <div key={cmdApi} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 18 }}>{cmdApi}</span>
                        <Button size="sm" variant="secondary" disabled={testing} onClick={() => runTest(dev.primarySwitchDp as string, true, cmdApi)}>On</Button>
                        <Button size="sm" variant="ghost" disabled={testing} onClick={() => runTest(dev.primarySwitchDp as string, false, cmdApi)}>Off</Button>
                      </div>
                    ))}
                  </div>
                  {testLog.length > 0 && (
                    <div className="pwr-mono" style={{ marginTop: 8, fontSize: 11, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 3, background: 'var(--surface-2)', borderRadius: 'var(--radius-md)', padding: '8px 10px', wordBreak: 'break-all' }}>
                      {testLog.map((line, i) => <div key={i} style={{ color: i === 0 ? 'var(--text-1)' : 'var(--text-3)' }}>{line}</div>)}
                    </div>
                  )}
                  <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 6 }}>Tip: try v1 On, then v2 On — whichever physically switches the plug is the API it needs.</div>
                </div>
              )}
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
