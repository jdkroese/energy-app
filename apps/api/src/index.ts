import express, { type Request, type Response } from "express";
import { config } from "./config";
import * as sonnen from "./connectors/sonnen";
import * as tesla from "./connectors/tesla";
import { getLive } from "./routes/live";
import { getBatteries } from "./routes/batteries";
import { getHistory } from "./routes/history";
import { getHistoryDay } from "./routes/history-day";
import {
  getAlerts,
  setChannel,
  setRule,
  setAlertStatus,
} from "./routes/alerts";
import {
  getSettings,
  setWhatsAppNumber,
  getVoltageMonitor,
  setVoltageMonitor,
  getEventsConfig,
  setEventsConfig,
} from "./routes/settings";
import {
  listEvents,
  getEvent,
  setEventStatus,
  exportEvents,
} from "./routes/events";
import {
  warmEventRingFromDisk,
  setEventForwarder,
  type EnergyEvent,
} from "./events";
import { getVoltageHistory } from "./routes/voltage-history";
import { getPlan } from "./routes/brain";
import {
  getScenarios,
  applyScenario,
  saveScenario,
  previewScenario,
  type PreviewInput,
} from "./routes/scenarios";
import { getVapidPublic, subscribe } from "./routes/push";
import {
  getStatus as getControlStatus,
  setArm,
  command as controlCommand,
  applyScenarioToDevices,
  setBatteryPriority,
  setSoakExport,
  getArbitrageLog,
} from "./routes/control";
import { startCoordinator } from "./control/coordinator";
import { startSolarModelScheduler } from "./solar-model";
import {
  startClimateCoordinator,
  stopClimateCoordinator,
  stopSurplusStartedUnits,
} from "./control/climate-coordinator";
import type { Lever } from "./control/guardrails";
import type { ClimateLever } from "./control/climate-execute";
import {
  getDevices,
  getDevice,
  commandDevice,
  bulkCommand,
  releaseDevice,
  getDevicesStatus,
  setDevicesArm,
  setDeviceSettings,
  getIntegration,
  setIntegration,
  disconnectIntegration,
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  listAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
} from "./routes/devices";
import {
  getIntegrationsConfig,
  testSonnen,
  setSonnen,
  setWeather,
  testAirzone,
  setAirzone,
  testTesla,
  setTeslaSite,
  reauthTesla,
} from "./routes/integrations-config";
import {
  getLights,
  getLight,
  commandLight,
  bulkCommandLights,
  renameLight,
  getTuyaIntegration,
  setTuyaIntegration,
  disconnectTuyaIntegration,
  listScenes,
  createScene,
  updateScene,
  deleteScene,
  applyScene,
  favoriteScene,
  listLightSchedules,
  createLightSchedule,
  updateLightSchedule,
  deleteLightSchedule,
} from "./routes/lights";
import { startLightCoordinator } from "./control/light-coordinator";
import { startRadioCoordinator } from "./control/radio-coordinator";
import { startDeviceScheduleCoordinator } from "./control/device-schedule-coordinator";
import { startControllerCoordinator } from "./control/controller-coordinator";
import { startBreakerMetering } from "./control/breaker-metering";
import { startEnergyHistory } from "./control/energy-history";
import { runEnergyBackfill } from "./control/energy-backfill";
import { getBreakerUsage, getUsageSummary } from "./routes/breaker-usage";
import {
  parseUpload,
  postParse,
  postSave,
  getList as getInvoicesList,
  getDetail as getInvoiceDetail,
  getPdf as getInvoicePdf,
  deleteInvoice,
} from "./routes/invoices";
import type { LightLever } from "./connectors/tuya-lights";
import {
  getBlinds,
  getBlind,
  commandBlind,
  bulkCommandBlinds,
} from "./routes/blinds";
import {
  getIrrigation,
  getIrrigationZone,
  commandIrrigation,
  setIrrigationSettings,
  getRainbirdIntegration,
  testRainbird,
  setRainbird,
  disconnectRainbird,
  getIrrigationPlan,
  setIrrigationMode,
  setIrrigationGlobal,
  setIrrigationZone,
  deleteIrrigationZone,
  attachZonePhoto,
  getZonePhoto,
} from "./routes/irrigation";
import type { IrrigationLever } from "./control/irrigation-execute";
import { startIrrigationCoordinator } from "./control/irrigation-coordinator";
import {
  getDiscovered,
  ignoreDiscovered,
  keepDiscovered,
  setupDevice,
  unsetupDevice,
  renameConfiguredDevice,
  getConfigured,
  getDeviceDiagnostics,
  testDeviceCommand,
  listCustomTypes,
  createCustomType,
  commandGeneric,
} from "./routes/discovered";
import type { BlindLever } from "./connectors/tuya-blinds";
import {
  getRooms,
  createRoom,
  updateRoom,
  deleteRoom,
  assignDeviceRoom,
  roomAllOff,
} from "./routes/rooms";
import {
  getSpeakers,
  setSpeakerVolume,
  testSpeaker,
  postAlarmTrigger,
  postAlarmStop,
  getAlarmStatusRoute,
  getAlarmConfig,
  setAlarmConfig,
  getSonosIntegration,
  setSonosIntegration,
  rescanSonos,
} from "./routes/alarm";
import {
  searchRadio,
  listFavorites,
  createFavorite,
  updateFavorite,
  deleteFavorite,
  getSonosFavorites,
  playRadio,
  stopRadio,
  nowPlaying as radioNowPlaying,
  listSchedules as listRadioSchedules,
  createSchedule as createRadioSchedule,
  updateSchedule as updateRadioSchedule,
  deleteSchedule as deleteRadioSchedule,
} from "./routes/radio";
import { serveAlarmClip, startMediaLanListener } from "./routes/media";
import { resumeAlarm } from "./control/alarm";
import * as notify from "./notify";
import { startAlertLoop } from "./alert-loop";
import { authRouter, provisionKiosk } from "./routes/auth";
import {
  listHomeScenes,
  createHomeScene,
  updateHomeScene,
  deleteHomeScene,
  applyHomeScene,
  favoriteHomeScene,
} from "./routes/home-scenes";
import {
  listSceneControllers,
  saveSceneController,
} from "./routes/scene-controllers";
import {
  requireAuth,
  requireAdmin,
  requireKioskOrAdmin,
} from "./auth/middleware";
import { bootstrapAdmin } from "./auth/users";
import multer from "multer";
import * as store from "./store";
import type {
  ScenarioDef,
  AlertStatus,
  ControlDevice,
  ControlMode,
} from "./store";

