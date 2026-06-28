import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { Capability, DiscoveredDevice, DiscoveredResponse } from '../lib/types';
import { Card, Icon, Button, Badge } from '../components/ui';

/* ============================================================================
 * Discovered devices — the onboarding INBOX (Devices → Needs setup). Phase 1 is
 * VISIBILITY + TRIAGE only: it lists every paired Tuya device that no shipped
 * category screen renders, grouped by inference confidence, with an Ignore (and,
 * for ignored rows, a Keep) action. No write/control affordance ships here — the
 * generic control renderer + setup sheet are a later phase, so we avoid dead ends.
 *
 * Built on the "Power" design system + the existing Devices/Lights visual language:
 * icon tile · name · mono "provider · category · product" subline · capability chips
 * · a confidence pill · Ignore. Responsive: a real grid on desktop, stacked on mobile.
 * ==========================================================================*/

/* ---- DEV-ONLY fixture -------------------------------------------------------
 * So the inbox can be visually verified when no live Tuya project is connected in
 * dev. STRICTLY gated: only in a dev build AND only when ?discoverDemo=1 is in the
 * URL. It never runs in production and never injects fake data into the real path. */
function devFixture(): DiscoveredResponse | null {
  // `import.meta.env` isn't typed in this project's tsconfig (types: []); read DEV
  // through a safe cast. Vite statically replaces import.meta.env.DEV at build time,
  // so this whole block is dead-code-eliminated from the production bundle.
  const isDev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
  if (!isDev) return null;
  if (typeof window === 'undefined') return null;
  if (!new URLSearchParams(window.location.search).has('discoverDemo')) return null;
  const cap = (kind: Capability['kind'], dp: string, label: string, extra: Partial<Capability> = {}): Capability => ({
    kind, key: dp, dp, label, readOnly: kind === 'measure' || kind === 'status', ...extra,
  });
  return {
    ts: new Date().toISOString(),
    connected: true,
    fleetError: null,
    devices: [
      {
        id: 'demo-plug-1', name: 'Kitchen coffee plug', category: 'cz', productName: 'Smart Socket 16A',
        online: true, proposedType: { label: 'Plug', icon: 'plug' },
        capabilities: [cap('switch', 'switch_1', 'Switch 1'), cap('measure', 'cur_power', 'Power', { unit: 'W', readOnly: true })],
        confidence: 'high', roomGuess: 'kitchen', readout: null,
      },
      {
        id: 'demo-fan-1', name: 'Office fan', category: 'fs', productName: 'Tower Fan',
        online: true, proposedType: { label: 'Fan', icon: 'fan' },
        capabilities: [cap('switch', 'switch', 'Switch'), cap('range', 'fan_speed', 'Fan speed', { min: 1, max: 5 }), cap('enum', 'mode', 'Mode', { options: ['normal', 'nature', 'sleep'] })],
        confidence: 'high', roomGuess: 'office', readout: null,
      },
      {
        id: 'demo-sensor-1', name: 'Bedroom temp/humidity sensor', category: 'wsdcg', productName: 'TH Sensor',
        online: true, proposedType: { label: 'Sensor', icon: 'thermometer' },
        capabilities: [cap('measure', 'va_temperature', 'Temperature', { unit: '°C', readOnly: true }), cap('measure', 'va_humidity', 'Humidity', { unit: '%', readOnly: true }), cap('measure', 'battery_percentage', 'Battery', { unit: '%', readOnly: true })],
        confidence: 'monitor', roomGuess: 'bedroom', readout: '21.4 °C · 48 % · 92 %',
      },
      {
        id: 'demo-mystery-1', name: 'Garage thing', category: 'xyz', productName: 'Unknown WiFi module',
        online: false, proposedType: { label: 'Unknown', icon: 'circle-help' },
        capabilities: [cap('switch', 'switch', 'Switch')],
        confidence: 'review', roomGuess: 'garage', readout: null,
      },
    ],
    ignored: [
      {
        id: 'demo-ignored-1', name: 'Old hallway repeater', category: 'wf', productName: 'WiFi Repeater',
        online: false, proposedType: { label: 'Unknown', icon: 'circle-help' },
        capabilities: [], confidence: 'review', roomGuess: 'hall', readout: null,
      },
    ],
  };
}

/* ---- helpers --------------------------------------------------------------*/

const CONFIDENCE_META: Record<DiscoveredDevice['confidence'], { label: string; tone: 'solar' | 'grid' | 'neutral' }> = {
  high: { label: 'Recognized', tone: 'solar' },
  monitor: { label: 'Read-only', tone: 'neutral' },
  review: { label: 'Needs a look', tone: 'grid' },
};

