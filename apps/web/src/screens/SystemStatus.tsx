import { useState } from 'react';
import { Link } from 'react-router-dom';
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
  InvertersResponse,
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
  inverterHealth,
  worstState,
  type RollupInput,
  type HealthState,
} from '../lib/health';
import { Card, StatusDot, Eyebrow, Icon, EmptyState, Button, Modal } from '../components/ui';
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
import { deviceHrefFor, connectorHref, humanizeConnectorError } from '../components/status/resolve';
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

/** A message the owner can click open for the full, readable story + a resolve link. */
interface DetailModal {
  title: string;
  summary: string;
  raw?: string;
  href?: string;
  hrefLabel?: string;
}

export function SystemStatus({ ctx }: { ctx: ShellContext }) {
  const wide = ctx.desktop;
  const [detail, setDetail] = useState<DetailModal | null>(null);

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
  const { data: inverters } = usePolling<InvertersResponse>(api.inverters, POLL_MS);

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
      return { id: d.id, name: d.name, state: h.state, telemetry: tele, reason: h.reason };
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
      return { id: b.id, name: b.name, state: h.state, telemetry: tele, reason: h.reason };
    });
    subsystems.push({ key: 'batteries', icon: 'battery-charging', name: 'Batteries', rollup, chips });
  }

  // Solar inverters (Sungrow SG5.0RS ×2)
  if (inverters && inverters.count > 0) {
    const invs = inverters.inverters;
    const items: RollupInput[] = invs.map((d) => ({ id: d.id, name: d.name, health: inverterHealth(d) }));
    const rollup = subsystemRollup(items);
    const chips: DeviceChip[] = invs.map((d) => {
      const h = inverterHealth(d);
      const tele =
        d.status === 'online'
          ? `${d.kw.toFixed(2)} kW${d.dailyKwh != null ? ` · ${d.dailyKwh.toFixed(1)} kWh today` : ''}`
          : d.status === 'asleep'
            ? 'asleep (night)'
            : 'offline';
      return { id: d.id, name: d.name, state: h.state, telemetry: tele, reason: h.reason };
    });
    subsystems.push({ key: 'inverters', icon: 'sun', name: 'Solar Inverters', rollup, chips });
  }

  // Lighting
  if (lights) {
    const devs = [...lights.devices].sort(byRoomThenName);
    const items: RollupInput[] = devs.map((d) => ({ id: d.id, name: d.name, health: lightHealth(d) }));
    const rollup = subsystemRollup(items, { fleetError: lights.fleetError });
    const chips: DeviceChip[] = devs.map((d) => {
      const h = lightHealth(d);
      const tele = d.online ? (d.power ? (d.brightnessPct != null ? `${d.brightnessPct}%` : 'on') : 'off') : undefined;
      return { id: d.id, name: d.name, state: h.state, telemetry: tele, reason: h.reason };
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
      return { id: d.id, name: d.name, state: h.state, telemetry: tele, reason: h.reason };
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
      return { id: d.id, name: d.name, state: h.state, telemetry: tele, reason: h.reason };
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
      return { id: d.id, name: d.name, state: h.state, telemetry: tele, reason: h.reason };
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
      return { id: z.id, name: z.name, state: h.state, telemetry: tele, reason: h.reason };
    });
    if (irrigation.connected && devs.length > 0) subsystems.push({ key: 'irrigation', icon: 'droplet', name: 'Irrigation', rollup, chips });
  }

  // Attach a click-through detail route to every device chip (climate → device
  // detail, lighting/blinds → filtered list, batteries → battery detail, …).
  for (const b of subsystems) {
    for (const c of b.chips) c.href = deviceHrefFor(b.key, c.id);
  }

  /* ---- Page-level rollup ---- */
  const devicesTotal = subsystems.reduce((s, b) => s + b.rollup.total, 0);
  const devicesOnline = subsystems.reduce((s, b) => s + b.rollup.online, 0);
  const worst: HealthState = worstState(subsystems.map((b) => b.rollup.worst));
  const activeAlerts = (alertsData?.alerts ?? []).filter(
    (a) => (a.severity === 'danger' || a.severity === 'warning') && a.status !== 'resolved',
  );
  // Worst issue across subsystems for the banner callout — named + linked so the
  // owner can jump straight to the offending device (not a bare "Offline").
  const allIssues = subsystems.flatMap((b) => b.rollup.issues.map((i) => ({ subKey: b.key, sub: b.name, ...i })));
  const worstItem =
    allIssues.find((i) => i.state === 'error' || i.state === 'offline') ??
    allIssues.find((i) => i.state === 'warning') ??
    null;
  const isFleet = worstItem?.id.startsWith('__');
  const worstIssue = worstItem
    ? isFleet
      ? `${worstItem.sub} · ${humanizeConnectorError(worstItem.reason)}`
      : `${worstItem.sub} · ${worstItem.name} — ${worstItem.reason}`
    : null;
  const worstIssueHref = worstItem
    ? isFleet
      ? connectorHref(worstItem.subKey).href
      : deviceHrefFor(worstItem.subKey, worstItem.id)
    : null;

  /* ---- Connectivity tiles ---- */
  const tiles: ConnectorTile[] = [];
  // Real probes from settings (Tesla / Sonnen / Weather). Humanize a failing
  // probe's detail; keep the raw for the click-through popover.
  for (const c of settings?.connections ?? []) {
    const tone = connTone(c.tone, c.status);
    const bad = tone === 'danger' || tone === 'offline';
    tiles.push({
      key: `probe-${c.name}`,
      name: c.name,
      icon: c.icon || 'plug',
      tone,
      detail: bad ? humanizeConnectorError(c.detail) : c.detail,
      raw: bad ? c.detail : undefined,
    });
  }
  // Subsystem-derived tiles. A raw fleet error is humanized for the tile and kept
  // in `raw` so the popover can show the full message.
  const subTile = (key: string, name: string, icon: string, present: boolean, err: string | null | undefined, online: number, total: number): ConnectorTile => {
    if (!present) return { key, name, icon, tone: 'nosetup', detail: 'Not set up' };
    if (err) return { key, name, icon, tone: 'danger', detail: humanizeConnectorError(err), raw: err };
    return { key, name, icon, tone: online < total ? 'warning' : 'ok', detail: `${online}/${total} online` };
  };
  if (devData) tiles.push(subTile('climate', 'Climate', 'snowflake', devData.connected, devData.fleetError ?? devData.lastError, subsystems.find((s) => s.key === 'climate')?.rollup.online ?? 0, subsystems.find((s) => s.key === 'climate')?.rollup.total ?? 0));
  if (lights) tiles.push(subTile('lighting', 'Lighting', 'lightbulb', lights.connected, lights.fleetError, lights.devices.filter((d) => d.online).length, lights.devices.length));
  if (blinds) tiles.push(subTile('blinds', 'Blinds', 'blinds', blinds.connected, blinds.fleetError, blinds.devices.filter((d) => d.online).length, blinds.devices.length));
  if (speakers) tiles.push(subTile('speakers', 'Speakers', 'speaker', speakers.enabled, speakers.lastError, speakers.speakers.filter((d) => d.online).length, speakers.speakers.length));
  if (irrigation) tiles.push(subTile('irrigation', 'Irrigation', 'droplet', irrigation.connected, irrigation.lastError, irrigation.zones.filter((z) => z.available).length, irrigation.zones.length));
  // Solar inverters — night sleep is expected (green), only a daylight miss is a fault.
  if (inverters && inverters.count > 0) {
    const invs = inverters.inverters;
    const offline = invs.filter((i) => i.status === 'offline').length;
    const online = invs.filter((i) => i.status === 'online').length;
    const asleep = invs.filter((i) => i.status === 'asleep').length;
    const tone: ConnTone = offline > 0 ? 'danger' : 'ok';
    const detail =
      offline > 0
        ? `${offline}/${invs.length} offline`
        : asleep === invs.length
          ? 'asleep (night)'
          : `${online}/${invs.length} online`;
    tiles.push({ key: 'inverters', name: 'Solar Inverters', icon: 'sun', tone, detail });
  }

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
        worstIssueHref={worstIssueHref}
      />

      {/* 2 — Connectivity (tiles open a readable detail + resolve link) */}
      {tiles.length > 0 && (
        <ConnectivityGrid
          tiles={tiles}
          wide={wide}
          onOpen={(t) => {
            const r = connectorHref(t.key.replace(/^probe-/, ''));
            setDetail({ title: t.name, summary: humanizeConnectorError(t.raw ?? t.detail), raw: t.raw, href: r.href, hrefLabel: r.label });
          }}
        />
      )}

      {/* 3 — Live load & flow + draw + today totals */}
      {live && (
        <>
          <LiveLoadStrip live={live} wide={wide} batteries={batteries} inverters={inverters} />
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
              <button
                key={a.id}
                type="button"
                className="pwr-press"
                onClick={() => setDetail({ title: a.title, summary: a.sub || a.title, href: '/automations?tab=events', hrefLabel: 'Open Events' })}
                style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '10px 12px', textAlign: 'left', width: '100%', cursor: 'pointer', color: 'inherit', font: 'inherit' }}
              >
                <Icon name={a.icon || 'alert-triangle'} size={16} color={a.severity === 'danger' ? 'var(--danger)' : 'var(--grid)'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{a.title}</div>
                  {a.sub && <div style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.sub}</div>}
                </div>
                <StatusDot tone={a.severity === 'danger' ? 'danger' : 'grid'}>
                  <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{a.device}</span>
                </StatusDot>
                <Icon name="chevron-right" size={13} color="var(--text-3)" />
              </button>
            ))}
            {rejected.map((l, i) => (
              <button
                key={`rej-${l.ts}-${i}`}
                type="button"
                className="pwr-press"
                onClick={() => setDetail({ title: `Rejected · ${l.device} ${l.lever}`, summary: humanizeConnectorError(l.detail || l.reason || ''), raw: l.detail || l.reason, href: '/automations?tab=events', hrefLabel: 'Open Events' })}
                style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--danger-wash)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '10px 12px', textAlign: 'left', width: '100%', cursor: 'pointer', color: 'inherit', font: 'inherit' }}
              >
                <Icon name="x-circle" size={16} color="var(--danger)" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>Rejected · {l.device} {l.lever}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{humanizeConnectorError(l.detail || l.reason || '')}</div>
                </div>
                <Icon name="chevron-right" size={13} color="var(--text-3)" />
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* Click-through detail — the full, readable story + a resolve link. */}
      {detail && (
        <Modal
          open
          onClose={() => setDetail(null)}
          size="md"
          tone="battery"
          icon="info"
          title={detail.title}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDetail(null)}>Close</Button>
              {detail.href && (
                <Link to={detail.href} onClick={() => setDetail(null)} style={{ textDecoration: 'none' }}>
                  <Button variant="primary" iconLeft={<Icon name="external-link" size={15} />}>{detail.hrefLabel ?? 'Open'}</Button>
                </Link>
              )}
            </>
          }
        >
          <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 13.5, color: 'var(--text-1)', lineHeight: 1.5 }}>{detail.summary}</div>
            {detail.raw && detail.raw !== detail.summary && (
              <div>
                <div className="pwr-eyebrow" style={{ marginBottom: 5 }}>Technical detail</div>
                <div className="pwr-mono" style={{ fontSize: 11.5, color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '9px 11px', wordBreak: 'break-word' }}>
                  {detail.raw}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