const app = express();
// Memory-storage upload for irrigation garden photos (one image per zone; 8MB cap — the
// route validates the actual mime/size). Photos are stored on disk, never sent to the box.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});
// Global JSON body parser with the default ~100KB cap. The invoice-save route carries
// the original PDF as base64 (well over that), so it is EXCLUDED here and gets its own
// higher-limit parser at its mount — keeping the tight default for every other route.
const globalJson = express.json();
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/api/invoices") return next();
  return globalJson(req, res, next);
});

// --- PUBLIC routes (no session required): /api/health and /api/auth/* only ---
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "energy-api",
    env: config.env,
    time: new Date().toISOString(),
  });
});
app.use("/api/auth", authRouter);

// Alarm siren clip — served UN-AUTHED so the Sonos speakers (which fetch it over the LAN
// by URL during PlayNotification) can reach it. It's just a static, royalty-free siren
// tone — no sensitive data — and the trigger/stop endpoints below are still admin-gated.
app.get("/api/media/alarm.mp3", serveAlarmClip);
app.get("/api/media/alarm.wav", serveAlarmClip);

// --- Everything below this line requires a valid session ---
app.use(requireAuth);

const wrap =
  (fn: (req: Request) => Promise<unknown> | unknown) =>
  async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      const err = e as Error & { code?: string };
      const isInput = err.code === "BAD_INPUT";
      res
        .status(isInput ? 400 : 502)
        .json({ error: err.message, code: err.code ?? "UPSTREAM" });
    }
  };

// Individual connectors (handy while developing).
app.get(
  "/api/sonnen/status",
  wrap(() => sonnen.getStatus()),
);
app.get(
  "/api/tesla/live",
  wrap(() => tesla.getLiveStatus()),
);

// Normalized frontend contract.
app.get(
  "/api/live",
  wrap(() => getLive()),
);
app.get(
  "/api/batteries",
  wrap(() => getBatteries()),
);

app.get(
  "/api/history",
  wrap((req) => {
    const range = String(req.query.range ?? "day");
    const valid = ["hour", "day", "week", "month", "year"] as const;
    const r = (valid as readonly string[]).includes(range)
      ? (range as (typeof valid)[number])
      : "day";
    const offset = Number(req.query.offset ?? 0);
    return getHistory(r, Number.isFinite(offset) ? offset : 0);
  }),
);

// Live day chart: 5-min measured + forecast for a day (offset 0=today, -1=…).
app.get(
  "/api/history/day",
  wrap((req) => {
    const offset = Number(req.query.offset ?? 0);
    return getHistoryDay(Number.isFinite(offset) ? offset : 0);
  }),
);

// ---- Alerts ----
app.get(
  "/api/alerts",
  wrap(() => getAlerts()),
);
app.patch(
  "/api/alerts/channels",
  wrap((req) => {
    const { type, enabled } = (req.body ?? {}) as {
      type?: string;
      enabled?: boolean;
    };
    if (type !== "whatsapp" && type !== "push" && type !== "email") {
      const e = new Error("type must be whatsapp|push|email") as Error & {
        code?: string;
      };
      e.code = "BAD_INPUT";
      throw e;
    }
    return setChannel(type, Boolean(enabled));
  }),
);
app.patch(
  "/api/alerts/rules/:id",
  wrap((req) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    return setRule(String(req.params.id), Boolean(enabled));
  }),
);
app.post(
  "/api/alerts/:id/ack",
  wrap((req) => setAlertStatus(String(req.params.id), "ack" as AlertStatus)),
);
app.post(
  "/api/alerts/:id/resolve",
  wrap((req) =>
    setAlertStatus(String(req.params.id), "resolved" as AlertStatus),
  ),
);

