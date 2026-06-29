import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type {
  HomeScene,
  HomeSceneClimateMember,
  HomeSceneBlindMember,
  HomeScenesResponse,
  LightSceneMember,
  LightsResponse,
  BlindsResponse,
  DevicesResponse,
  DeviceView,
} from '../../lib/types';
import { Modal, Button, Icon, Switch, Slider, Input, EmptyState } from '../ui';
import { classifyDevice } from '../../lib/deviceTypes';

/* ============================================================================
 * HomeSceneBuilder — admin modal to create / edit / delete whole-home scenes
 * (lights + climate + blinds in one tap). Compact + functional, not pretty: a
 * left list of saved scenes and a right editor form. Persists through
 * api.homeScenes.create/update/remove. Surfaced from the tablet Home "Manage"
 * affordance AND the desktop/phone Settings → System tab, so an admin can set
 * up the kitchen-tablet's scene buttons from their normal session too.
 * ==========================================================================*/

/** The small lucide icon set offered for a scene (label → icon name). */
const SCENE_ICONS: { name: string; icon: string }[] = [
  { name: 'Sunrise', icon: 'sunrise' },
  { name: 'Cooking', icon: 'utensils' },
  { name: 'Film', icon: 'film' },
  { name: 'Leaving', icon: 'door-open' },
  { name: 'Night', icon: 'moon' },
  { name: 'Sparkle', icon: 'sparkles' },
];

