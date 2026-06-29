// Irrigation screen (Rain Bird ESP-TM2 + LNK/LNK2). Lists the controller's zones
// with their live active/idle state and per-zone controls: manual RUN (pick minutes
// + Start), STOP (all), a controller-wide RAIN-DELAY, and room assignment. Writes go
// through the admin- + arm-gated /api/irrigation command path — when the Devices
// layer is disarmed they are refused server-side and surfaced here as an error.
//
// Responsive (CLAUDE.md web+mobile rule): branches on ctx.desktop. Phase 1 is manual
// + scheduled only — no autonomous watering. Follows the "Power" design system.

import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { useAuth } from "../auth/AuthProvider";
import type { ShellContext } from "../components/shell/AppShell";
import type {
  IrrigationResponse,
  IrrigationZone,
  RoomsResponse,
} from "../lib/types";
import {
  Card,
  Icon,
  Button,
  Select,
  Badge,
  EmptyState,
  LoadingState,
} from "../components/ui";
import { MobileHeader, Avatar, StaleBanner } from "./_shared";

const RUN_MINUTES = [5, 10, 15, 20, 30, 45, 60];

export function Irrigation({ ctx }: { ctx: ShellContext }) {
  const wide = ctx.desktop;
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const { data, loading, stale, updatedAt, refetch } =
    usePolling<IrrigationResponse>(api.irrigation.list, 15_000);
  const { data: roomsData } = usePolling<RoomsResponse>(api.rooms.list, 0);
  // Rooms ALWAYS listed alphabetically (standing rule).
  const rooms = useMemo(
    () =>
      [...(roomsData?.rooms ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    [roomsData?.rooms],
  );

  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Per-zone selected run duration (minutes).
  const [minutes, setMinutes] = useState<Record<string, number>>({});
  // Rain-delay input mirror.
  const [rainDelay, setRainDelay] = useState<number | null>(null);
  useEffect(() => {
    if (data && rainDelay === null) setRainDelay(data.rainDelayDays);
  }, [data, rainDelay]);

  const minutesFor = (id: string) => minutes[id] ?? 10;

  const command = async (
    id: string,
    lever: "run" | "stop" | "rainDelay",
    value?: number,
  ) => {
    setBusyId(id);
    setErr(null);
    try {
      const r = await api.irrigation.command(id, lever, value);
      if (!r.result.ok) setErr(r.result.detail || r.result.reason);
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Command failed");
    } finally {
      setBusyId(null);
    }
  };

  const assignRoom = async (id: string, roomId: string) => {
    try {
      await api.irrigation.setSettings(id, { roomId: roomId || null });
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not assign room");
    }
  };

  const body = (
    <>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      {!data && loading && (
        <LoadingState rows={3} label="Loading irrigation…" />
      )}

      {data && !data.connected && (
        <Card padded>
          <EmptyState
            icon="droplets"
            title="Rain Bird not connected"
            subtitle="Add the controller's host and password in Settings → Connections to control irrigation."
          />
        </Card>
      )}

      {data && data.connected && (
        <>
          {/* Controller status + rain-delay + global STOP */}
          <Card padded>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span style={iconChip}>
                <Icon name="droplets" size={18} />
              </span>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Controller</div>
                <div style={{ fontSize: 12, color: "var(--text-2)" }}>
                  {data.running ? "Watering now" : "Idle"}
                  {!data.armed && " · disarmed (writes blocked)"}
                </div>
              </div>
              <Badge tone={data.running ? "solar" : "neutral"}>
                {data.running ? "Active" : "Idle"}
              </Badge>
            </div>

            {data.lastError && <div style={errBox}>{data.lastError}</div>}

            {/* Rain delay + STOP all */}
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 10,
                flexWrap: "wrap",
                marginTop: 14,
              }}
            >
              <div style={{ minWidth: 130 }}>
                <Select
                  label="Rain delay (days)"
                  value={String(rainDelay ?? data.rainDelayDays)}
                  disabled={!isAdmin}
                  onChange={(e) => setRainDelay(Number(e.target.value))}
                  options={["0", "1", "2", "3", "5", "7", "10", "14"].map(
                    (d) => ({
                      value: d,
                      label: `${d} day${d === "1" ? "" : "s"}`,
                    }),
                  )}
                />
              </div>
              {isAdmin && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busyId === "rb-controller"}
                  onClick={() =>
                    void command(
                      "rb-controller",
                      "rainDelay",
                      rainDelay ?? data.rainDelayDays,
                    )
                  }
                >
                  Set delay
                </Button>
              )}
              <div style={{ flex: 1 }} />
              {isAdmin && (
                <Button
                  size="sm"
                  variant="danger"
                  loading={busyId === "rb-all"}
                  disabled={!data.running}
                  onClick={() => void command("rb-all", "stop")}
                >
                  Stop all
                </Button>
              )}
            </div>
          </Card>

          {err && <div style={errBox}>{err}</div>}

          {/* Zones */}
          {data.zones.length === 0 ? (
            <Card padded>
              <EmptyState
                icon="sprout"
                title="No zones reported"
                subtitle="The controller didn't report any available stations."
              />
            </Card>
          ) : (
            <Card padded style={{ padding: "4px 6px" }}>
              {data.zones.map((z, i) => (
                <ZoneRow
                  key={z.id}
                  zone={z}
                  first={i === 0}
                  wide={wide}
                  isAdmin={isAdmin}
                  armed={data.armed}
                  busy={busyId === z.id}
                  minutes={minutesFor(z.id)}
                  onMinutes={(m) =>
                    setMinutes((cur) => ({ ...cur, [z.id]: m }))
                  }
                  onRun={() => void command(z.id, "run", minutesFor(z.id))}
                  onStop={() => void command("rb-all", "stop")}
                  rooms={rooms.map((r) => ({ value: r.id, label: r.name }))}
                  onRoom={(roomId) => void assignRoom(z.id, roomId)}
                />
              ))}
            </Card>
          )}
        </>
      )}
    </>
  );

  if (wide) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          width: "100%",
        }}
      >
        {body}
      </div>
    );
  }
  return (
    <>
      <MobileHeader eyebrow="Home" title="Irrigation" right={<Avatar />} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: "8px 14px 22px",
        }}
      >
        {body}
      </div>
    </>
  );
}