// ---- Events (unified Event Viewer — read + ack/resolve/export; docs/37) ----
// Literal sub-paths registered BEFORE /:id so they aren't captured as an :id.
app.get(
  "/api/events/export",
  (req: Request, res: Response) => {
    try {
      exportEvents(req, res);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  },
);
app.get(
  "/api/events",
  wrap((req) => listEvents(req)),
);
app.post(
  "/api/events/:id/ack",
  wrap((req) => setEventStatus(String(req.params.id), "ack")),
);
app.post(
  "/api/events/:id/resolve",
  wrap((req) => setEventStatus(String(req.params.id), "resolved")),
);
app.get(
  "/api/events/:id",
  wrap((req) => getEvent(req)),
);

// ---- Settings ----
app.get(
  "/api/settings",
  wrap(() => getSettings()),
);
// Event-monitor thresholds (high-load / high-current) — read any-authed; PATCH follows
// the alert-config pattern (not admin-gated, like voltage-monitor beside it).
app.get(
  "/api/settings/events-config",
  wrap(() => getEventsConfig()),
);
app.patch(
  "/api/settings/events-config",
  wrap((req) => setEventsConfig(req.body)),
);
app.put(
  "/api/settings/whatsapp",
  wrap((req) => setWhatsAppNumber((req.body ?? {}).number)),
);
// Grid-voltage band monitor (reads any-authed; PATCH follows the alert-config pattern —
// not admin-gated, like /api/alerts/rules + /api/alerts/channels it sits beside).
app.get(
  "/api/settings/voltage-monitor",
  wrap(() => getVoltageMonitor()),
);
app.patch(
  "/api/settings/voltage-monitor",
  wrap((req) => setVoltageMonitor(req.body)),
);

// 48h grid-voltage history (5-min buckets) — the Live tile's chart overlay.
app.get(
  "/api/voltage/history",
  wrap(() => getVoltageHistory()),
);

// ---- Brain (shadow / read-only) ----
app.get(
  "/api/brain/plan",
  wrap(() => getPlan()),
);

// ---- Scenarios ----
app.get(
  "/api/scenarios",
  wrap(() => getScenarios()),
);
app.post(
  "/api/scenarios/preview",
  wrap((req) => previewScenario((req.body ?? {}) as PreviewInput)),
);
app.post(
  "/api/scenarios/:id/apply",
  wrap((req) => applyScenario(String(req.params.id))),
);
app.put(
  "/api/scenarios/:id",
  wrap((req) => {
    const body = (req.body ?? {}) as {
      def?: Partial<ScenarioDef>;
    } & Partial<ScenarioDef>;
    // Accept either {def:{...}} or the def fields at the top level.
    const def = (body.def ?? body) as Partial<ScenarioDef>;
    return saveScenario(String(req.params.id), def);
  }),
);

// ---- Web Push ----
app.get(
  "/api/push/vapid-public",
  wrap(() => getVapidPublic()),
);
app.post(
  "/api/push/subscribe",
  wrap((req) => subscribe((req.body ?? {}) as never)),
);

// ---- Battery control (REAL device writes) ----
// status is read-only (any authed user); arm/command/apply are admin-gated.
app.get(
  "/api/control/status",
  wrap(() => getControlStatus()),
);
app.get(
  "/api/control/arbitrage-log",
  wrap((req) => {
    const raw = req.query.limit;
    const limit = typeof raw === "string" ? Number(raw) : undefined;
    return getArbitrageLog(limit);
  }),
);
app.post(
  "/api/control/arm",
  requireAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { armed?: boolean; mode?: string };
    if (typeof body.armed !== "boolean") {
      const e = new Error("armed (boolean) required") as Error & {
        code?: string;
      };
      e.code = "BAD_INPUT";
      throw e;
    }
    return setArm(body.armed, body.mode as ControlMode | undefined);
  }),
);
app.post(
  "/api/control/command",
  requireAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as {
      device?: string;
      lever?: string;
      value?: unknown;
    };
    return controlCommand(
      body.device as ControlDevice,
      body.lever as Lever,
      body.value,
    );
  }),
);
app.post(
  "/api/control/apply-scenario",
  requireAdmin,
  wrap(() => applyScenarioToDevices()),
);
app.put(
  "/api/control/battery-priority/:rule",
  requireAdmin,
  wrap((req) => {
    const rule = String(req.params.rule) as
      | "dischargeSonnenFirst"
      | "chargeTeslaFirst";
    return setBatteryPriority(rule, (req.body ?? {}) as never);
  }),
);
app.put(
  "/api/control/soak-export",
  requireAdmin,
  wrap((req) => setSoakExport((req.body ?? {}) as never)),
);

// ---- Devices / Climate (REAL device writes; reads are any-authed) ----
app.get(
  "/api/devices",
  wrap(() => getDevices()),
);
app.get(
  "/api/devices/status",
  wrap(() => getDevicesStatus()),
);
// Onboarding inbox: discovered (not-yet-set-up) Tuya devices + triage. Registered
// BEFORE /api/devices/:id so the literal path isn't captured as an :id.
app.get(
  "/api/devices/discovered",
  wrap(() => getDiscovered()),
);
// Set-up (configured) generic Tuya devices + custom type registry. Literal paths
// registered BEFORE /api/devices/:id so they aren't captured as an :id.
app.get(
  "/api/devices/configured",
  wrap(() => getConfigured()),
);
app.get(
  "/api/devices/custom-types",
  wrap(() => listCustomTypes()),
);
app.post(
  "/api/devices/custom-types",
  requireAdmin,
  wrap((req) => createCustomType(req.body)),
);
app.post(
  "/api/devices/:id/ignore",
  requireAdmin,
  wrap((req) => ignoreDiscovered(String(req.params.id))),
);
app.post(
  "/api/devices/:id/keep",
  requireAdmin,
  wrap((req) => keepDiscovered(String(req.params.id))),
);
app.post(
  "/api/devices/:id/setup",
  requireAdmin,
  wrap((req) => setupDevice(String(req.params.id), req.body)),
);
app.post(
  "/api/devices/:id/unsetup",
  requireAdmin,
  wrap((req) => unsetupDevice(String(req.params.id))),
);
app.put(
  "/api/devices/:id/name",
  requireAdmin,
  wrap((req) => renameConfiguredDevice(String(req.params.id), req.body)),
);
// Diagnostics (identity + datapoint table) — on-demand read; registered before :id.
app.get(
  "/api/devices/:id/diagnostics",
  wrap((req) => getDeviceDiagnostics(String(req.params.id))),
);
app.post(
  "/api/devices/:id/diagnostics/test",
  requireAdmin,
  wrap((req) => testDeviceCommand(String(req.params.id), req.body)),
);
app.get(
  "/api/devices/:id",
  wrap((req) => getDevice(String(req.params.id))),
);
app.post(
  "/api/devices/arm",
  requireAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { armed?: boolean; mode?: string };
    if (typeof body.armed !== "boolean") {
      const e = new Error("armed (boolean) required") as Error & {
        code?: string;
      };
      e.code = "BAD_INPUT";
      throw e;
    }
    return setDevicesArm(body.armed, body.mode as ControlMode | undefined);
  }),
);
app.post(
  "/api/devices/bulk-command",
  requireKioskOrAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as {
      ids?: string[];
      lever?: string;
      value?: unknown;
    };
    return bulkCommand(body.ids ?? [], body.lever as ClimateLever, body.value);
  }),
);
app.post(
  "/api/devices/:id/command",
  requireKioskOrAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as {
      lever?: string;
      value?: unknown;
      dp?: string;
      kind?: string;
    };
    // A capability-oriented body ({ dp, kind, value }) drives a generic (set-up) Tuya
    // device; the climate fleet still uses the lever-oriented body ({ lever, value }).
    if (typeof body.dp === "string" && body.dp) {
      return commandGeneric(String(req.params.id), {
        dp: body.dp,
        kind: body.kind as never,
        value: body.value,
      });
    }
    return commandDevice(
      String(req.params.id),
      body.lever as ClimateLever,
      body.value,
    );
  }),
);
app.put(
  "/api/devices/:id/settings",
  requireAdmin,
  wrap((req) =>
    setDeviceSettings(String(req.params.id), (req.body ?? {}) as never),
  ),
);
app.post(
  "/api/devices/:id/release",
  requireAdmin,
  wrap((req) => releaseDevice(String(req.params.id))),
);
// Assign / clear a device's room (cross-cutting Rooms model). Admin-gated.
app.post(
  "/api/devices/:id/room",
  requireAdmin,
  wrap((req) => assignDeviceRoom(String(req.params.id), req.body)),
);

