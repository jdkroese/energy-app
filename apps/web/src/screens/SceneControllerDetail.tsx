import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type {
  ConfiguredResponse, HomeScenesResponse, SceneControllersResponse, ScenesResponse,
} from '../lib/types';
import { Card, Icon, Button, Switch, Select } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { resolveTypeMeta } from '../lib/deviceTypes';

/* ============================================================================
 * SceneControllerDetail (/devices/controller/:id) — bind a wireless scene
 * switch's 4 buttons to a scene (Phase 1: single-click toggle). A button can target
 * a Light scene (from the Lights feature) OR a whole-home scene. Mirrors
 * GenericDeviceDetail's routing/layout: header (name/online) + an Enabled toggle +
 * 4 button rows, each a Scene picker (grouped: Light scenes / Home scenes + "None").
 * Saving PUTs /api/scene-controllers/:deviceId. Responsive desktop (≥768) / mobile (<768).
 * The coordinator does the live press-handling; this screen only edits bindings.
 * ==========================================================================*/

// Picks are encoded as `<kind>:<sceneId>` so the target store survives round-trips.
// "None" is the empty string.
const NONE = '';
type Kind = 'light' | 'home';
const encodePick = (kind: Kind, sceneId: string): string => `${kind}:${sceneId}`;
function decodePick(v: string): { kind: Kind; sceneId: string } | null {
  if (!v) return null;
  const i = v.indexOf(':');
  if (i < 0) return null;
  const kind = v.slice(0, i);
  const sceneId = v.slice(i + 1);
  if ((kind !== 'light' && kind !== 'home') || !sceneId) return null;
  return { kind, sceneId };
}

type Gesture = 'single' | 'double' | 'long';
const EXTRA_GESTURES: Gesture[] = ['double', 'long'];
const GESTURE_LABEL: Record<Gesture, string> = {
  single: 'Single-click',
  double: 'Double-click',
  long: 'Long-press',
};
/** A binding → its encoded pick (`<kind>:<sceneId>`), or NONE. Legacy (no kind) = home. */
const pressPick = (p?: { kind?: Kind; sceneId?: string } | null): string =>
  p?.sceneId ? encodePick(p.kind ?? 'home', p.sceneId) : NONE;