function ZoneRow({
  zone,
  first,
  wide,
  isAdmin,
  armed,
  busy,
  minutes,
  onMinutes,
  onRun,
  onStop,
  rooms,
  onRoom,
}: {
  zone: IrrigationZone;
  first: boolean;
  wide: boolean;
  isAdmin: boolean;
  armed: boolean;
  busy: boolean;
  minutes: number;
  onMinutes: (m: number) => void;
  onRun: () => void;
  onStop: () => void;
  rooms: { value: string; label: string }[];
  onRoom: (roomId: string) => void;
}) {
  return (
    <div
      style={{
        borderTop: first ? "none" : "1px solid var(--border-1)",
        padding: "12px 10px",
        display: "flex",
        flexDirection: wide ? "row" : "column",
        alignItems: wide ? "center" : "stretch",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flex: 1,
          minWidth: 0,
        }}
      >
        <span
          style={{
            ...iconChip,
            color: zone.active ? "var(--solar)" : "var(--text-2)",
          }}
        >
          <Icon name="sprout" size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {zone.name}
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-2)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Station {zone.station} · {zone.active ? "watering" : "idle"}
          </div>
        </div>
        {zone.active && <Badge tone="solar">On</Badge>}
      </div>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          justifyContent: wide ? "flex-end" : "space-between",
        }}
      >
        {isAdmin && (
          <>
            <div style={{ width: 104 }}>
              <Select
                value={String(minutes)}
                onChange={(e) => onMinutes(Number(e.target.value))}
                options={RUN_MINUTES.map((m) => ({
                  value: String(m),
                  label: `${m} min`,
                }))}
              />
            </div>
            {zone.active ? (
              <Button
                size="sm"
                variant="danger"
                loading={busy}
                onClick={onStop}
              >
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                disabled={!armed}
                onClick={onRun}
              >
                Start
              </Button>
            )}
          </>
        )}
        <div style={{ width: wide ? 150 : "100%" }}>
          <Select
            placeholder="Unassigned"
            value={zone.roomId ?? ""}
            disabled={!isAdmin}
            onChange={(e) => onRoom(e.target.value)}
            options={[{ value: "", label: "Unassigned" }, ...rooms]}
          />
        </div>
      </div>
    </div>
  );
}

const iconChip = {
  width: 34,
  height: 34,
  borderRadius: 10,
  display: "grid",
  placeItems: "center",
  flex: "none",
  background: "var(--surface-3)",
  color: "var(--text-2)",
} as const;

const errBox = {
  marginTop: 12,
  padding: "8px 12px",
  borderRadius: "var(--radius-md)",
  background: "var(--grid-wash)",
  color: "var(--grid)",
  fontSize: 12.5,
} as const;