// ---- AC Cloud integration ----
app.get(
  "/api/integrations/intesis",
  wrap(() => getIntegration()),
);
app.post(
  "/api/integrations/intesis",
  requireAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    return setIntegration(body.username, body.password);
  }),
);
app.delete(
  "/api/integrations/intesis",
  requireAdmin,
  wrap(() => disconnectIntegration()),
);

// ---- Lights (Tuya) — reads any-authed; commands admin-gated ----
app.get(
  "/api/lights",
  wrap(() => getLights()),
);

// Scenes + schedules — registered BEFORE /api/lights/:id so the literal paths
// aren't captured as an :id.
app.get(
  "/api/lights/scenes",
  wrap(() => listScenes()),
);
app.post(
  "/api/lights/scenes",
  requireAdmin,
  wrap((req) => createScene((req.body ?? {}) as never)),
);
app.put(
  "/api/lights/scenes/:id",
  requireAdmin,
  wrap((req) => updateScene(String(req.params.id), (req.body ?? {}) as never)),
);
app.delete(
  "/api/lights/scenes/:id",
  requireAdmin,
  wrap((req) => deleteScene(String(req.params.id))),
);
app.post(
  "/api/lights/scenes/:id/apply",
  requireKioskOrAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { on?: boolean };
    return applyScene(String(req.params.id), body.on !== false);
  }),
);
// Star/un-star — kiosk-or-admin (same gate as apply), a lightweight favorite toggle.
app.post(
  "/api/lights/scenes/:id/favorite",
  requireKioskOrAdmin,
  wrap((req) =>
    favoriteScene(
      String(req.params.id),
      (req.body as { favorite?: unknown })?.favorite !== false,
    ),
  ),
);
app.get(
  "/api/lights/schedules",
  wrap(() => listLightSchedules()),
);
app.post(
  "/api/lights/schedules",
  requireAdmin,
  wrap((req) => createLightSchedule((req.body ?? {}) as never)),
);
app.put(
  "/api/lights/schedules/:id",
  requireAdmin,
  wrap((req) =>
    updateLightSchedule(String(req.params.id), (req.body ?? {}) as never),
  ),
);
app.delete(
  "/api/lights/schedules/:id",
  requireAdmin,
  wrap((req) => deleteLightSchedule(String(req.params.id))),
);

app.get(
  "/api/lights/:id",
  wrap((req) => getLight(String(req.params.id))),
);
app.post(
  "/api/lights/bulk-command",
  requireKioskOrAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as {
      ids?: string[];
      lever?: string;
      value?: unknown;
    };
    return bulkCommandLights(
      body.ids ?? [],
      body.lever as LightLever,
      body.value,
    );
  }),
);
app.post(
  "/api/lights/:id/command",
  requireKioskOrAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { lever?: string; value?: unknown };
    return commandLight(
      String(req.params.id),
      body.lever as LightLever,
      body.value,
    );
  }),
);
app.put(
  "/api/lights/:id/name",
  requireAdmin,
  wrap((req) => renameLight(String(req.params.id), (req.body ?? {}).name)),
);

// ---- Blinds / curtains (Tuya) — reads any-authed; commands admin-gated ----
app.get(
  "/api/blinds",
  wrap(() => getBlinds()),
);
app.get(
  "/api/blinds/:id",
  wrap((req) => getBlind(String(req.params.id))),
);
app.post(
  "/api/blinds/bulk-command",
  requireKioskOrAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as {
      ids?: string[];
      lever?: string;
      value?: unknown;
    };
    return bulkCommandBlinds(
      body.ids ?? [],
      body.lever as BlindLever,
      body.value,
    );
  }),
);
app.post(
  "/api/blinds/:id/command",
  requireKioskOrAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { lever?: string; value?: unknown };
    return commandBlind(
      String(req.params.id),
      body.lever as BlindLever,
      body.value,
    );
  }),
);

