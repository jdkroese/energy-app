// Irrigation screen (Rain Bird ESP-TM2 + LNK/LNK2) — Phase 2 smart-watering.
//
// A photo ZONE GRID (each card = the garden photo + name + next-run + running indicator +
// today's weather-trim). Tap a zone → a SCHEDULE EDITOR of watering-time cards, each with a
// start time + a prominent duration STEPPER (− min +), a live ≈L estimate, and weekday toggle
// pills, plus per-zone weather-adjust chips and agronomic config. Header stats (next run,
// planned today, weather-trim %, zones). Per-zone "water now". A mode control (Off/Shadow/Live)
// — Live is gated behind admin + the Devices arm and an explicit confirm. Baseline-drift surfaced.
//
// SHADOW-FIRST: the coordinator actuates nothing until mode === 'live' AND the Devices layer is
// armed. Manual run/stop/rain-delay still go through the Phase-1 admin+arm command path.
//
// Responsive (CLAUDE.md web+mobile rule): branches on ctx.desktop. "Power" design system.

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { useAuth } from "../auth/AuthProvider";
import type { ShellContext } from "../components/shell/AppShell";
import type {
  IrrigationPlanResponse,
  IrrigationPlanZone,
  IrrigationWateringTime,
  IrrigationMode,
  IrrigationWindow,
  IrrigationPlantType,
  IrrigationEmitterType,
} from "../lib/types";
import {
  Card,
  Icon,
  Button,
  Select,
  Switch,
  Badge,
  SegmentedControl,
  Modal,
  EmptyState,
  LoadingState,
  StatTile,
} from "../components/ui";
import { MobileHeader, Avatar, StaleBanner } from "./_shared";

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const PLANT_TYPES: IrrigationPlantType[] = [
  "lawn",
  "shrubs",
  "flowers",
  "vegetables",
  "trees",
  "groundcover",
  "succulents",
  "hedge",
];
const EMITTER_TYPES: IrrigationEmitterType[] = [
  "spray",
  "rotor",
  "drip",
  "bubbler",
  "soaker",
];
const WINDOWS: { value: IrrigationWindow; label: string }[] = [
  { value: "early-morning", label: "Early morning" },
  { value: "solar-surplus", label: "Solar surplus" },
  { value: "off-peak-P3", label: "Off-peak (P3)" },
  { value: "none", label: "No preference" },
];

function uid() {
  return `wt-${Math.random().toString(36).slice(2, 9)}`;
}

