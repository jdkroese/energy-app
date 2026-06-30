import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type {
  ConfiguredResponse, HomeScenesResponse, SceneControllersResponse,
} from '../lib/types';
import { Card, Icon, Button, Switch, Select } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { resolveTypeMeta } from '../lib/deviceTypes';

/* ============================================================================
 * SceneControllerDetail (/devices/controller/:id) — bind a wireless scene
 * switch's 4 buttons to whole-home scenes (Phase 1: single-click toggle). Mirrors
 * GenericDeviceDetail's routing/layout: header (name/online) + an Enabled toggle +
 * 4 button rows, each a Scene picker (dropdown of HomeScenes + "None"). Saving
 * PUTs /api/scene-controllers/:deviceId. Responsive desktop (≥768) / mobile (<768).
 * The coordinator does the live press-handling; this screen only edits bindings.
 * ==========================================================================*/

const NONE = '';

export function SceneControllerDetail({ ctx }: { ctx: ShellContext }) {
  const { id = '' } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;

  const { data: ctrlData, stale, updatedAt, refetch } = usePolling<SceneControllersResponse>(api.sceneControllers.list, 15_000);
  const { data: scenesData } = usePolling<HomeScenesResponse>(api.homeScenes.list, 0);
  // The configured-device record gives us the display name/category even before the
  // (fleet-joined) controller view resolves — so the header is never blank.
  const { data: configuredData } = usePolling<ConfiguredResponse>(api.devices.configured, 0);

  const controller = ctrlData?.controllers.find((c) => c.deviceId === id) ?? null;
  const configured = configuredData?.devices.find((d) => d.id === id) ?? null;
  const customTypes = configuredData?.customDeviceTypes ?? [];
  const meta = resolveTypeMeta(configured?.typeId ?? 'controller', customTypes);
  const scenes = scenesData?.scenes ?? [];

  // Local edit buffer: enabled + per-index sceneId (loaded from the server view).
  const [enabled, setEnabled] = useState(true);
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Hydrate the buffer from the server view ONCE it loads (and whenever the device id
  // changes), but never stomp in-progress edits.
  useEffect(() => {
    if (!controller || dirty) return;
    setEnabled(controller.enabled);
    const next: Record<number, string> = {};
    for (const b of controller.buttons) next[b.index] = b.single?.sceneId ?? NONE;
    setPicks(next);
  }, [controller, dirty]);

  const sceneOptions = useMemo(
    () => [{ value: NONE, label: 'None' }, ...scenes.map((s) => ({ value: s.id, label: s.name }))],
    [scenes],
  );

  const setEnabledDirty = (v: boolean) => { setEnabled(v); setDirty(true); };
  const setPick = (index: number, sceneId: string) => { setPicks((p) => ({ ...p, [index]: sceneId })); setDirty(true); };

  const save = async () => {
    setSaving(true);
    try {
      const buttons = [1, 2, 3, 4].map((index) => {
        const sceneId = picks[index] || NONE;
        const label = controller?.buttons.find((b) => b.index === index)?.label;
        return {
          index,
          ...(label ? { label } : {}),
          ...(sceneId ? { single: { sceneId } } : {}),
        };
      });
      await api.sceneControllers.save(id, { enabled, buttons });
      setDirty(false);
      setSavedAt(Date.now());
      refetch();
    } finally {
      setSaving(false);
    }
  };

  const buttonRow = (index: number) => {
    const live = controller?.buttons.find((b) => b.index === index);
    const on = live?.single?.on === true && (picks[index] ?? '') === (live?.single?.sceneId ?? '');
    const pick = picks[index] ?? NONE;
    return (
      <div
        key={index}
        style={{
          display: 'flex', flexDirection: wide ? 'row' : 'column', alignItems: wide ? 'center' : 'stretch',
          gap: wide ? 14 : 8, padding: wide ? '12px 4px' : '12px 0',
        }}
      >
        {/* Button N badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: wide ? 150 : undefined }}>
          <span style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: meta.hue, flex: 'none', fontWeight: 700, fontSize: 13 }} className="pwr-mono">{index}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-1)' }}>Button {index}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
              single-click{pick && on ? ' · on' : ''}
            </div>
          </div>
        </div>
        {/* Scene picker */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Select
            value={pick}
            options={sceneOptions}
            disabled={!isAdmin}
            onChange={(e) => setPick(index, e.target.value)}
          />
        </div>
      </div>
    );
  };

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      {/* HEADER */}
      <Card padded style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 42, height: 42, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: meta.hue, flex: 'none' }}>
          <Icon name={meta.icon} size={21} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {controller?.name ?? configured?.name ?? 'Scene switch'}
          </div>
          <div className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {meta.label} · Tuya{configured?.category ? ` · ${configured.category}` : ''}
            {controller && !controller.online ? ' · offline' : ''}
          </div>
        </div>
      </Card>

      {/* If neither the controller view nor the configured record resolve, it's not a
          set-up scene switch (or not reported yet). */}
      {!controller && !configured && (
        <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>
          {ctrlData ? 'This controller is not set up (or no longer reported).' : 'Loading…'}
        </Card>
      )}

      {(controller || configured) && (
        <>
          {/* ENABLED */}
          <Card padded style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
            <Icon name="power" size={16} color={enabled ? 'var(--solar)' : 'var(--text-3)'} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, color: 'var(--text-1)', fontWeight: 600 }}>Enabled</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 1 }}>
                When off, button presses are ignored (bindings are kept).
              </div>
            </div>
            <Switch checked={enabled} disabled={!isAdmin} onChange={(e) => setEnabledDirty(e.target.checked)} />
          </Card>

          {/* BUTTON BINDINGS */}
          <Card padded style={{ padding: 16 }}>
            <div className="pwr-eyebrow" style={{ marginBottom: 4 }}>Buttons → scenes</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 8 }}>
              Each button toggles its scene on a single click — press once to apply, press again to turn it off.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {[1, 2, 3, 4].map((index, i) => (
                <div key={index} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                  {buttonRow(index)}
                </div>
              ))}
            </div>
            {scenes.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="info" size={13} color="var(--text-3)" />
                No whole-home scenes yet — create one on the Live screen, then bind it here.
              </div>
            )}
          </Card>

          {/* SAVE */}
          {isAdmin && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Button variant="primary" disabled={!dirty || saving} loading={saving} iconLeft={<Icon name="check" size={14} />} onClick={save}>
                Save
              </Button>
              {savedAt && !dirty && (
                <span style={{ fontSize: 12, color: 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <Icon name="check" size={13} color="var(--solar)" /> Saved
                </span>
              )}
            </div>
          )}
          {!isAdmin && <div style={{ fontSize: 11.5, color: 'var(--text-3)', textAlign: 'center' }}>Read-only — only an admin can edit these bindings.</div>}
        </>
      )}
    </div>
  );

  const back = (
    <button type="button" onClick={() => nav('/devices?type=controller')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 13, marginBottom: wide ? 12 : 10 }}>
      <Icon name="chevron-left" size={16} /> Devices
    </button>
  );

  if (wide) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}>
        {back}
        {body}
      </div>
    );
  }
  return (
    <>
      <MobileHeader eyebrow="Devices" title="Scene switch" right={<Avatar />} />
      <div style={{ padding: '8px 14px 22px' }}>
        {back}
        {body}
      </div>
    </>
  );
}