// ---- Circuit-breaker usage metering (read-only) ----
// Per-breaker energy/usage time-series from the metering SQLite store. Reads only
// (no admin gate, consistent with other read routes); returns an "unavailable"
// payload when metering is disabled. The literal /usage/summary path is registered
// BEFORE /:id/usage so it isn't captured as an :id.
app.get(
  "/api/breakers/usage/summary",
  wrap((req) => getUsageSummary(req.query.period)),
);
app.get(
  "/api/breakers/:id/usage",
  wrap((req) =>
    getBreakerUsage(String(req.params.id), {
      from: req.query.from,
      to: req.query.to,
      granularity: req.query.granularity,
    }),
  ),
);

// ---- Invoice vault + reconciliation (Phase 1; additive + READ-ONLY) ----
// Upload/parse/save/delete are admin-gated (mutating); list/detail/pdf are any-authed
// reads. The parse route takes a multipart PDF (multer memory storage). These handlers
// send their own responses, so they are NOT wrapped in `wrap`. Nothing here touches any
// control/coordinator/guardrail/armed code path.
app.post("/api/invoices/parse", requireAdmin, parseUpload, (req, res) => {
  void postParse(req, res);
});
// The save body carries the original PDF as base64 (~270KB → larger encoded), which
// exceeds express.json()'s default ~100KB cap. Use a dedicated higher-limit JSON parser
// on THIS route only so the global default stays tight for every other endpoint.
app.post(
  "/api/invoices",
  requireAdmin,
  express.json({ limit: "20mb" }),
  postSave,
);
app.get("/api/invoices", getInvoicesList);
app.get("/api/invoices/:id", getInvoiceDetail);
app.get("/api/invoices/:id/pdf", getInvoicePdf);
app.delete("/api/invoices/:id", requireAdmin, deleteInvoice);

// ---- Sonos speakers + house alarm (Phase 1) ----
// Reads any-authed; volume/test/alarm-trigger/stop + integration config admin-gated.
app.get(
  "/api/speakers",
  wrap(() => getSpeakers()),
);
app.post(
  "/api/speakers/:id/volume",
  requireKioskOrAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as { pct?: unknown };
    return setSpeakerVolume(String(req.params.id), b.pct);
  }),
);
app.post(
  "/api/speakers/:id/test",
  requireAdmin,
  wrap((req) => testSpeaker(String(req.params.id), req)),
);

app.get(
  "/api/alarm/status",
  wrap(() => getAlarmStatusRoute()),
);
app.post(
  "/api/alarm/trigger",
  requireKioskOrAdmin,
  wrap((req) => postAlarmTrigger(req.body, req)),
);
app.post(
  "/api/alarm/stop",
  requireKioskOrAdmin,
  wrap(() => postAlarmStop()),
);
app.get(
  "/api/alarm/config",
  wrap(() => getAlarmConfig()),
);
app.put(
  "/api/alarm/config",
  requireAdmin,
  wrap((req) => setAlarmConfig(req.body)),
);

app.get(
  "/api/integrations/sonos",
  wrap(() => getSonosIntegration()),
);
app.put(
  "/api/integrations/sonos",
  requireAdmin,
  wrap((req) => setSonosIntegration(req.body)),
);
app.post(
  "/api/integrations/sonos/rescan",
  requireAdmin,
  wrap(() => rescanSonos()),
);

// ---- Sonos internet radio (favourites + play/stop + schedules) ----
// Reads any-authed; play/stop, favourite + schedule writes are admin-gated.
app.get(
  "/api/radio/search",
  wrap((req) => searchRadio(req.query.q, req.query.limit)),
);
app.get(
  "/api/radio/favorites",
  wrap(() => listFavorites()),
);
app.post(
  "/api/radio/favorites",
  requireAdmin,
  wrap((req) => createFavorite((req.body ?? {}) as never)),
);
app.put(
  "/api/radio/favorites/:id",
  requireAdmin,
  wrap((req) =>
    updateFavorite(String(req.params.id), (req.body ?? {}) as never),
  ),
);
app.delete(
  "/api/radio/favorites/:id",
  requireAdmin,
  wrap((req) => deleteFavorite(String(req.params.id))),
);
app.get(
  "/api/radio/sonos-favorites",
  wrap(() => getSonosFavorites()),
);
app.get(
  "/api/radio/now-playing",
  wrap(() => radioNowPlaying()),
);
app.post(
  "/api/radio/play",
  requireKioskOrAdmin,
  wrap((req) => playRadio(req.body)),
);
app.post(
  "/api/radio/stop",
  requireKioskOrAdmin,
  wrap((req) => stopRadio(req.body)),
);
app.get(
  "/api/radio/schedules",
  wrap(() => listRadioSchedules()),
);
app.post(
  "/api/radio/schedules",
  requireAdmin,
  wrap((req) => createRadioSchedule((req.body ?? {}) as never)),
);
app.put(
  "/api/radio/schedules/:id",
  requireAdmin,
  wrap((req) =>
    updateRadioSchedule(String(req.params.id), (req.body ?? {}) as never),
  ),
);
app.delete(
  "/api/radio/schedules/:id",
  requireAdmin,
  wrap((req) => deleteRadioSchedule(String(req.params.id))),
);

// ---- Tuya Cloud integration ----
app.get(
  "/api/integrations/tuya",
  wrap(() => getTuyaIntegration()),
);
app.post(
  "/api/integrations/tuya",
  requireAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as {
      region?: string;
      accessId?: string;
      accessSecret?: string;
    };
    return setTuyaIntegration(b.region, b.accessId, b.accessSecret);
  }),
);
app.delete(
  "/api/integrations/tuya",
  requireAdmin,
  wrap(() => disconnectTuyaIntegration()),
);