export function Irrigation({ ctx }: { ctx: ShellContext }) {
  const wide = ctx.desktop;
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const { data, loading, stale, updatedAt, refetch } =
    usePolling<IrrigationPlanResponse>(api.irrigation.plan, 15_000);

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openZoneId, setOpenZoneId] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);

  const openZone = useMemo(
    () => data?.zones.find((z) => z.zoneId === openZoneId) ?? null,
    [data, openZoneId],
  );

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  };

  const changeMode = async (mode: IrrigationMode) => {
    if (mode === "live" && !data?.armed) {
      setErr("Arm the Devices layer before switching irrigation to Live.");
      return;
    }
    if (mode === "live") {
      setConfirmLive(true);
      return;
    }
    await run(`mode-${mode}`, () => api.irrigation.setMode(mode));
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
            subtitle="Add the controller's host and password in Settings → Connections to plan and run watering."
          />
        </Card>
      )}

      {data && data.connected && (
        <>
          {/* Header stats */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: wide ? "repeat(4, 1fr)" : "repeat(2, 1fr)",
              gap: 10,
            }}
          >
            <StatTile
              label="Next run"
              value={data.stats.nextRun ? data.stats.nextRun.startTime : "—"}
              footnote={
                data.stats.nextRun
                  ? DOW[data.stats.nextRun.weekday]
                  : "none scheduled"
              }
            />
            <StatTile
              label="Planned today"
              value={`${data.stats.plannedTodayMin}m`}
              footnote="after weather trim"
            />
            <StatTile
              label="Weather-saved"
              value={`${Math.round(data.stats.savedPctToday * 100)}%`}
              tone={data.stats.savedPctToday > 0 ? "solar" : "neutral"}
              footnote="vs plan ceiling"
            />
            <StatTile
              label="Zones"
              value={String(data.stats.zoneCount)}
              footnote={data.window}
            />
          </div>

          {/* Mode control + weather + global rules */}
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
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  Watering brain
                </div>
                <div style={{ fontSize: 12, color: "var(--text-2)" }}>
                  {modeBlurb(data.mode, data.liveAllowed, data.armed)}
                </div>
              </div>
              {data.weather && (
                <div
                  style={{
                    textAlign: "right",
                    fontSize: 12,
                    color: "var(--text-2)",
                  }}
                >
                  <div style={{ fontFamily: "var(--font-mono)" }}>
                    ET₀ {data.weather.et0Mm}mm
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)" }}>
                    rain {data.weather.precipMm}mm ·{" "}
                    {data.weather.precipProbabilityPct}%
                  </div>
                </div>
              )}
            </div>

            <div style={{ marginTop: 14, maxWidth: wide ? 420 : "100%" }}>
              <SegmentedControl
                block
                value={data.mode}
                onChange={(v) =>
                  isAdmin && void changeMode(v as IrrigationMode)
                }
                options={[
                  { value: "off", label: "Off" },
                  {
                    value: "shadow",
                    label: "Shadow",
                    dot: data.mode === "shadow" ? "var(--text-2)" : undefined,
                  },
                  {
                    value: "live",
                    label: "Live",
                    dot: data.mode === "live" ? "var(--solar)" : undefined,
                  },
                ]}
              />
              {!isAdmin && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--text-2)",
                    marginTop: 6,
                  }}
                >
                  Sign in as admin to change the mode or the schedule.
                </div>
              )}
              {data.mode === "live" && !data.liveAllowed && (
                <div style={warnBox}>
                  Live, but not actuating — the Devices layer is disarmed (mode{" "}
                  {data.devicesMode}). Arm it to let the coordinator suppress
                  the controller program and fire zones.
                </div>
              )}
            </div>

            {/* Global weather rules */}
            {isAdmin && (
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  marginTop: 14,
                  alignItems: "flex-end",
                }}
              >
                <div style={{ minWidth: 140 }}>
                  <Select
                    label="Watering window"
                    value={data.window}
                    onChange={(e) =>
                      void run("window", () =>
                        api.irrigation.setGlobal({
                          window: e.target.value as IrrigationWindow,
                        }),
                      )
                    }
                    options={WINDOWS}
                  />
                </div>
                <div style={{ minWidth: 120 }}>
                  <Select
                    label="Rain-skip (mm)"
                    value={String(data.globalRainSkipMm)}
                    onChange={(e) =>
                      void run("rainmm", () =>
                        api.irrigation.setGlobal({
                          globalRainSkipMm: Number(e.target.value),
                        }),
                      )
                    }
                    options={["2", "3", "5", "8", "10", "15"].map((v) => ({
                      value: v,
                      label: `${v} mm`,
                    }))}
                  />
                </div>
                <div style={{ minWidth: 120 }}>
                  <Select
                    label="Rain prob."
                    value={String(data.rainSkipProbabilityPct)}
                    onChange={(e) =>
                      void run("rainprob", () =>
                        api.irrigation.setGlobal({
                          rainSkipProbabilityPct: Number(e.target.value),
                        }),
                      )
                    }
                    options={["40", "50", "60", "70", "80"].map((v) => ({
                      value: v,
                      label: `${v}%`,
                    }))}
                  />
                </div>
              </div>
            )}

            {data.baselineDrift && (
              <div style={warnBox}>
                Controller baseline changed (stations differ from our last
                mirror). The onboard program is untouched — review the zones
                below if you edited it at the keypad.
              </div>
            )}
            {data.lastError && <div style={errBox}>{data.lastError}</div>}
          </Card>

          {err && <div style={errBox}>{err}</div>}

          {/* Photo zone grid */}
          {data.zones.length === 0 ? (
            <Card padded>
              <EmptyState
                icon="sprout"
                title="No zones yet"
                subtitle="The controller reports stations as you wire them. Add a zone by giving a station a name + photo, then a schedule."
              />
            </Card>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: wide
                  ? "repeat(auto-fill, minmax(240px, 1fr))"
                  : "1fr",
                gap: 12,
              }}
            >
              {data.zones.map((z) => (
                <ZoneCard
                  key={z.zoneId}
                  zone={z}
                  isAdmin={isAdmin}
                  armed={data.armed}
                  busy={busy === `now-${z.zoneId}`}
                  onOpen={() => setOpenZoneId(z.zoneId)}
                  onWaterNow={() =>
                    void run(`now-${z.zoneId}`, () =>
                      api.irrigation.command(
                        z.zoneId,
                        "run",
                        Math.max(
                          1,
                          z.trimmedMinToday || z.scheduledMinToday || 10,
                        ),
                      ),
                    )
                  }
                  onStop={() =>
                    void run(`now-${z.zoneId}`, () =>
                      api.irrigation.command("rb-all", "stop"),
                    )
                  }
                />
              ))}
            </div>
          )}

          {/* Activity log */}
          {data.log.length > 0 && (
            <Card padded>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                Recent decisions
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {data.log.slice(0, 8).map((e, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      gap: 8,
                      fontSize: 11.5,
                      color: e.ok ? "var(--text-2)" : "var(--grid)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    <span style={{ opacity: 0.6, flex: "none" }}>
                      {new Date(e.ts).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <Badge tone={e.live ? "solar" : "neutral"}>
                      {e.live ? "live" : "shadow"}
                    </Badge>
                    <span
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {e.zoneId} · {e.detail}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );

  return (
    <>
      {!wide && (
        <MobileHeader eyebrow="Home" title="Irrigation" right={<Avatar />} />
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: wide ? 16 : 14,
          width: "100%",
          padding: wide ? 0 : "8px 14px 22px",
        }}
      >
        {body}
      </div>

      {openZone && (
        <ZoneEditor
          zone={openZone}
          wide={wide}
          isAdmin={isAdmin}
          onClose={() => setOpenZoneId(null)}
          onSaved={() => void refetch()}
          onError={setErr}
        />
      )}

      <Modal
        open={confirmLive}
        onClose={() => setConfirmLive(false)}
        title="Switch irrigation to Live?"
        subtitle="The coordinator will suppress the controller's onboard program (rolling rain-delay) and open valves on the weather-trimmed schedule."
        tone="solar"
      >
        <div style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
          Live actuation runs only while the Devices layer stays armed. If the
          mini, LAN, or a deploy fails, the rain-delay lapses within a day and
          the controller resumes on its own — the garden never goes dry.
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <Button variant="secondary" onClick={() => setConfirmLive(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy === "mode-live"}
            onClick={() =>
              void (async () => {
                await run("mode-live", () => api.irrigation.setMode("live"));
                setConfirmLive(false);
              })()
            }
          >
            Go Live
          </Button>
        </div>
      </Modal>
    </>
  );
}

function modeBlurb(
  mode: IrrigationMode,
  liveAllowed: boolean,
  armed: boolean,
): string {
  if (mode === "off")
    return "Off — the controller's own program runs. App suppresses nothing.";
  if (mode === "shadow")
    return "Shadow — computes + logs the plan, but opens no valves.";
  return liveAllowed
    ? "Live — suppressing the onboard program and firing the weather-trimmed plan."
    : armed
      ? "Live — armed."
      : "Live — but disarmed, so nothing is actuated.";
}

// ---- Zone card --------------------------------------------------------------

function ZoneCard({
  zone,
  isAdmin,
  armed,
  busy,
  onOpen,
  onWaterNow,
  onStop,
}: {
  zone: IrrigationPlanZone;
  isAdmin: boolean;
  armed: boolean;
  busy: boolean;
  onOpen: () => void;
  onWaterNow: () => void;
  onStop: () => void;
}) {
  return (
    <Card style={{ overflow: "hidden", padding: 0 }}>
      {/* Photo / placeholder */}
      <button
        onClick={onOpen}
        style={{
          display: "block",
          width: "100%",
          height: 130,
          border: "none",
          padding: 0,
          cursor: "pointer",
          position: "relative",
          background: zone.photoUrl
            ? `center/cover no-repeat url(${zone.photoUrl})`
            : "var(--surface-3)",
        }}
        aria-label={`Open ${zone.name}`}
      >
        {!zone.photoUrl && (
          <span
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              color: "var(--text-2)",
            }}
          >
            <Icon name="sprout" size={28} />
          </span>
        )}
        {zone.active && (
          <span style={{ position: "absolute", top: 8, left: 8 }}>
            <Badge tone="solar">Watering</Badge>
          </span>
        )}
        {zone.savedPctToday > 0 && !zone.active && (
          <span style={{ position: "absolute", top: 8, right: 8 }}>
            <Badge tone="neutral">
              −{Math.round(zone.savedPctToday * 100)}%
            </Badge>
          </span>
        )}
      </button>

      <div style={{ padding: "10px 12px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {zone.name}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--text-2)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Station {zone.station} · {zone.plantType}
            </div>
          </div>
          {zone.managedBy === "controller" && (
            <Badge tone="neutral">controller</Badge>
          )}
        </div>

        {/* Trim chips */}
        {zone.trimReasons.length > 0 && (
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}
          >
            {zone.trimReasons.slice(0, 3).map((r, i) => (
              <span key={i} style={chip}>
                {r}
              </span>
            ))}
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            fontSize: 12,
            color: "var(--text-2)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {zone.nextRun
              ? `${DOW[zone.nextRun.weekday]} ${zone.nextRun.startTime}`
              : "no schedule"}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {zone.trimmedMinToday}m · ≈{Math.round(zone.litersToday)}L
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={onOpen}
            style={{ flex: 1 }}
          >
            Schedule
          </Button>
          {isAdmin &&
            (zone.active ? (
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
                onClick={onWaterNow}
              >
                Water now
              </Button>
            ))}
        </div>
      </div>
    </Card>
  );
}

// ---- Zone editor (schedule + agronomic config + photo) ----------------------

function ZoneEditor({
  zone,
  wide,
  isAdmin,
  onClose,
  onSaved,
  onError,
}: {
  zone: IrrigationPlanZone;
  wide: boolean;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(zone.name);
  const [plantType, setPlantType] = useState<IrrigationPlantType>(
    zone.plantType,
  );
  const [emitterType, setEmitterType] = useState<IrrigationEmitterType>(
    zone.emitterType,
  );
  const [managedBy, setManagedBy] = useState(zone.managedBy);
  const [heatTopup, setHeatTopup] = useState(zone.heatTopupEnabled);
  const [times, setTimes] = useState<IrrigationWateringTime[]>(
    zone.wateringTimes,
  );
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ≈L per minute for this zone (effective flow). Used for the live estimate in the stepper.
  const lpm = zone.flowLpm;

  const save = async () => {
    setSaving(true);
    try {
      await api.irrigation.setZone(zone.zoneId, {
        name,
        plantType,
        emitterType,
        managedBy,
        heatTopupEnabled: heatTopup,
        wateringTimes: times,
      });
      onSaved();
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save zone");
    } finally {
      setSaving(false);
    }
  };

  const uploadPhoto = async (file: File) => {
    try {
      await api.irrigation.uploadPhoto(zone.zoneId, file);
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Photo upload failed");
    }
  };

  const addTime = () =>
    setTimes((t) => [
      ...t,
      {
        id: uid(),
        startTime: "06:00",
        durationMin: 10,
        days: [false, true, true, true, true, true, false],
      },
    ]);
  const updateTime = (id: string, patch: Partial<IrrigationWateringTime>) =>
    setTimes((t) => t.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const removeTime = (id: string) =>
    setTimes((t) => t.filter((w) => w.id !== id));

  return (
    <Modal
      open
      onClose={onClose}
      title={zone.name}
      subtitle={`Station ${zone.station}`}
      size={wide ? "lg" : "md"}
    >
      {/* Photo */}
      <div
        style={{
          height: 150,
          borderRadius: "var(--radius-md)",
          marginBottom: 14,
          position: "relative",
          overflow: "hidden",
          background: zone.photoUrl
            ? `center/cover no-repeat url(${zone.photoUrl})`
            : "var(--surface-3)",
        }}
      >
        {!zone.photoUrl && (
          <span
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              color: "var(--text-2)",
            }}
          >
            <Icon name="sprout" size={30} />
          </span>
        )}
        {isAdmin && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadPhoto(f);
                e.currentTarget.value = "";
              }}
            />
            <div style={{ position: "absolute", bottom: 8, right: 8 }}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => fileRef.current?.click()}
              >
                {zone.photoUrl ? "Change photo" : "Add photo"}
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Agronomic config */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: wide ? "1fr 1fr" : "1fr",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <label style={fieldLabel}>
          Name
          <input
            style={textInput}
            value={name}
            disabled={!isAdmin}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Select
          label="Plant type"
          value={plantType}
          disabled={!isAdmin}
          onChange={(e) => setPlantType(e.target.value as IrrigationPlantType)}
          options={PLANT_TYPES.map((p) => ({ value: p, label: p }))}
        />
        <Select
          label="Emitter"
          value={emitterType}
          disabled={!isAdmin}
          onChange={(e) =>
            setEmitterType(e.target.value as IrrigationEmitterType)
          }
          options={EMITTER_TYPES.map((p) => ({
            value: p,
            label: `${p} (≈${zone.flowLpm}L/min)`,
          }))}
        />
        <Select
          label="Managed by"
          value={managedBy}
          disabled={!isAdmin}
          onChange={(e) => setManagedBy(e.target.value as "app" | "controller")}
          options={[
            { value: "app", label: "App (we fire it)" },
            { value: "controller", label: "Controller (keypad owns)" },
          ]}
        />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <Switch
          label="Heat top-up on hot days"
          checked={heatTopup}
          disabled={!isAdmin}
          onChange={(e) => setHeatTopup(e.currentTarget.checked)}
        />
      </div>

      {/* Schedule editor */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
          Watering times (ceiling — weather trims down)
        </div>
        {isAdmin && managedBy === "app" && (
          <Button size="sm" variant="secondary" onClick={addTime}>
            + Add time
          </Button>
        )}
      </div>

      {managedBy === "controller" ? (
        <div
          style={{ fontSize: 12.5, color: "var(--text-2)", padding: "8px 0" }}
        >
          This zone is owned by the controller keypad — the app reads it but
          never fires it.
        </div>
      ) : times.length === 0 ? (
        <div
          style={{ fontSize: 12.5, color: "var(--text-2)", padding: "8px 0" }}
        >
          No watering times yet. Add one to schedule this zone.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {times.map((w) => (
            <TimeCard
              key={w.id}
              time={w}
              lpm={lpm}
              isAdmin={isAdmin}
              onChange={(patch) => updateTime(w.id, patch)}
              onRemove={() => removeTime(w.id)}
            />
          ))}
        </div>
      )}

      {isAdmin && (
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 18,
          }}
        >
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={() => void save()}
          >
            Save zone
          </Button>
        </div>
      )}
    </Modal>
  );
}

function TimeCard({
  time,
  lpm,
  isAdmin,
  onChange,
  onRemove,
}: {
  time: IrrigationWateringTime;
  lpm: number;
  isAdmin: boolean;
  onChange: (patch: Partial<IrrigationWateringTime>) => void;
  onRemove: () => void;
}) {
  const liters = Math.round(time.durationMin * lpm);
  const step = (delta: number) =>
    onChange({
      durationMin: Math.max(1, Math.min(600, time.durationMin + delta)),
    });

  return (
    <div
      style={{
        border: "1px solid var(--border-1)",
        borderRadius: "var(--radius-md)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        background: "var(--surface-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <label style={{ ...fieldLabel, width: 110 }}>
          Start
          <input
            type="time"
            style={textInput}
            value={time.startTime}
            disabled={!isAdmin}
            onChange={(e) => onChange({ startTime: e.target.value })}
          />
        </label>

        {/* Duration stepper */}
        <div style={{ flex: 1, minWidth: 180 }}>
          <div
            style={{ fontSize: 11.5, color: "var(--text-2)", marginBottom: 4 }}
          >
            Duration
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              size="sm"
              variant="secondary"
              disabled={!isAdmin}
              onClick={() => step(-1)}
              aria-label="Decrease"
            >
              −
            </Button>
            <div style={{ minWidth: 86, textAlign: "center" }}>
              <span
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {time.durationMin}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-2)" }}> min</span>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={!isAdmin}
              onClick={() => step(1)}
              aria-label="Increase"
            >
              +
            </Button>
            <span
              style={{
                fontSize: 12,
                color: "var(--text-2)",
                fontFamily: "var(--font-mono)",
                marginLeft: 4,
              }}
            >
              ≈{liters}L
            </span>
          </div>
        </div>

        {isAdmin && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRemove}
            aria-label="Remove time"
          >
            <Icon name="trash" size={15} />
          </Button>
        )}
      </div>

      {/* Weekday pills */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {DOW.map((d, i) => {
          const on = time.days[i];
          return (
            <button
              key={i}
              disabled={!isAdmin}
              onClick={() => {
                const days = [...time.days];
                days[i] = !days[i];
                onChange({ days });
              }}
              style={{
                width: 36,
                height: 30,
                borderRadius: 8,
                border: `1px solid ${on ? "var(--accent)" : "var(--border-1)"}`,
                background: on ? "var(--accent)" : "transparent",
                color: on ? "var(--accent-ink, #04121a)" : "var(--text-2)",
                fontSize: 12,
                fontWeight: 600,
                cursor: isAdmin ? "pointer" : "default",
              }}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- styles -----------------------------------------------------------------

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

const chip = {
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 999,
  background: "var(--surface-3)",
  color: "var(--text-2)",
  fontFamily: "var(--font-mono)",
} as const;

const fieldLabel = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 11.5,
  color: "var(--text-2)",
} as const;

const textInput = {
  height: 38,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-1)",
  background: "var(--surface-2)",
  color: "var(--text-1)",
  padding: "0 10px",
  fontSize: 14,
} as const;

const errBox = {
  marginTop: 12,
  padding: "8px 12px",
  borderRadius: "var(--radius-md)",
  background: "var(--grid-wash)",
  color: "var(--grid)",
  fontSize: 12.5,
} as const;

const warnBox = {
  marginTop: 12,
  padding: "8px 12px",
  borderRadius: "var(--radius-md)",
  background: "var(--surface-3)",
  color: "var(--text-2)",
  fontSize: 12.5,
  lineHeight: 1.45,
} as const;
