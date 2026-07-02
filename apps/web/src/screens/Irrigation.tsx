// Irrigation screen (Rain Bird ESP-TM2 + LNK/LNK2) — Phase 2 smart-watering, production.
//
// Sections (top→bottom): header stats · Watering brain (Off/Live + bypass rules) · forecast
// outlook (upcoming rain + bypass markers) · photo ZONE GRID (schedule + Water-now slider) ·
// Weekly plan (the whole configured program) · Activity (the unified irrigation event feed).
//
// PRODUCTION: the coordinator actuates only when mode === 'live' AND the Devices layer is armed
// (docs/39 §7 removed the old 'shadow' mode). A 2h-ahead rain-bypass decision skips a run whose
// forecast crosses the bypass thresholds (docs/39 §6).
//
// Responsive (CLAUDE.md web+mobile rule): branches on ctx.desktop. "Power" design system.

import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { useAuth } from "../auth/AuthProvider";
import type { ShellContext } from "../components/shell/AppShell";
import type {
  IrrigationPlanResponse,
  IrrigationPlanZone,
  IrrigationWateringTime,
  IrrigationMode,
  IrrigationPlantType,
  IrrigationEmitterType,
  IrrigationDailyOutlook,
  EnergyEvent,
} from "../lib/types";
import {
  Card,
  Icon,
  Button,
  Select,
  Switch,
  Badge,
  Slider,
  Modal,
  EmptyState,
  LoadingState,
  StatTile,
  StatusDot,
} from "../components/ui";
import { MobileHeader, Avatar, StaleBanner } from "./_shared";

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
/** Weekly plan renders Monday-first. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
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

/** Default minutes for a manual "Water now". */
const WATER_NOW_DEFAULT_MIN = 20;