// ---- Configurable connections (Sonnen / Weather / Tesla) ----
app.get(
  "/api/integrations/config",
  wrap(() => getIntegrationsConfig()),
);
app.post(
  "/api/integrations/sonnen/test",
  requireAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as { host?: string; token?: string };
    return testSonnen(b.host, b.token);
  }),
);
app.put(
  "/api/integrations/sonnen",
  requireAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as { host?: string; token?: string };
    return setSonnen(b.host, b.token);
  }),
);
app.put(
  "/api/integrations/weather",
  requireAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as { lat?: number; lon?: number };
    return setWeather(b.lat, b.lon);
  }),
);
app.post(
  "/api/integrations/tesla/test",
  requireAdmin,
  wrap(() => testTesla()),
);
app.put(
  "/api/integrations/tesla",
  requireAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as { siteId?: string };
    return setTeslaSite(b.siteId);
  }),
);
app.post(
  "/api/integrations/tesla/reauth",
  requireAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as { refreshToken?: string };
    return reauthTesla(b.refreshToken);
  }),
);
// Read-only probe (any signed-in user) so the row shows live status like the others.
app.post(
  "/api/integrations/airzone/test",
  wrap((req) => {
    const b = (req.body ?? {}) as { host?: string };
    return testAirzone(b.host);
  }),
);
app.put(
  "/api/integrations/airzone",
  requireAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as { host?: string };
    return setAirzone(b.host);
  }),
);

// ---- Rain Bird irrigation ----
// Reads any-authed; commands + connect are admin-gated. Commands ALSO require the
// Devices layer to be ARMED (enforced in issueIrrigation) — no watering when disarmed.
app.get(
  "/api/irrigation",
  wrap(() => getIrrigation()),
);

// ---- Phase 2 smart-watering plan (literal sub-paths FIRST so the bare :id never eats them) ----
// Reads any-authed; plan writes (mode, global rules, zone config, photos) are admin-gated.
app.get(
  "/api/irrigation/plan",
  wrap(() => getIrrigationPlan()),
);
app.put(
  "/api/irrigation/mode",
  requireAdmin,
  wrap((req) =>
    setIrrigationMode((req.body ?? ({} as { mode?: unknown })).mode),
  ),
);
app.put(
  "/api/irrigation/settings",
  requireAdmin,
  wrap((req) => setIrrigationGlobal((req.body ?? {}) as never)),
);
app.put(
  "/api/irrigation/zones/:id",
  requireAdmin,
  wrap((req) =>
    setIrrigationZone(String(req.params.id), (req.body ?? {}) as never),
  ),
);
app.delete(
  "/api/irrigation/zones/:id",
  requireAdmin,
  wrap((req) => deleteIrrigationZone(String(req.params.id))),
);
// Photo upload (multipart, field "photo") — admin. The handler validates type/size + binds it.
app.post(
  "/api/irrigation/zones/:id/photo",
  requireAdmin,
  photoUpload.single("photo"),
  (req, res) => {
    void (async () => {
      try {
        const file = (
          req as unknown as { file?: { buffer: Buffer; mimetype: string } }
        ).file;
        if (!file) {
          res.status(400).json({ error: 'No photo uploaded (field "photo")' });
          return;
        }
        const out = attachZonePhoto(
          String(req.params.id),
          file.buffer,
          file.mimetype,
        );
        res.json(out);
      } catch (e) {
        const err = e as Error & { code?: string };
        res
          .status(err.code === "BAD_INPUT" ? 400 : 500)
          .json({ error: err.message });
      }
    })();
  },
);
// Serve a stored photo (any signed-in user). Opaque id; absent → 404.
app.get("/api/irrigation/photos/:photoId", (req, res) => {
  const got = getZonePhoto(String(req.params.photoId));
  if (!got) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", got.contentType);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(got.buf);
});

// Literal sub-paths registered before the bare :id so they aren't captured as an :id.
app.put(
  "/api/irrigation/:id/settings",
  requireAdmin,
  wrap((req) =>
    setIrrigationSettings(String(req.params.id), (req.body ?? {}) as never),
  ),
);
app.post(
  "/api/irrigation/:id/command",
  requireAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { lever?: string; value?: unknown };
    return commandIrrigation(
      String(req.params.id),
      body.lever as IrrigationLever,
      body.value,
    );
  }),
);
app.get(
  "/api/irrigation/:id",
  wrap((req) => getIrrigationZone(String(req.params.id))),
);
// Integration: read-only probe (any signed-in user) + admin connect/disconnect.
app.get(
  "/api/integrations/rainbird",
  wrap(() => getRainbirdIntegration()),
);
app.post(
  "/api/integrations/rainbird/test",
  wrap((req) => {
    const b = (req.body ?? {}) as { host?: string; password?: string };
    return testRainbird(b.host, b.password);
  }),
);
app.put(
  "/api/integrations/rainbird",
  requireAdmin,
  wrap((req) => {
    const b = (req.body ?? {}) as { host?: string; password?: string };
    return setRainbird(b.host, b.password);
  }),
);
app.delete(
  "/api/integrations/rainbird",
  requireAdmin,
  wrap(() => disconnectRainbird()),
);