export function SceneControllerDetail({ ctx }: { ctx: ShellContext }) {
  const { id = '' } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;

  const { data: ctrlData, stale, updatedAt, refetch } = usePolling<SceneControllersResponse>(api.sceneControllers.list, 15_000);
  const { data: homeScenesData } = usePolling<HomeScenesResponse>(api.homeScenes.list, 0);
  const { data: lightScenesData } = usePolling<ScenesResponse>(api.lights.scenes, 0);
  // The configured-device record gives us the display name/category even before the
  // (fleet-joined) controller view resolves — so the header is never blank.
  const { data: configuredData } = usePolling<ConfiguredResponse>(api.devices.configured, 0);

  const controller = ctrlData?.controllers.find((c) => c.deviceId === id) ?? null;
  const configured = configuredData?.devices.find((d) => d.id === id) ?? null;
  const customTypes = configuredData?.customDeviceTypes ?? [];
  const meta = resolveTypeMeta(configured?.typeId ?? 'controller', customTypes);
  const homeScenes = homeScenesData?.scenes ?? [];
  const lightScenes = lightScenesData?.scenes ?? [];
  const noScenes = homeScenes.length === 0 && lightScenes.length === 0;

  // Local edit buffer: enabled + per-index, per-gesture pick (loaded from the server view).
  const [enabled, setEnabled] = useState(true);
  const [picks, setPicks] = useState<Record<number, Record<Gesture, string>>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Hydrate the buffer from the server view ONCE it loads (and whenever the device id
  // changes), but never stomp in-progress edits.
  useEffect(() => {
    if (!controller || dirty) return;
    setEnabled(controller.enabled);
    const next: Record<number, Record<Gesture, string>> = {};
    const openByDefault: Record<number, boolean> = {};
    for (const b of controller.buttons) {
      next[b.index] = { single: pressPick(b.single), double: pressPick(b.double), long: pressPick(b.long) };
      // Reveal the extra gestures up-front for a button that already uses them.
      if (pressPick(b.double) !== NONE || pressPick(b.long) !== NONE) openByDefault[b.index] = true;
    }
    setPicks(next);
    setExpanded((e) => ({ ...openByDefault, ...e }));
  }, [controller, dirty]);

  // Flat "None" option + a Light scenes group (first — what the owner wants) + a Home
  // scenes group. Each option value encodes its kind so the target store survives a save.
  const sceneGroups = useMemo(
    () => [
      ...(lightScenes.length
        ? [{ group: 'Light scenes', options: lightScenes.map((s) => ({ value: encodePick('light', s.id), label: s.name })) }]
        : []),
      ...(homeScenes.length
        ? [{ group: 'Home scenes', options: homeScenes.map((s) => ({ value: encodePick('home', s.id), label: s.name })) }]
        : []),
    ],
    [lightScenes, homeScenes],
  );

  const setEnabledDirty = (v: boolean) => { setEnabled(v); setDirty(true); };
  const pickOf = (index: number, g: Gesture): string => picks[index]?.[g] ?? NONE;
  const setPick = (index: number, g: Gesture, value: string) => {
    setPicks((p) => {
      const cur = p[index] ?? { single: NONE, double: NONE, long: NONE };
      return { ...p, [index]: { ...cur, [g]: value } };
    });
    setDirty(true);
  };
  const toggleExpanded = (index: number) => setExpanded((e) => ({ ...e, [index]: !e[index] }));

  const save = async () => {
    setSaving(true);
    try {
      const buttons = [1, 2, 3, 4].map((index) => {
        const label = controller?.buttons.find((b) => b.index === index)?.label;
        const s = decodePick(pickOf(index, 'single'));
        const d = decodePick(pickOf(index, 'double'));
        const l = decodePick(pickOf(index, 'long'));
        return {
          index,
          ...(label ? { label } : {}),
          ...(s ? { single: { kind: s.kind, sceneId: s.sceneId } } : {}),
          ...(d ? { double: { kind: d.kind, sceneId: d.sceneId } } : {}),
          ...(l ? { long: { kind: l.kind, sceneId: l.sceneId } } : {}),
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

  const scenePicker = (index: number, g: Gesture) => (
    <Select
      value={pickOf(index, g)}
      options={[{ value: NONE, label: 'None' }]}
      groups={sceneGroups}
      disabled={!isAdmin}
      onChange={(e) => setPick(index, g, e.target.value)}
    />
  );

  const buttonRow = (index: number) => {
    const isOpen = expanded[index] ?? false;
    const extra = EXTRA_GESTURES.filter((g) => pickOf(index, g) !== NONE).length;
    return (
      <div key={index} style={{ padding: wide ? '12px 4px' : '12px 0' }}>
        {/* Primary row: Button N badge + single-click picker */}
        <div
          style={{
            display: 'flex', flexDirection: wide ? 'row' : 'column', alignItems: wide ? 'center' : 'stretch',
            gap: wide ? 14 : 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: wide ? 150 : undefined }}>
            <span style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: meta.hue, flex: 'none', fontWeight: 700, fontSize: 13 }} className="pwr-mono">{index}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-1)' }}>Button {index}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                single-click{extra > 0 ? ` · +${extra} gesture${extra > 1 ? 's' : ''}` : ''}
              </div>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>{scenePicker(index, 'single')}</div>
        </div>

        {/* More gestures: double-click + long-press, collapsed by default */}
        <div style={{ marginTop: 8, paddingLeft: wide ? 160 : 0 }}>
          <button
            type="button"
            onClick={() => toggleExpanded(index)}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0 }}
          >
            <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} />
            {isOpen ? 'Fewer gestures' : 'More gestures'}{!isOpen && extra > 0 ? ` (${extra} set)` : ''}
          </button>
          {isOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {EXTRA_GESTURES.map((g) => (
                <div
                  key={g}
                  style={{ display: 'flex', flexDirection: wide ? 'row' : 'column', alignItems: wide ? 'center' : 'stretch', gap: wide ? 14 : 6 }}
                >
                  <div style={{ fontSize: 12, color: 'var(--text-2)', minWidth: wide ? 136 : undefined }}>{GESTURE_LABEL[g]}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>{scenePicker(index, g)}</div>
                </div>
              ))}
            </div>
          )}
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
              Each gesture toggles its scene — press once to apply, press again to turn it off. Add
              double-click and long-press under “More gestures”.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {[1, 2, 3, 4].map((index, i) => (
                <div key={index} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                  {buttonRow(index)}
                </div>
              ))}
            </div>
            {noScenes && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="info" size={13} color="var(--text-3)" />
                No scenes yet — create one in Settings → Scenes, or a Lights scene in Lights, then bind it here.
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
