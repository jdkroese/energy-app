import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type {
  LiveResponse,
  SettingsResponse,
  DevicesResponse,
  LightsResponse,
  BlindsResponse,
  SpeakersResponse,
  IrrigationResponse,
  BatteriesResponse,
  ConfiguredResponse,
  AlertsResponse,
  ControlStatus,
} from '../lib/types';
import {
  subsystemRollup,
  climateHealth,
  lightHealth,
  blindHealth,
  speakerHealth,
  irrigationHealth,
  batteryHealth,
  circuitHealth,
  worstState,
  type RollupInput,
  type HealthState,
} from '../lib/health';
import { Card, StatusDot, Eyebrow, Icon, EmptyState } from '../components/ui';
import {
  SystemHealthBanner,
  ConnectivityGrid,
  LiveLoadStrip,
  LiveDrawBreakdown,
  SubsystemHealthRow,
  GridQualityCard,
  type ConnectorTile,
  type ConnTone,
  type DeviceChip,
} from '../components/status';
import { Autopilot } from './Autopilot';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * System Status board — Phase 1 (docs/36). Compose-only, front-end-only: no
 * /api/system/status aggregator (that's Phase 2), just parallel polls of the
 * existing endpoints stitched into a whole-home health · load · use view.
 *
 * Order (docs/36 §4): 1 health banner · 2 connectivity · 3 live load + draw +
 * today totals · 4 subsystem health rows · 5 battery control (embedded Autopilot
 * status, verbatim) · 6 grid quality · 7 alerts + rejected commands.
 * ==========================================================================*/

const POLL_MS = 12_000;
const panelGap = 12;

/** Sort by resolved room name then device name (rooms-alphabetical standing rule). */
function byRoomThenName<T extends { roomName?: string | null; room?: string; name: string }>(a: T, b: T): number {
  const ra = (a.roomName ?? a.room ?? '').toLowerCase();
  const rb = (b.roomName ?? b.room ?? '').toLowerCase();
  if (ra !== rb) return ra.localeCompare(rb);
  return a.name.localeCompare(b.name);
}

/** Map a settings.connections tone string → a ConnTone. */
function connTone(tone: string, status: string): ConnTone {
  if (tone === 'ok' || tone === 'solar') return 'ok';
  if (tone === 'danger') return status === 'offline' ? 'offline' : 'danger';
  if (tone === 'grid' || tone === 'warning') return 'warning';
  return 'offline';
}

interface SubsystemBlock {
  key: string;
  icon: string;
  name: string;
  rollup: ReturnType<typeof subsystemRollup>;
  chips: DeviceChip[];
}

export function SystemStatus({ ctx }: { ctx: ShellContext }) {
  const wide = ctx.desktop;

  const { data: live } = usePolling<LiveResponse>(api.live, POLL_MS);
  const { data: settings } = usePolling<SettingsResponse>(api.settings, 60_000);
  const { data: devData } = usePolling<DevicesResponse>(api.devices.list, POLL_MS);
  const { data: lights } = usePolling<LightsResponse>(api.lights.list, POLL_MS);
  const { data: blinds } = usePolling<BlindsResponse>(api.blinds.list, POLL_MS);
  const { data: speakers } = usePolling<SpeakersResponse>(api.speakers.list, POLL_MS);
  const { data: irrigation } = usePolling<IrrigationResponse>(api.irrigation.list, POLL_MS);
  const { data: batteries } = usePolling<BatteriesResponse>(api.batteries, POLL_MS);
  const { data: configured } = usePolling<ConfiguredResponse>(api.devices.configured, POLL_MS);
  const { data: alertsData } = usePolling<AlertsResponse>(api.alerts, POLL_MS);
  const { data: ctrl } = usePolling<ControlStatus>(api.control.status, POLL_MS);

  /* ---- Build the per-subsystem rollups + chips ---- */
  const subsystems: SubsystemBlock[] = [];

  // Climate (Intesis/Panasonic + Airzone)
  if (devData) {
    const devs = [...devData.devices]
      .filter((d) => d.type === 'cooling' || d.type === 'heating')
      .sort(byRoomThenName);
    const items: RollupInput[] = devs.map((d) => ({ id: d.id, name: d.name, health: climateHealth(d) }));
    const rollup = subsystemRollup(items, { fleetError: devData.fleetError });
    const chips: DeviceChip[] = devs.map((d) => {
      const h = climateHealth(d);
      const tele = d.online
        ? `${d.power ? d.mode : 'off'}${d.currentTempC != null ? ` ${d.currentTempC.toFixed(1)}°` : ''}${d.lowBattery ? ' · low batt' : ''}`
        : undefined;
      return { id: d.id, name: d.name, state: h.state, telemetry: tele };
    });
    subsystems.push({ key: 'climate', icon: 'snowflake', name: 'Climate', rollup, chips });
  }

  // Batteries
  if (batteries) {
    const bats = batteries.batteries;
    const items: RollupInput[] = bats.map((b) => ({ id: b.id, name: b.name, health: batteryHealth(b) }));
    const rollup = subsystemRollup(items);
    const chips: DeviceChip[] = bats.map((b) => {
      const h = batteryHealth(b);
      const tele = b.online
        ? `${Math.round(b.soc)}%${b.health != null ? ` · SoH ${Math.round(b.health)}%` : ''}`
        : undefined;
      return { id: b.id, name: b.name, state: h.state, telemetry: tele };
    });
    subsystems.push({ key: 'batteries', icon: 'battery-charging', name: 'Batteries', rollup, chips });
  }

  // Lighting
  if (lights) {
    const devs = [...lights.devices].sort(byRoomThenName);
    const items: RollupInput[] = devs.map((d) => ({ id: d.id, name: d.name, health: lightHealth(d) }));
    const rollup = subsystemRollup(items, { fleetError: lights.fleetError });
    const chips: DeviceChip[] = devs.map((d) => {
      const h = lightHealth(d);
      const tele = d.online ? (d.power ? (d.brightnessPct != null ? `${d.brightnessPct}%` : 'on') : 'off') : undefined;
      return { id: d.id, name: d.name, state: h.state, telemetry: tele };
    });
    subsystems.push({ key: 'lighting', icon: 'lightbulb', name: 'Lighting', rollup, chips });
  }

  // Circuits (configured Tuya generic devices)
  if (configured) {
    const devs = [...configured.devices].sort(byRoomThenName);
    const items: RollupInput[] = devs.map((d) => ({ id: d.id, name: d.name, health: circuitHealth(d) }));
    const rollup = subsystemRollup(items, { fleetError: configured.fleetError });
    const chips: DeviceChip[] = devs.map((d) => {
      const h = circuitHealth(d);
      const tele = d.online ? (d.evState?.ruleOn ? `${Math.round((d.evState.reservedW ?? 0) / 100) / 10} kW reserved` : 'online') : undefined;
      return { id: d.id, name: d.name, state: h.state, telemetry: tele };
    });
    if (devs.length > 0) subsystems.push({ key: 'circuits', icon: 'plug', name: 'Circuits', rollup, chips });
  }

  // Blinds
  if (blinds) {
    const devs = [...blinds.devices].sort(byRoomThenName);
    const items: RollupInput[] = devs.map((d) => ({ id: d.id, name: d.name, health: blindHealth(d) }));
    const rollup = subsystemRollup(items, { fleetError: blinds.fleetError });
    const chips: DeviceChip[] = devs.map((d) => {
      const h = blindHealth(d);
      const tele = d.online ? (d.positionPct != null ? `${d.positionPct}% open${d.moving ? ' · moving' : ''}` : d.moving ? 'moving' : 'online') : undefined;
      return { id: d.id, name: d.name, state: h.state, telemetry: tele };
    });
    if (devs.length > 0) subsystems.push({ key: 'blinds', icon: 'blinds', name: 'Blinds', rollup, chips });
  }

  // Speakers
  if (speakers) {
    const devs = [...speakers.speakers].sort((a, b) => a.name.localeCompare(b.name));
    const items: RollupInput[] = devs.map((d) => ({ id: d.id, name: d.name, health: speakerHealth(d) }));
    const rollup = subsystemRollup(items, { fleetError: speakers.lastError });
    const chips: DeviceChip[] = devs.map((d) => {
      const h = speakerHealth(d);
      const tele = d.online ? (d.volumePct != null ? `vol ${d.volumePct}%` : 'online') : undefined;
      return { id: d.id, name: d.name, state: h.state, telemetry: tele };
    });
    if (speakers.enabled && devs.length > 0) subsystems.push({ key: 'speakers', icon: 'speaker', name: 'Speakers', rollup, chips });
  }

  // Irrigation
  if (irrigation) {
    const devs = [...irrigation.zones].sort((a, b) => a.name.localeCompare(b.name));
    const items: RollupInput[] = devs.map((z) => ({ id: z.id, name: z.name, health: irrigationHealth(z) }));
    const rollup = subsystemRollup(items, { fleetError: irrigation.lastError });
    const chips: DeviceChip[] = devs.map((z) => {
      const h = irrigationHealth(z);
      const tele = z.available ? (z.active ? 'running' : 'idle') : undefined;
      return { id: z.id, name: z.name, state: h.state, telemetry: tele };
    });
    if (irrigation.connected && devs.length > 0) subsystems.push({ key: 'irrigation', icon: 'droplet', name: 'Irrigation', rollup, chips });
  }

  /* ---- Page-level rollup ---- */
  const devicesTotal = subsystems.reduce((s, b) => s + b.rollup.total, 0);
  const devicesOnline = subsystems.reduce((s, b) => s + b.rollup.online, 0);
  const worst: HealthState = worstState(subsystems.map((b) => b.rollup.worst));
  const activeAlerts = (alertsData?.alerts ?? []).filter(
    (a) => (a.severity === 'danger' || a.severity === 'warning') && a.status !== 'resolved',
  );
  // First worst issue across subsystems for the banner callout.
  const allIssues = subsystems.flatMap((b) => b.rollup.issues.map((i) => ({ sub: b.name, ...i })));
  const worstIssue =
    allIssues.find((i) => i.state === 'error' || i.state === 'offline')?.reason ??
    allIssues.find((i) => i.state === 'warning')?.reason ??
    null;

  /* ---- Connectivity tiles ---- */
  const tiles: ConnectorTile[] = [];
  // Real probes from settings (Tesla / Sonnen / Weather).
  for (const c of settings?.connections ?? []) {
    tiles.push({ key: `probe-${c.name}`, name: c.name, icon: c.icon || 'plug', tone: connTone(c.tone, c.status), detail: c.detail });
  }
  // Subsystem-derived tiles.
  const subTile = (key: string, name: string, icon: string, present: boolean, err: string | null | undefined, online: number, total: number): ConnectorTile => {
    if (!present) return { key, name, icon, tone: 'nosetup', detail: 'Not set up' };
    if (err) return { key, name, icon, tone: 'danger', detail: err };
    return { key, name, icon, tone: online < total ? 'warning' : 'ok', detail: `${online}/${total} online` };
  };
  if (devData) tiles.push(subTile('climate', 'Climate', 'snowflake', devData.connected, devData.fleetError ?? devData.lastError, subsystems.find((s) => s.key === 'climate')?.rollup.online ?? 0, subsystems.find((s) => s.key === 'climate')?.rollup.total ?? 0));
  if (lights) tiles.push(subTile('lighting', 'Lighting', 'lightbulb', lights.connected, lights.fleetError, lights.devices.filter((d) => d.online).length, lights.devices.length));
  if (blinds) tiles.push(subTile('blinds', 'Blinds', 'blinds', blinds.connected, blinds.fleetError, blinds.devices.filter((d) => d.online).length, blinds.devices.length));
  if (speakers) tiles.push(subTile('speakers', 'Speakers', 'speaker', speakers.enabled, speakers.lastError, speakers.speakers.filter((d) => d.online).length, speakers.speakers.length));
  if (irrigation) tiles.push(subTile('irrigation', 'Irrigation', 'droplet', irrigation.connected, irrigation.lastError, irrigation.zones.filter((z) => z.available).length, irrigation.zones.length));

  /* ---- Rejected control commands ---- */
  const rejected = (ctrl?.log ?? []).filter((l) => !l.ok).slice(0, 5);

  if (!live && !devData && subsystems.length === 0) {
    return (
      <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>
        Connecting to the house…
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: panelGap }}>
      {/* 1 — Health banner */}
      <SystemHealthBanner
        worst={worst}
        devicesOnline={devicesOnline}
        devicesTotal={devicesTotal}
        subsystems={subsystems.length}
        alerts={activeAlerts.length}
        worstIssue={worstIssue}
      />

      {/* 2 — Connectivity */}
      {tiles.length > 0 && <ConnectivityGrid tiles={tiles} wide={wide} />}

      {/* 3 — Live load & flow + draw + today totals */}
      {live && (
        <>
          <LiveLoadStrip live={live} wide={wide} />
          <LiveDrawBreakdown
            live={live}
            climateDevices={devData?.devices ?? []}
            configuredDevices={configured?.devices ?? []}
            wide={wide}
          />
        </>
      )}

      {/* 4 — Subsystem health rows */}
      {subsystems.length > 0 && (
        <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Eyebrow>Device health</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {subsystems.map((b) => (
              <SubsystemHealthRow key={b.key} icon={b.icon} name={b.name} rollup={b.rollup} chips={b.chips} />
            ))}
          </div>
        </Card>
      )}

      {/* 5 — Battery control & guardrails (verbatim, embedded) */}
      <div>
        <Eyebrow>Battery control &amp; guardrails</Eyebrow>
        <div style={{ marginTop: 10 }}>
          <Autopilot ctx={ctx} embedded tab="status" />
        </div>
      </div>

      {/* 6 — Grid quality (only when a voltage-capable breaker exists) */}
      {live?.breaker && <GridQualityCard live={live} monitor={settings?.voltageMonitor} />}

      {/* 7 — Alerts & recent errors */}
      <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Eyebrow>Alerts &amp; recent errors</Eyebrow>
        {activeAlerts.length === 0 && rejected.length === 0 ? (
          <EmptyState icon="check-circle" iconTone="solar" title="All clear." subtitle="No active alerts or rejected commands." style={{ padding: '24px 16px' }} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {activeAlerts.map((a) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>
                <Icon name={a.icon || 'alert-triangle'} size={16} color={a.severity === 'danger' ? 'var(--danger)' : 'var(--grid)'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{a.title}</div>
                  {a.sub && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{a.sub}</div>}
                </div>
                <StatusDot tone={a.severity === 'danger' ? 'danger' : 'grid'}>
                  <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{a.device}</span>
                </StatusDot>
              </div>
            ))}
            {rejected.map((l, i) => (
              <div key={`rej-${l.ts}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--danger-wash)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>
                <Icon name="x-circle" size={16} color="var(--danger)" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>Rejected · {l.device} {l.lever}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{l.detail || l.reason}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