function uid() {
  return `wt-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Re-encode any picked image to a downscaled JPEG before upload. iPhone "Take Photo" hands the
 * browser an HEIC/HEIF file (and full-res 12 MP, often over the 8 MB server cap) — the API only
 * accepts jpeg/png/webp, so those were silently rejected. Safari can decode HEIC into an <img>,
 * so drawing to a canvas + exporting JPEG normalises BOTH format and size. Falls back to the
 * original file if the browser can't decode it (e.g. desktop Chrome + HEIC).
 */
async function normalizePhoto(file: File): Promise<File> {
  const MAX_DIM = 1600;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("decode failed"));
      im.src = url;
    });
    const scale = Math.min(
      1,
      MAX_DIM / Math.max(img.naturalWidth || 1, img.naturalHeight || 1),
    );
    const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const cx = canvas.getContext("2d");
    if (!cx) return file;
    cx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/jpeg", 0.85),
    );
    if (!blob) return file;
    return new File([blob], "zone.jpg", { type: "image/jpeg" });
  } catch {
    return file; // let the server validate; at least the upload is attempted
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface WeeklyRun {
  zoneName: string;
  station: number;
  startTime: string;
  durationMin: number;
  liters: number;
}

/** Group every app-managed zone's watering times into a Monday-first weekly overview. */
function buildWeeklyPlan(
  zones: IrrigationPlanZone[],
): { weekday: number; runs: WeeklyRun[]; totalMin: number }[] {
  return WEEK_ORDER.map((weekday) => {
    const runs: WeeklyRun[] = [];
    for (const z of zones) {
      if (z.managedBy !== "app") continue;
      for (const w of z.wateringTimes) {
        if (w.days[weekday])
          runs.push({
            zoneName: z.name,
            station: z.station,
            startTime: w.startTime,
            durationMin: w.durationMin,
            liters: Math.round(w.durationMin * z.flowLpm),
          });
      }
    }
    runs.sort((a, b) => a.startTime.localeCompare(b.startTime));
    return {
      weekday,
      runs,
      totalMin: runs.reduce((s, r) => s + r.durationMin, 0),
    };
  });
}

export function Irrigation({ ctx }: { ctx: ShellContext }) {
  const wide = ctx.desktop;
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const { data, loading, stale, updatedAt, refetch } =
    usePolling<IrrigationPlanResponse>(api.irrigation.plan, 15_000);

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openZoneId, setOpenZoneId] = useState<string | null>(null);
  const [waterZone, setWaterZone] = useState<IrrigationPlanZone | null>(null);
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

  const appManaged =
    data?.zones.filter((z) => z.managedBy === "app").length ?? 0;
  const activeZones = useMemo(
    () => data?.zones.filter((z) => z.active) ?? [],
    [data],
  );

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
          {/* Live "watering now" banner — shown whenever ANY zone is running (scheduled
              or a manual Water-now). The single, unmissable in-progress indicator. */}
          {activeZones.length > 0 && (
            <NowWateringBanner
              zones={activeZones}
              isAdmin={isAdmin}
              busy={busy === "stop-all"}
              onStop={() =>
                void run("stop-all", () =>
                  api.irrigation.command("rb-all", "stop"),
                )
              }
            />
          )}

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
              footnote={`${appManaged} app-managed`}
            />
          </div>

          {/* Compact controller toggle: Rain Bird (off) ⇄ Home App (live) */}
          <ModeToggle
            mode={data.mode}
            liveAllowed={data.liveAllowed}
            armed={data.armed}
            devicesMode={data.devicesMode}
            isAdmin={isAdmin}
            busy={busy === "mode-live" || busy === "mode-off"}
            onChange={(m) => void changeMode(m)}
          />

          {data.baselineDrift && (
            <div style={warnBox}>
              Controller baseline changed (stations differ from our last mirror).
              The onboard program is untouched — review the zones below if you
              edited it at the keypad.
            </div>
          )}
          {data.lastError && <div style={errBox}>{data.lastError}</div>}

          {err && <div style={errBox}>{err}</div>}

          {/* Forecast outlook + bypass rules + per-day weather */}
          <ForecastStrip
            data={data}
            wide={wide}
            isAdmin={isAdmin}
            onBypassChange={(patch) =>
              void run("bypass", () => api.irrigation.setGlobal(patch))
            }
          />

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
                  onWaterNow={() => setWaterZone(z)}
                  onStop={() =>
                    void run(`now-${z.zoneId}`, () =>
                      api.irrigation.command("rb-all", "stop"),
                    )
                  }
                />
              ))}
            </div>
          )}

          {/* Weekly schedule overview */}
          <WeeklyPlanCard zones={data.zones} wide={wide} />

          {/* Irrigation event feed */}
          <ActivityFeed
            onViewAll={() => nav("/automations?tab=events&cat=irrigation")}
          />
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

      {waterZone && (
        <WaterNowModal
          zone={waterZone}
          onClose={() => setWaterZone(null)}
          onConfirm={async (mins) => {
            await run(`now-${waterZone.zoneId}`, () =>
              api.irrigation.command(waterZone.zoneId, "run", mins),
            );
            setWaterZone(null);
          }}
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

// ---- Compact controller toggle (Rain Bird ⇄ Home App) -----------------------

function ModeToggle({
  mode,
  liveAllowed,
  armed,
  devicesMode,
  isAdmin,
  busy,
  onChange,
}: {
  mode: IrrigationMode;
  liveAllowed: boolean;
  armed: boolean;
  devicesMode: string;
  isAdmin: boolean;
  busy: boolean;
  onChange: (mode: IrrigationMode) => void;
}) {
  const live = mode === "live";
  const caption = live
    ? liveAllowed
      ? "Home App runs the weather-trimmed plan."
      : armed
        ? "Home App selected."
        : `Arm the Devices layer to actuate (mode ${devicesMode}).`
    : "The Rain Bird controller's own weekly program runs.";
  return (
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
          <Icon name="droplets" size={16} />
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <PoleLabel icon="cpu" label="Rain Bird" active={!live} />
          <Switch
            checked={live}
            disabled={!isAdmin || busy}
            onChange={(e) =>
              onChange(e.currentTarget.checked ? "live" : "off")
            }
          />
          <PoleLabel icon="house" label="Home App" active={live} />
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 150,
            fontSize: 12,
            color: "var(--text-2)",
          }}
        >
          {caption}
        </div>
      </div>
      {live && !liveAllowed && (
        <div style={warnBox}>
          Home App is selected but the Devices layer is disarmed (mode{" "}
          {devicesMode}). Arm it to let the app suppress the controller program
          and fire zones.
        </div>
      )}
      {!isAdmin && (
        <div style={{ fontSize: 11.5, color: "var(--text-2)", marginTop: 8 }}>
          Sign in as admin to change who runs watering.
        </div>
      )}
    </Card>
  );
}

function PoleLabel({
  icon,
  label,
  active,
}: {
  icon: string;
  label: string;
  active: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 12.5,
        fontWeight: active ? 700 : 500,
        color: active ? "var(--text-1)" : "var(--text-2)",
        opacity: active ? 1 : 0.65,
        whiteSpace: "nowrap",
      }}
    >
      <Icon name={icon} size={14} />
      {label}
    </span>
  );
}

// ---- Live "watering now" banner ---------------------------------------------

function NowWateringBanner({
  zones,
  isAdmin,
  busy,
  onStop,
}: {
  zones: IrrigationPlanZone[];
  isAdmin: boolean;
  busy: boolean;
  onStop: () => void;
}) {
  const names = zones.map((z) => z.name).join(", ");
  const sub =
    zones.length === 1
      ? `Station ${zones[0].station} · running`
      : `${zones.length} zones running`;
  return (
    <Card
      padded
      style={{
        border: "1px solid var(--solar)",
        background: "var(--solar-wash, var(--surface-2))",
        boxShadow: "0 0 0 1px var(--solar) inset, 0 6px 24px -12px var(--solar)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <StatusDot tone="solar" live />
        <div style={{ flex: 1, minWidth: 160 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: "var(--solar)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Icon name="droplets" size={16} />
            Watering now — {names}
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-2)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {sub}
          </div>
        </div>
        {isAdmin && (
          <Button
            size="sm"
            variant="danger"
            loading={busy}
            onClick={onStop}
          >
            Stop
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---- Forecast strip (outlook + bypass rules + per-day weather) --------------

const RAIN_MM_OPTIONS = ["2", "3", "5", "8", "10", "15"];
const RAIN_PROB_OPTIONS = ["40", "50", "60", "70", "80"];

/** A weather glyph for the day, derived from rain likelihood then cloud cover. */
function dayWeatherIcon(d: IrrigationDailyOutlook): {
  name: string;
  color: string;
} {
  if (d.precipMm >= 1 || d.precipProbabilityPct >= 50)
    return { name: "cloud-rain", color: "var(--battery)" };
  if (d.cloudCoverPct >= 70) return { name: "cloud", color: "var(--text-2)" };
  if (d.cloudCoverPct >= 30) return { name: "cloud-sun", color: "var(--solar)" };
  return { name: "sun", color: "var(--solar)" };
}

function ForecastStrip({
  data,
  wide,
  isAdmin,
  onBypassChange,
}: {
  data: IrrigationPlanResponse;
  wide: boolean;
  isAdmin: boolean;
  onBypassChange: (patch: {
    globalRainSkipMm?: number;
    rainSkipProbabilityPct?: number;
  }) => void;
}) {
  if (!data.outlook || data.outlook.length === 0) return null;
  const todayIso = localIso(new Date());
  return (
    <Card padded>
      {/* Header: title + the rain-bypass rules, on the same row */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Forecast</div>
          <div
            style={{ fontSize: 11.5, color: "var(--text-2)", marginTop: 2 }}
          >
            runs skip when rain ≥ {data.globalRainSkipMm}mm or chance ≥{" "}
            {data.rainSkipProbabilityPct}% · decided 2h before each run
          </div>
        </div>
        {isAdmin && (
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              alignItems: "flex-end",
            }}
          >
            <div style={{ width: 132 }}>
              <Select
                label="Skip if rain ≥"
                value={String(data.globalRainSkipMm)}
                onChange={(e) =>
                  onBypassChange({ globalRainSkipMm: Number(e.target.value) })
                }
                options={RAIN_MM_OPTIONS.map((v) => ({
                  value: v,
                  label: `${v} mm`,
                }))}
              />
            </div>
            <div style={{ width: 132 }}>
              <Select
                label="Skip if chance ≥"
                value={String(data.rainSkipProbabilityPct)}
                onChange={(e) =>
                  onBypassChange({
                    rainSkipProbabilityPct: Number(e.target.value),
                  })
                }
                options={RAIN_PROB_OPTIONS.map((v) => ({
                  value: v,
                  label: `${v}%`,
                }))}
              />
            </div>
          </div>
        )}
      </div>

      {/* Day cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: wide
            ? `repeat(${data.outlook.length}, 1fr)`
            : "repeat(3, 1fr)",
          gap: 8,
        }}
      >
        {data.outlook.map((d) => {
          const bypass =
            d.precipMm >= data.globalRainSkipMm ||
            d.precipProbabilityPct >= data.rainSkipProbabilityPct;
          const isToday = d.date === todayIso;
          const wx = dayWeatherIcon(d);
          return (
            <div
              key={d.date}
              style={{
                border: `1px solid ${bypass ? "var(--solar)" : "var(--border-1)"}`,
                borderRadius: "var(--radius-md)",
                padding: "10px 8px 9px",
                textAlign: "center",
                background: bypass
                  ? "var(--solar-wash, var(--surface-3))"
                  : "var(--surface-2)",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: isToday ? "var(--text-1)" : "var(--text-2)",
                }}
              >
                {isToday ? "Today" : weekdayShort(d.date)}
              </div>
              <div style={{ margin: "5px 0 2px", color: wx.color }}>
                <Icon name={wx.name} size={26} />
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 15,
                  fontWeight: 600,
                }}
              >
                {Math.round(d.tMaxC)}°
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  color: "var(--text-1)",
                  marginTop: 2,
                }}
              >
                {d.precipMm}mm · {d.precipProbabilityPct}%
              </div>

              {/* Sun hours · humidity · cloud cover */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 2,
                  marginTop: 8,
                  paddingTop: 7,
                  borderTop: "1px solid var(--border-1)",
                }}
              >
                <Metric icon="sun" value={`${d.sunshineHours}h`} />
                <Metric icon="droplet" value={`${d.humidityPct}%`} />
                <Metric icon="cloud" value={`${d.cloudCoverPct}%`} />
              </div>

              {bypass && (
                <div style={{ marginTop: 8 }}>
                  <Badge tone="solar">skip</Badge>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** One tiny icon-over-value forecast metric (sun hours / humidity / cloud). */
function Metric({ icon, value }: { icon: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        color: "var(--text-2)",
      }}
    >
      <Icon name={icon} size={12} />
      <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)" }}>
        {value}
      </span>
    </div>
  );
}

// ---- Weekly plan overview ---------------------------------------------------

function WeeklyPlanCard({
  zones,
  wide,
}: {
  zones: IrrigationPlanZone[];
  wide: boolean;
}) {
  const plan = useMemo(() => buildWeeklyPlan(zones), [zones]);
  const totalRuns = plan.reduce((s, d) => s + d.runs.length, 0);
  const today = new Date().getDay();

  return (
    <Card padded>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>Weekly plan</div>
        <div style={{ fontSize: 11.5, color: "var(--text-2)" }}>
          the full configured program (ceiling — weather trims down)
        </div>
      </div>

      {totalRuns === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--text-2)" }}>
          No app-managed watering times scheduled yet. Open a zone to add one.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: wide ? "repeat(7, 1fr)" : "1fr",
            gap: wide ? 8 : 6,
          }}
        >
          {plan.map((d) => {
            const isToday = d.weekday === today;
            return (
              <div
                key={d.weekday}
                style={{
                  border: `1px solid ${isToday ? "var(--accent)" : "var(--border-1)"}`,
                  borderRadius: "var(--radius-md)",
                  background: "var(--surface-2)",
                  padding: wide ? "8px 8px 10px" : "8px 10px",
                  minHeight: wide ? 96 : undefined,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 700,
                      color: isToday ? "var(--accent)" : "var(--text-1)",
                    }}
                  >
                    {DOW[d.weekday]}
                    {isToday ? " · today" : ""}
                  </span>
                  {d.runs.length > 0 && (
                    <span
                      style={{
                        fontSize: 10.5,
                        color: "var(--text-2)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {d.totalMin}m
                    </span>
                  )}
                </div>
                {d.runs.length === 0 ? (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-2)",
                      opacity: 0.6,
                    }}
                  >
                    —
                  </div>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    {d.runs.map((r, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          gap: 6,
                          fontSize: 11,
                          alignItems: "baseline",
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            color: "var(--text-1)",
                            flex: "none",
                          }}
                        >
                          {r.startTime}
                        </span>
                        <span
                          style={{
                            color: "var(--text-2)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            minWidth: 0,
                            flex: 1,
                          }}
                        >
                          {r.zoneName}
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            color: "var(--text-2)",
                            flex: "none",
                          }}
                        >
                          {r.durationMin}m
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---- Activity feed (unified irrigation events) ------------------------------

function ActivityFeed({ onViewAll }: { onViewAll: () => void }) {
  const { data } = usePolling(
    () => api.events.list({ category: ["irrigation"], limit: 12 }),
    20_000,
  );
  const events: EnergyEvent[] = data?.events ?? [];

  return (
    <Card padded>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>Activity</div>
        <Button size="sm" variant="ghost" onClick={onViewAll}>
          View all
        </Button>
      </div>
      {events.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-2)" }}>
          No irrigation events yet. Runs, skips, and sessions appear here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {events.map((e) => (
            <div
              key={e.id}
              style={{
                display: "flex",
                gap: 8,
                fontSize: 11.5,
                alignItems: "baseline",
              }}
            >
              <span
                style={{
                  opacity: 0.6,
                  flex: "none",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {new Date(e.ts).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  flex: "none",
                  alignSelf: "center",
                  background: severityColor(e.severity),
                }}
              />
              <span
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: e.ok === false ? "var(--grid)" : "var(--text-1)",
                }}
                title={e.detail ?? e.summary}
              >
                {e.summary}
                {e.detail ? (
                  <span style={{ color: "var(--text-2)" }}> · {e.detail}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function severityColor(sev: EnergyEvent["severity"]): string {
  switch (sev) {
    case "critical":
    case "high":
      return "var(--grid)";
    case "medium":
      return "var(--solar)";
    default:
      return "var(--text-2)";
  }
}

// ---- Water-now modal (duration slider) --------------------------------------

function WaterNowModal({
  zone,
  onClose,
  onConfirm,
}: {
  zone: IrrigationPlanZone;
  onClose: () => void;
  onConfirm: (mins: number) => Promise<void>;
}) {
  const [mins, setMins] = useState(WATER_NOW_DEFAULT_MIN);
  const [busy, setBusy] = useState(false);
  const liters = Math.round(mins * zone.flowLpm);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Water ${zone.name}`}
      subtitle={`Station ${zone.station} · manual run`}
      tone="solar"
    >
      <div style={{ padding: "4px 0 2px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "center",
            gap: 6,
            marginBottom: 12,
          }}
        >
          <span
            style={{
              fontSize: 40,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
            }}
          >
            {mins}
          </span>
          <span style={{ fontSize: 15, color: "var(--text-2)" }}>min</span>
          <span
            style={{
              fontSize: 13,
              color: "var(--text-2)",
              fontFamily: "var(--font-mono)",
              marginLeft: 8,
            }}
          >
            ≈{liters}L
          </span>
        </div>
        <Slider
          value={mins}
          min={1}
          max={60}
          step={1}
          onChange={(v) => setMins(v)}
          showValue={false}
        />
      </div>
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
          loading={busy}
          onClick={() =>
            void (async () => {
              setBusy(true);
              try {
                await onConfirm(mins);
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          Water {mins}m
        </Button>
      </div>
    </Modal>
  );
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
  const willSkip = zone.nextRunSkip?.decision === "skip";
  return (
    <Card
      style={{
        overflow: "hidden",
        padding: 0,
        ...(zone.active
          ? {
              border: "1px solid var(--solar)",
              boxShadow:
                "0 0 0 1px var(--solar) inset, 0 6px 22px -12px var(--solar)",
            }
          : {}),
      }}
    >
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
          <span
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 9px 3px 8px",
              borderRadius: 999,
              background: "var(--surface-1, rgba(0,0,0,0.55))",
              border: "1px solid var(--solar)",
            }}
          >
            <StatusDot tone="solar" live />
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "var(--solar)",
              }}
            >
              Watering
            </span>
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

        {/* Next-run rain-bypass note */}
        {willSkip && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 8,
              fontSize: 11,
              color: "var(--solar)",
            }}
          >
            <Icon name="cloud-rain" size={13} />
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              Next run skipped — {zone.nextRunSkip?.reason}
            </span>
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
  const [uploading, setUploading] = useState(false);
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
    setUploading(true);
    try {
      const normalized = await normalizePhoto(file);
      await api.irrigation.uploadPhoto(zone.zoneId, normalized);
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Photo upload failed");
    } finally {
      setUploading(false);
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
              accept="image/*"
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
                loading={uploading}
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

// ---- helpers ----------------------------------------------------------------

function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function weekdayShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return DOW[d.getDay()];
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