/** The review pill reads "Light or plug?" only when the device is genuinely
 *  switch-only (the classic on/off ambiguity); anything else gets the generic
 *  "Needs a look" so a lock/valve/unknown isn't mislabelled as a light-or-plug. */
function reviewLabel(d: DiscoveredDevice): string {
  const controllable = d.capabilities.filter((c) => !c.readOnly);
  const switchOnly = controllable.length > 0 && controllable.every((c) => c.kind === 'switch');
  return switchOnly ? 'Light or plug?' : CONFIDENCE_META.review.label;
}

const KIND_LABEL: Record<Capability['kind'], string> = {
  switch: 'on/off', range: 'level', enum: 'mode', action: 'action', color: 'colour', measure: 'reads', status: 'state',
};

/** Compact capability chip. Read-only chips are dimmer to signal "monitor only". */
function CapChip({ cap }: { cap: Capability }) {
  return (
    <span
      title={`${cap.label} · ${cap.dp}${cap.readOnly ? ' (read-only)' : ''}`}
      style={{
        fontSize: 10.5, lineHeight: 1.4, padding: '2px 7px', borderRadius: 'var(--radius-pill)',
        background: cap.readOnly ? 'var(--surface-1)' : 'var(--surface-3)',
        border: '1px solid var(--border-1)',
        color: cap.readOnly ? 'var(--text-3)' : 'var(--text-2)', whiteSpace: 'nowrap',
      }}
    >
      {cap.label}
      <span style={{ color: 'var(--text-disabled)' }}> · {KIND_LABEL[cap.kind]}</span>
    </span>
  );
}

/** A single discovered-device row. `action` is the right-aligned control (Ignore/Keep). */
function DeviceRow({ d, wide, action }: { d: DiscoveredDevice; wide: boolean; action: React.ReactNode }) {
  const subline = [d.category || '?', d.productName].filter(Boolean).join(' · ');
  const conf = CONFIDENCE_META[d.confidence];
  const confLabel = d.confidence === 'review' ? reviewLabel(d) : conf.label;
  return (
    <div
      style={{
        display: 'flex', alignItems: wide ? 'center' : 'flex-start', gap: 11, padding: '11px 12px',
        flexDirection: wide ? 'row' : 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0, flex: 1, width: '100%' }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--text-2)', flex: 'none', position: 'relative' }}>
          <Icon name={d.proposedType.icon} size={17} />
          {!d.online && <span title="Offline" style={{ position: 'absolute', right: -2, bottom: -2, width: 9, height: 9, borderRadius: '50%', background: 'var(--text-3)', border: '2px solid var(--surface-1)' }} />}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-3)', flex: 'none' }}>{d.proposedType.label}</span>
            {d.roomGuess && <span style={{ fontSize: 10, color: 'var(--text-3)', flex: 'none', textTransform: 'capitalize' }}>· {d.roomGuess}</span>}
          </div>
          <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Tuya · {subline}
          </div>
          {/* readout (monitor rows) + capability chips */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {d.readout && (
              <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--battery)', background: 'var(--battery-wash)', borderRadius: 'var(--radius-pill)', padding: '2px 8px' }}>{d.readout}</span>
            )}
            {d.capabilities.slice(0, 6).map((c) => <CapChip key={c.key} cap={c} />)}
            {d.capabilities.length === 0 && <span style={{ fontSize: 10.5, color: 'var(--text-disabled)' }}>no capabilities reported</span>}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 'none', alignSelf: wide ? 'center' : 'flex-end', paddingTop: wide ? 0 : 2 }}>
        <Badge tone={conf.tone} variant="soft">{confLabel}</Badge>
        {action}
      </div>
    </div>
  );
}

/** A titled section of rows. Renders nothing when empty. */
function Section({ title, hint, devices, wide, renderAction }: {
  title: string; hint: string; devices: DiscoveredDevice[]; wide: boolean;
  renderAction: (d: DiscoveredDevice) => React.ReactNode;
}) {
  if (devices.length === 0) return null;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 2px 8px' }}>
        <span className="pwr-eyebrow">{title}</span>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{hint}</span>
        <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-disabled)', marginLeft: 'auto' }}>{devices.length}</span>
      </div>
      <Card padded style={{ padding: '4px 4px' }}>
        {devices.map((d, i) => (
          <div key={d.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
            <DeviceRow d={d} wide={wide} action={renderAction(d)} />
          </div>
        ))}
      </Card>
    </div>
  );
}

export interface DiscoveredInboxProps {
  wide: boolean;
  canTriage: boolean;
  /** Lift the active count up so the parent hub can badge the tab / show the banner. */
  onCount?: (n: number) => void;
}