// ---- Schedules CRUD (admin for writes) ----
app.get(
  "/api/schedules",
  wrap(() => listSchedules()),
);
app.post(
  "/api/schedules",
  requireAdmin,
  wrap((req) => createSchedule((req.body ?? {}) as never)),
);
app.put(
  "/api/schedules/:id",
  requireAdmin,
  wrap((req) =>
    updateSchedule(String(req.params.id), (req.body ?? {}) as never),
  ),
);
app.delete(
  "/api/schedules/:id",
  requireAdmin,
  wrap((req) => deleteSchedule(String(req.params.id))),
);

// ---- Automations CRUD (admin for writes) ----
app.get(
  "/api/automations",
  wrap(() => listAutomations()),
);
app.post(
  "/api/automations",
  requireAdmin,
  wrap((req) => createAutomation((req.body ?? {}) as never)),
);
app.put(
  "/api/automations/:id",
  requireAdmin,
  wrap((req) =>
    updateAutomation(String(req.params.id), (req.body ?? {}) as never),
  ),
);
app.delete(
  "/api/automations/:id",
  requireAdmin,
  wrap((req) => deleteAutomation(String(req.params.id))),
);

// ---- Rooms (cross-cutting) — reads any-authed; writes admin-gated ----
app.get(
  "/api/rooms",
  wrap(() => getRooms()),
);
app.post(
  "/api/rooms",
  requireAdmin,
  wrap((req) => createRoom(req.body)),
);
// Literal sub-path registered before the bare :id so it isn't shadowed.
app.post(
  "/api/rooms/:id/all-off",
  requireKioskOrAdmin,
  wrap((req) => roomAllOff(String(req.params.id), req.body)),
);
app.patch(
  "/api/rooms/:id",
  requireAdmin,
  wrap((req) => updateRoom(String(req.params.id), req.body)),
);
app.delete(
  "/api/rooms/:id",
  requireAdmin,
  wrap((req) => deleteRoom(String(req.params.id))),
);

// ---- Whole-home scenes (cross-domain) — reads any-authed; CRUD admin-gated; apply
// kiosk-or-admin (a wall tablet may trigger a scene, but not edit it) ----
app.get(
  "/api/home-scenes",
  wrap(() => listHomeScenes()),
);
app.post(
  "/api/home-scenes",
  requireAdmin,
  wrap((req) => createHomeScene((req.body ?? {}) as never)),
);
app.put(
  "/api/home-scenes/:id",
  requireAdmin,
  wrap((req) =>
    updateHomeScene(String(req.params.id), (req.body ?? {}) as never),
  ),
);
app.delete(
  "/api/home-scenes/:id",
  requireAdmin,
  wrap((req) => deleteHomeScene(String(req.params.id))),
);
app.post(
  "/api/home-scenes/:id/apply",
  requireKioskOrAdmin,
  wrap((req) => applyHomeScene(String(req.params.id))),
);
// Star/un-star — kiosk-or-admin, so the wall tablet can curate its own favorites.
app.post(
  "/api/home-scenes/:id/favorite",
  requireKioskOrAdmin,
  wrap((req) =>
    favoriteHomeScene(
      String(req.params.id),
      (req.body as { favorite?: unknown })?.favorite !== false,
    ),
  ),
);

// ---- Scene controllers (wireless scene switches) — list any-authed; save admin-gated.
// Each button binds to a whole-home scene; the controller-coordinator toggles on press.
app.get(
  "/api/scene-controllers",
  wrap(() => listSceneControllers()),
);
app.put(
  "/api/scene-controllers/:deviceId",
  requireAdmin,
  wrap((req) => saveSceneController(String(req.params.deviceId), req.body)),
);

// ---- Kiosk (wall-tablet) provisioning — admin swaps THIS browser's session to the
// limited kiosk role. provisionKiosk sends its own response (cookie + JSON), so it's
// NOT wrapped in `wrap`. ----
app.post("/api/kiosk/provision", requireAdmin, (req: Request, res: Response) =>
  provisionKiosk(req, res),
);

// Ensure VAPID keys exist on boot (generate + persist if missing).
try {
  notify.ensureVapid();
} catch (e) {
  console.error("[energy-api] VAPID init failed:", (e as Error).message);
}

// Seed the first admin + setup link if no users exist yet (no open self-signup).
try {
  bootstrapAdmin();
} catch (e) {
  console.error("[energy-api] auth bootstrap failed:", (e as Error).message);
}

// Warm the event ring from the durable JSONL tail so the timeline survives a restart.
warmEventRingFromDisk();

// Register the event → notify forwarder (docs/37 §3). A high/critical ACTIVE observation
// emitted through logEvent() (that isn't already fanned out by the alert loop, and isn't a
// log-only monitor with noNotify) is delivered over the enabled channels here. Returns the
// channels that fired. Best-effort; notify swallows its own failures.
setEventForwarder((ev: EnergyEvent) => {
  const channels = store.get().channels;
  const title = ev.summary;
  const body = ev.detail ?? ev.summary;
  const device = ev.device ?? "System";
  let fired = false;
  if (channels.push.enabled) {
    void notify.sendPush(title, body, { id: ev.id, severity: ev.severity, device });
    fired = true;
  }
  if (channels.whatsapp.enabled && channels.whatsapp.number) {
    void notify.sendWhatsApp(channels.whatsapp.number, `⚡ ${title}\n${body}\n(${device})`);
    fired = true;
  }
  if (channels.email.enabled && channels.email.address) {
    void notify.sendEmail(channels.email.address, `Power alert: ${title}`, `${title}\n${body}\n(${device})`);
    fired = true;
  }
  // `notified` marks that delivery fired (the model types it as TriggerSource[]).
  return fired ? (["threshold"] as EnergyEvent["notified"]) : undefined;
});

// Start the background alert loop (shadow/read-only — notifications only).
startAlertLoop();