const sortByName = <T extends { name: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

/** A blank scene template used when adding a new one. */
function emptyScene(): HomeScene {
  return { id: '', name: '', icon: 'sparkles', lights: [], climate: [], blinds: [] };
}

export function HomeSceneBuilder({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved?: () => void }) {
  const { data: scenesData, refetch: refetchScenes } = usePolling<HomeScenesResponse>(api.homeScenes.list, 0, [open]);
  const { data: lightsData } = usePolling<LightsResponse>(api.lights.list, 0, [open]);
  const { data: blindsData } = usePolling<BlindsResponse>(api.blinds.list, 0, [open]);
  const { data: devicesData } = usePolling<DevicesResponse>(api.devices.list, 0, [open]);

  const scenes = useMemo(() => sortByName(scenesData?.scenes ?? []), [scenesData]);
  const lights = useMemo(() => sortByName(lightsData?.devices ?? []), [lightsData]);
  const blinds = useMemo(() => sortByName(blindsData?.devices ?? []), [blindsData]);
  const climate = useMemo(
    () => sortByName((devicesData?.devices ?? []).filter((x) => classifyDevice(x) === 'cooling' || classifyDevice(x) === 'heating')),
    [devicesData],
  );

  // The scene currently being edited (a working copy). null = pick / list view.
  const [draft, setDraft] = useState<HomeScene | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset the editor whenever the modal is (re)opened.
  useEffect(() => {
    if (!open) { setDraft(null); setErr(null); }
  }, [open]);

  const startNew = () => { setDraft(emptyScene()); setErr(null); };
  const startEdit = (s: HomeScene) => { setDraft(JSON.parse(JSON.stringify(s)) as HomeScene); setErr(null); };

  const save = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { setErr('Give the scene a name.'); return; }
    setBusy(true);
    setErr(null);
    try {
      const body: Partial<HomeScene> = {
        name,
        icon: draft.icon,
        special: draft.special,
        lights: draft.lights,
        climate: draft.climate,
        blinds: draft.blinds,
      };
      if (draft.id) await api.homeScenes.update(draft.id, body);
      else await api.homeScenes.create(body);
      refetchScenes();
      onSaved?.();
      setDraft(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the scene.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: HomeScene) => {
    if (!s.id) return;
    if (!window.confirm(`Delete the "${s.name}" scene?`)) return;
    setBusy(true);
    try {
      await api.homeScenes.remove(s.id);
      refetchScenes();
      onSaved?.();
      if (draft?.id === s.id) setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  const toggleFavorite = async (s: HomeScene) => {
    if (!s.id) return;
    try {
      await api.homeScenes.favorite(s.id, !s.favorite);
      refetchScenes();
      onSaved?.();
    } catch {
      /* best-effort — a failed star toggle is harmless, the next poll re-syncs */
    }
  };

  const title = draft ? (draft.id ? 'Edit scene' : 'New scene') : 'Scenes';

  return (
    <Modal open={open} onClose={onClose} title={title} icon="sparkles" tone="solar" size="lg">
      {draft ? (
        <SceneEditor
          draft={draft}
          lights={lights}
          climate={climate}
          blinds={blinds}
          err={err}
          onChange={setDraft}
        />
      ) : (
        <SceneList scenes={scenes} onAdd={startNew} onEdit={startEdit} onRemove={remove} onFavorite={toggleFavorite} busy={busy} />
      )}
      {/* Footer actions — vary by mode */}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 18px', borderTop: '1px solid var(--border-1)' }}>
        {draft ? (
          <>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>Back</Button>
            <Button variant="primary" onClick={() => void save()} loading={busy} iconLeft={<Icon name="check" size={15} />}>Save scene</Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>Done</Button>
        )}
      </div>
    </Modal>
  );
}

/* ---- Scene list (pick / add / delete) ------------------------------------- */

function SceneList({ scenes, onAdd, onEdit, onRemove, onFavorite, busy }: {
  scenes: HomeScene[]; onAdd: () => void; onEdit: (s: HomeScene) => void; onRemove: (s: HomeScene) => void; onFavorite: (s: HomeScene) => void; busy: boolean;
}) {
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Button variant="primary" block onClick={onAdd} iconLeft={<Icon name="plus" size={16} />}>New scene</Button>
      {scenes.length === 0 ? (
        <EmptyState icon="sparkles" title="No scenes yet" subtitle="Create one to drive lights, climate and blinds from a single tap." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {scenes.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--solar-wash)', color: 'var(--solar)' }}>
                <Icon name={s.icon || 'sparkles'} size={17} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                  {s.special === 'all-off' ? 'All-off scene' : `${s.lights.length} lights · ${s.climate.length} climate · ${s.blinds.length} blinds`}
                </div>
              </div>
              <button
                type="button"
                aria-label={s.favorite ? `Unstar ${s.name}` : `Star ${s.name}`}
                aria-pressed={!!s.favorite}
                onClick={() => onFavorite(s)}
                disabled={busy}
                title={s.favorite ? 'Favorite — shows first on the tablet' : 'Mark as favorite'}
                style={iconBtn}
              >
                <Icon name="star" size={16} color={s.favorite ? 'var(--solar)' : 'var(--text-3)'} fill={s.favorite ? 'var(--solar)' : 'none'} />
              </button>
              <button type="button" aria-label={`Edit ${s.name}`} onClick={() => onEdit(s)} disabled={busy} style={iconBtn}><Icon name="pencil" size={15} color="var(--text-2)" /></button>
              <button type="button" aria-label={`Delete ${s.name}`} onClick={() => onRemove(s)} disabled={busy} style={iconBtn}><Icon name="trash-2" size={15} color="var(--danger)" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const iconBtn = { background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, flex: 'none', borderRadius: 8 } as const;

/* ---- Scene editor --------------------------------------------------------- */

type LightTri = 'off' | 'on' | 'dim';

function SceneEditor({ draft, lights, climate, blinds, err, onChange }: {
  draft: HomeScene;
  lights: LightsResponse['devices'];
  climate: DeviceView[];
  blinds: BlindsResponse['devices'];
  err: string | null;
  onChange: (s: HomeScene) => void;
}) {
  const patch = (p: Partial<HomeScene>) => onChange({ ...draft, ...p });

  // ---- lights ----
  const lightMember = (id: string): LightSceneMember | undefined => draft.lights.find((m) => m.lightId === id);
  const lightState = (id: string): LightTri => {
    const m = lightMember(id);
    if (!m || !m.on) return m && !m.on ? 'off' : 'off';
    return m.brightnessPct != null ? 'dim' : 'on';
  };
  const setLight = (id: string, tri: LightTri, brightnessPct?: number) => {
    const others = draft.lights.filter((m) => m.lightId !== id);
    if (tri === 'off') { patch({ lights: [...others, { lightId: id, on: false }] }); return; }
    if (tri === 'dim') { patch({ lights: [...others, { lightId: id, on: true, brightnessPct: brightnessPct ?? lightMember(id)?.brightnessPct ?? 60 }] }); return; }
    patch({ lights: [...others, { lightId: id, on: true }] });
  };
  const clearLight = (id: string) => patch({ lights: draft.lights.filter((m) => m.lightId !== id) });

  // ---- climate ----
  const climateMember = (id: string): HomeSceneClimateMember | undefined => draft.climate.find((m) => m.deviceId === id);
  const setClimate = (id: string, p: Partial<HomeSceneClimateMember> | null) => {
    const others = draft.climate.filter((m) => m.deviceId !== id);
    if (p === null) { patch({ climate: others }); return; }
    const base = climateMember(id) ?? { deviceId: id, power: true };
    patch({ climate: [...others, { ...base, ...p }] });
  };

  // ---- blinds ----
  const blindMember = (id: string): HomeSceneBlindMember | undefined => draft.blinds.find((m) => m.blindId === id);
  const setBlind = (id: string, m: HomeSceneBlindMember | null) => {
    const others = draft.blinds.filter((b) => b.blindId !== id);
    if (m === null) { patch({ blinds: others }); return; }
    patch({ blinds: [...others, m] });
  };

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}

      {/* Name + icon + all-off */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Input label="Name" value={draft.name} placeholder="e.g. Good night" onChange={(e) => patch({ name: e.target.value })} />
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Icon</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {SCENE_ICONS.map((s) => {
              const on = draft.icon === s.icon;
              return (
                <button key={s.icon} type="button" aria-label={s.name} aria-pressed={on} onClick={() => patch({ icon: s.icon })}
                  style={{ width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', cursor: 'pointer',
                    border: `1px solid ${on ? 'var(--solar)' : 'var(--border-2)'}`, background: on ? 'var(--solar-wash)' : 'var(--surface-2)', color: on ? 'var(--solar)' : 'var(--text-2)' }}>
                  <Icon name={s.icon} size={20} />
                </button>
              );
            })}
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '9px 12px', cursor: 'pointer' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13 }}>Everything-off scene</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Turns all lights, climate and blinds off — overrides the picks below</div>
          </div>
          <Switch checked={draft.special === 'all-off'} onChange={(e) => patch({ special: e.target.checked ? 'all-off' : undefined })} />
        </label>
      </div>

      {draft.special !== 'all-off' && (
        <>
          {/* Lights */}
          <Section title="Lights" icon="lightbulb">
            {lights.length === 0 ? <Hint>No lights.</Hint> : lights.map((l) => {
              const inScene = !!lightMember(l.id);
              const tri = lightState(l.id);
              const m = lightMember(l.id);
              return (
                <Row key={l.id} name={l.name} inScene={inScene} onToggleInScene={(v) => (v ? setLight(l.id, 'on') : clearLight(l.id))}>
                  {inScene && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                      <Tri value={tri} options={[['off', 'Off'], ...(l.dimmable ? [['on', 'On'], ['dim', 'On + dim']] : [['on', 'On']]) as [LightTri, string][]]} onChange={(v) => setLight(l.id, v)} />
                      {tri === 'dim' && (
                        <Slider label="Brightness" min={1} max={100} unit="%" value={m?.brightnessPct ?? 60} onChange={(v) => setLight(l.id, 'dim', v)} />
                      )}
                    </div>
                  )}
                </Row>
              );
            })}
          </Section>

          {/* Climate */}
          <Section title="Climate" icon="thermometer">
            {climate.length === 0 ? <Hint>No climate units.</Hint> : climate.map((c) => {
              const m = climateMember(c.id);
              const inScene = !!m;
              const lo = c.minSetpointC ?? 16;
              const hi = c.maxSetpointC ?? 30;
              return (
                <Row key={c.id} name={c.roomName || c.room || c.name} inScene={inScene} onToggleInScene={(v) => setClimate(c.id, v ? { power: true } : null)}>
                  {inScene && m && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                      <Tri value={m.power ? 'on' : 'off'} options={[['off', 'Off'], ['on', 'On']]} onChange={(v) => setClimate(c.id, { power: v === 'on' })} />
                      {m.power && (
                        <>
                          <Tri
                            value={m.mode ?? 'keep'}
                            options={[['keep', 'Keep mode'], ['heat', 'Heat'], ['cool', 'Cool'], ['auto', 'Auto']]}
                            onChange={(v) => setClimate(c.id, { mode: v === 'keep' ? undefined : v })}
                          />
                          <Slider
                            label="Setpoint"
                            min={lo}
                            max={hi}
                            step={0.5}
                            value={m.setpointC ?? c.setpointC ?? lo}
                            formatValue={(v) => `${v.toFixed(1)}°`}
                            onChange={(v) => setClimate(c.id, { setpointC: v })}
                          />
                        </>
                      )}
                    </div>
                  )}
                </Row>
              );
            })}
          </Section>

          {/* Blinds */}
          <Section title="Blinds" icon="blinds">
            {blinds.length === 0 ? <Hint>No blinds.</Hint> : blinds.map((b) => {
              const m = blindMember(b.id);
              const inScene = !!m;
              const action = m?.action ?? 'open';
              return (
                <Row key={b.id} name={b.name} inScene={inScene} onToggleInScene={(v) => setBlind(b.id, v ? { blindId: b.id, action: 'open' } : null)}>
                  {inScene && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                      <Tri
                        value={action}
                        options={[['open', 'Open'], ['close', 'Close'], ...(b.supportsPosition ? [['position', 'Position']] as [HomeSceneBlindMember['action'], string][] : [])]}
                        onChange={(v) => setBlind(b.id, { blindId: b.id, action: v, positionPct: v === 'position' ? (m?.positionPct ?? 50) : undefined })}
                      />
                      {action === 'position' && b.supportsPosition && (
                        <Slider label="Open" min={0} max={100} unit="%" value={m?.positionPct ?? 50} onChange={(v) => setBlind(b.id, { blindId: b.id, action: 'position', positionPct: v })} />
                      )}
                    </div>
                  )}
                </Row>
              );
            })}
          </Section>
        </>
      )}
    </div>
  );
}

/* ---- editor primitives ---------------------------------------------------- */

function Section({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        <Icon name={icon} size={14} /> {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '4px 2px' }}>{children}</div>;
}

/** A member row: name + an "include" switch; when included its controls show. */
function Row({ name, inScene, onToggleInScene, children }: {
  name: string; inScene: boolean; onToggleInScene: (v: boolean) => void; children?: React.ReactNode;
}) {
  return (
    <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <Switch checked={inScene} onChange={(e) => onToggleInScene(e.target.checked)} />
      </div>
      {children}
    </div>
  );
}

/** A small inline segmented chooser used for tri-state member options. */
function Tri<T extends string>({ value, options, onChange }: {
  value: T; options: [T, string][]; onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: 3, flexWrap: 'wrap' }}>
      {options.map(([v, label]) => {
        const on = v === value;
        return (
          <button key={v} type="button" aria-pressed={on} onClick={() => onChange(v)}
            style={{ flex: 1, minWidth: 64, padding: '6px 8px', borderRadius: 'var(--radius-sm, 6px)', border: 'none', cursor: 'pointer',
              background: on ? 'var(--surface-3)' : 'transparent', color: on ? 'var(--text-1)' : 'var(--text-2)', fontSize: 12, fontWeight: 600 }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}