export function DiscoveredInbox({ wide, canTriage }: DiscoveredInboxProps) {
  const fixture = useMemo(() => devFixture(), []);
  const live = usePolling<DiscoveredResponse>(api.devices.discovered, fixture ? 0 : 30_000);
  const data = fixture ?? live.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  // Local optimistic override so an Ignore/Keep reflects instantly (fixture too).
  const [override, setOverride] = useState<Record<string, 'ignored' | 'kept'>>({});

  const ignore = (id: string) => {
    setOverride((o) => ({ ...o, [id]: 'ignored' }));
    if (fixture) return;
    setBusy(id);
    void api.devices.ignore(id).then(() => live.refetch()).finally(() => setBusy(null));
  };
  const keep = (id: string) => {
    setOverride((o) => ({ ...o, [id]: 'kept' }));
    if (fixture) return;
    setBusy(id);
    void api.devices.keep(id).then(() => live.refetch()).finally(() => setBusy(null));
  };

  if (!data) {
    return <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading discovered devices…</Card>;
  }
  if (!data.connected) {
    return (
      <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)', flex: 'none' }}><Icon name="cloud-off" size={16} /></span>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>Tuya is not connected. Add your Cloud project in <strong style={{ color: 'var(--text-1)' }}>Settings → Tuya</strong> to discover paired devices.</div>
      </Card>
    );
  }

  // Apply local overrides on top of the server lists.
  const active = data.devices.filter((d) => override[d.id] !== 'ignored');
  const newlyKept = data.ignored.filter((d) => override[d.id] === 'kept');
  const activeAll = [...active, ...newlyKept];
  const ignored = [...data.ignored.filter((d) => override[d.id] !== 'kept'), ...data.devices.filter((d) => override[d.id] === 'ignored')];

  const review = activeAll.filter((d) => d.confidence === 'review');
  const monitor = activeAll.filter((d) => d.confidence === 'monitor');
  const recognized = activeAll.filter((d) => d.confidence === 'high');

  const ignoreBtn = (d: DiscoveredDevice) => (
    <Button size="sm" variant="ghost" disabled={!canTriage || busy === d.id} onClick={() => ignore(d.id)} iconLeft={<Icon name="eye-off" size={13} />}>Ignore</Button>
  );
  const keepBtn = (d: DiscoveredDevice) => (
    <Button size="sm" variant="secondary" disabled={!canTriage || busy === d.id} onClick={() => keep(d.id)} iconLeft={<Icon name="rotate-ccw" size={13} />}>Keep</Button>
  );

  if (activeAll.length === 0 && ignored.length === 0) {
    return (
      <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--solar)' }}><Icon name="check" size={19} /></span>
        Every paired device is already set up. Nothing to triage.
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Discovery banner */}
      {activeAll.length > 0 && (
        <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11, background: 'var(--solar-wash)', border: '1px solid rgba(46,230,160,0.25)' }}>
          <span style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--surface-1)', color: 'var(--solar)', flex: 'none' }}><Icon name="sparkles" size={17} /></span>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--text-1)' }}>{activeAll.length} device{activeAll.length === 1 ? '' : 's'} found</strong> that aren't set up yet. Review them below — these are listed for visibility and aren't controlled or grouped yet.
          </div>
        </Card>
      )}

      {data.fleetError && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>Could not read the fleet: {data.fleetError}</div>}

      <Section title="Needs your input" hint="ambiguous — confirm what they are" devices={review} wide={wide} renderAction={ignoreBtn} />
      <Section title="Suggested monitors" hint="read-only sensors" devices={monitor} wide={wide} renderAction={ignoreBtn} />
      <Section title="Recently discovered" hint="recognized — not added to groups yet" devices={recognized} wide={wide} renderAction={ignoreBtn} />

      {/* Ignored (collapsible) */}
      {ignored.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowIgnored((s) => !s)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 2px', color: 'var(--text-3)' }}
          >
            <Icon name={showIgnored ? 'chevron-down' : 'chevron-right'} size={15} />
            <span className="pwr-eyebrow">Ignored</span>
            <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-disabled)' }}>{ignored.length}</span>
          </button>
          {showIgnored && (
            <Card padded style={{ padding: '4px 4px', opacity: 0.85 }}>
              {ignored.map((d, i) => (
                <div key={d.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                  <DeviceRow d={d} wide={wide} action={keepBtn(d)} />
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      {!canTriage && <div style={{ fontSize: 11.5, color: 'var(--text-3)', textAlign: 'center' }}>Read-only — only an admin can ignore or keep devices.</div>}
    </div>
  );
}

/** Active (non-ignored) discovered count, used to badge the hub tab + Settings. */
export function useDiscoveredCount(): number {
  const fixture = useMemo(() => devFixture(), []);
  const { data } = usePolling<DiscoveredResponse>(api.devices.discovered, fixture ? 0 : 30_000);
  const eff = fixture ?? data;
  return eff?.devices.length ?? 0;
}