// Start the battery-control coordinator. It self-gates on armed+auto, so it is
// INERT on boot (defaults are DISARMED / mode 'off') and commands nothing until
// an admin explicitly arms it in 'auto'.
startCoordinator();

// Start the climate coordinator. Like the battery coordinator it self-gates on
// devices.armed + mode==='auto', so it is INERT on boot (DISARMED / 'off') and
// writes nothing until an admin arms it AND an automation is enabled in 'auto'.
startClimateCoordinator();

// Start the light-schedule coordinator (edge-triggered; applies scenes/lights at
// their scheduled times). No arm gate — it only acts on enabled light schedules.
startLightCoordinator();

// Start the generic-device schedule coordinator (edge-triggered; turns configured
// switchable Tuya devices on/off at their scheduled window edges, optionally at a
// chosen fan speed/direction). No arm gate — matches the lights coordinator.
startDeviceScheduleCoordinator();

// Start the scene-controller coordinator (wireless scene switches). Every ~3s it reads
// each enabled controller's Tuya device logs and TOGGLES the whole-home scene bound to a
// button on single-click. Fires LIVE on press; gated only on the per-controller enabled
// flag (NOT battery-arm) — it touches no battery-control logic.
startControllerCoordinator();

// Start the Sonos radio-schedule coordinator (edge-triggered; plays a station on chosen
// speakers at its on-time and stops at its off-time). No arm gate — it only acts on enabled
// radio schedules and never touches the battery/climate control authority.
startRadioCoordinator();

// Start the Rain Bird irrigation coordinator (Phase 2 smart-watering brain). SHADOW-FIRST:
// it ships in mode 'off' and only actuates (suppression rain-delay refresh + zone firing)
// when irrigation.mode === 'live' AND the Devices layer is armed. In 'shadow' it computes +
// logs the plan but fires nothing. Dead-man's-switch: while healthy + live it holds a rolling
// 1-day rain-delay to suppress the controller's onboard program; if the mini/LAN fails the
// delay lapses (≤1 day) and the controller resumes on its own. Never opens a valve on boot.
startIrrigationCoordinator();

// Start circuit-breaker usage metering (additive + READ-ONLY: reads the Tuya
// fleet, writes its own SQLite store; no control authority). Fail-soft — if the
// native sqlite dep or the DB is unavailable it logs + disables metering and the
// API (incl. the armed control loop) is unaffected. Guarded so it can never throw
// into the boot path.
try {
  startBreakerMetering();
} catch (e) {
  console.error(
    "[energy-api] breaker metering init failed (metering disabled, API unaffected):",
    (e as Error).message,
  );
}

// Start the whole-house energy-history rollup/retention loop (additive + READ-ONLY:
// shares the same fail-soft SQLite store; no control authority). The 5m recorder is
// driven by the live-sample path (recordEnergySample). Then kick the one-time JSON
// import + Tesla calendar_history backfill in the BACKGROUND — idempotent, never
// blocks boot or the control loop. Both guarded so they can't throw into startup.
try {
  startEnergyHistory();
} catch (e) {
  console.error(
    "[energy-api] energy-history init failed (history disabled, API unaffected):",
    (e as Error).message,
  );
}
setTimeout(
  () =>
    void runEnergyBackfill().catch((e) =>
      console.error("[energy-backfill] run failed:", (e as Error).message),
    ),
  12_000,
);

// Resume a still-active house alarm after a restart (siren + light-blink). If the
// persisted duration already elapsed it stops + restores instead. No-op when idle.
setTimeout(
  () =>
    void resumeAlarm().catch((e) =>
      console.error("[alarm] resume failed:", (e as Error).message),
    ),
  4_000,
);

// Background 5-minute sampler for the Live day chart. getLive() records the live
// snapshot into history5m, so the day fills continuously even when no client is
// polling /api/live (otherwise the chart only has data while the app is open).
const SAMPLE_MS = 5 * 60 * 1000;
setTimeout(() => void getLive().catch(() => {}), 10_000); // one shortly after boot
setInterval(() => void getLive().catch(() => {}), SAMPLE_MS);

// Nightly (Madrid 00:10) the solar model folds the prior day's measured
// production into a per-month learned performance ratio, so genKwh predictions
// track the real roof over time. Read-only on history; no arm gate.
startSolarModelScheduler();

const server = app.listen(config.port, config.host, () => {
  console.log(
    `[energy-api] http://${config.host}:${config.port}  (env=${config.env})`,
  );
});

// The main API binds 127.0.0.1 behind nginx, so the Sonos speakers can't reach it directly
// to fetch the alarm siren. Start a dedicated LAN listener (0.0.0.0:MEDIA_PORT) that serves
// ONLY the un-authed siren clip — makes the alarm work over the LAN with zero config.
startMediaLanListener();

// Graceful shutdown: on SIGTERM/SIGINT, switch off any units the surplus rule
// started BEFORE we exit (while still armed, so issueClimate is permitted) — so a
// restart/deploy never strands rule-started cooling importing from the grid. The
// deploy sends SIGTERM (then a grace window) ahead of `launchctl kickstart -k`.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    `[energy-api] ${signal} — switching off rule-started cooling before exit`,
  );
  try {
    const n = await stopSurplusStartedUnits(
      "shutdown — stop rule-started cooling",
    );
    if (n > 0)
      console.log(`[energy-api] switched off ${n} rule-started AC unit(s)`);
  } catch (e) {
    console.error(
      "[energy-api] shutdown cleanup failed:",
      (e as Error).message,
    );
  }
  stopClimateCoordinator();
  server.close(() => process.exit(0));
  // Hard backstop if the socket close hangs past the daemon's grace window.
  setTimeout(() => process.exit(0), 8_000).unref();
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
