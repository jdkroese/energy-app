import express, { type Request, type Response } from 'express';
import { config } from './config';
import * as sonnen from './connectors/sonnen';
import * as tesla from './connectors/tesla';
import { getLive } from './routes/live';
import { getBatteries } from './routes/batteries';
import { getHistory } from './routes/history';
import { getHistoryDay } from './routes/history-day';
import {
  getAlerts,
  setChannel,
  setRule,
  setAlertStatus,
} from './routes/alerts';
import { getSettings, setWhatsAppNumber } from './routes/settings';
import { getPlan } from './routes/brain';
import {
  getScenarios,
  applyScenario,
  saveScenario,
  previewScenario,
  type PreviewInput,
} from './routes/scenarios';
import { getVapidPublic, subscribe } from './routes/push';
import {
  getStatus as getControlStatus,
  setArm,
  command as controlCommand,
  applyScenarioToDevices,
} from './routes/control';
import { startCoordinator } from './control/coordinator';
import { startClimateCoordinator } from './control/climate-coordinator';
import type { Lever } from './control/guardrails';
import type { ClimateLever } from './control/climate-execute';
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
} from './routes/devices';
import * as notify from './notify';
import { startAlertLoop } from './alert-loop';
import { authRouter } from './routes/auth';
import { requireAuth, requireAdmin } from './auth/middleware';
import { bootstrapAdmin } from './auth/users';
import type { ScenarioDef, AlertStatus, ControlDevice, ControlMode } from './store';

const app = express();
app.use(express.json());

// --- PUBLIC routes (no session required): /api/health and /api/auth/* only ---
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'energy-api', env: config.env, time: new Date().toISOString() });
});
app.use('/api/auth', authRouter);

// --- Everything below this line requires a valid session ---
app.use(requireAuth);

const wrap =
  (fn: (req: Request) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      const err = e as Error & { code?: string };
      const isInput = err.code === 'BAD_INPUT';
      res
        .status(isInput ? 400 : 502)
        .json({ error: err.message, code: err.code ?? 'UPSTREAM' });
    }
  };

// Individual connectors (handy while developing).
app.get('/api/sonnen/status', wrap(() => sonnen.getStatus()));
app.get('/api/tesla/live', wrap(() => tesla.getLiveStatus()));

// Normalized frontend contract.
app.get('/api/live', wrap(() => getLive()));
app.get('/api/batteries', wrap(() => getBatteries()));

app.get(
  '/api/history',
  wrap((req) => {
    const range = String(req.query.range ?? 'day');
    const valid = ['hour', 'day', 'week', 'month', 'year'] as const;
    const r = (valid as readonly string[]).includes(range) ? (range as (typeof valid)[number]) : 'day';
    return getHistory(r);
  }),
);

// Live day chart: 5-min measured + forecast for a day (offset 0=today, -1=…).
app.get(
  '/api/history/day',
  wrap((req) => {
    const offset = Number(req.query.offset ?? 0);
    return getHistoryDay(Number.isFinite(offset) ? offset : 0);
  }),
);

// ---- Alerts ----
app.get('/api/alerts', wrap(() => getAlerts()));
app.patch(
  '/api/alerts/channels',
  wrap((req) => {
    const { type, enabled } = (req.body ?? {}) as { type?: string; enabled?: boolean };
    if (type !== 'whatsapp' && type !== 'push' && type !== 'email') {
      const e = new Error('type must be whatsapp|push|email') as Error & { code?: string };
      e.code = 'BAD_INPUT';
      throw e;
    }
    return setChannel(type, Boolean(enabled));
  }),
);
app.patch(
  '/api/alerts/rules/:id',
  wrap((req) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    return setRule(String(req.params.id), Boolean(enabled));
  }),
);
app.post(
  '/api/alerts/:id/ack',
  wrap((req) => setAlertStatus(String(req.params.id), 'ack' as AlertStatus)),
);
app.post(
  '/api/alerts/:id/resolve',
  wrap((req) => setAlertStatus(String(req.params.id), 'resolved' as AlertStatus)),
);

// ---- Settings ----
app.get('/api/settings', wrap(() => getSettings()));
app.put(
  '/api/settings/whatsapp',
  wrap((req) => setWhatsAppNumber((req.body ?? {}).number)),
);

// ---- Brain (shadow / read-only) ----
app.get('/api/brain/plan', wrap(() => getPlan()));

// ---- Scenarios ----
app.get('/api/scenarios', wrap(() => getScenarios()));
app.post('/api/scenarios/preview', wrap((req) => previewScenario((req.body ?? {}) as PreviewInput)));
app.post('/api/scenarios/:id/apply', wrap((req) => applyScenario(String(req.params.id))));
app.put(
  '/api/scenarios/:id',
  wrap((req) => {
    const body = (req.body ?? {}) as { def?: Partial<ScenarioDef> } & Partial<ScenarioDef>;
    // Accept either {def:{...}} or the def fields at the top level.
    const def = (body.def ?? body) as Partial<ScenarioDef>;
    return saveScenario(String(req.params.id), def);
  }),
);

// ---- Web Push ----
app.get('/api/push/vapid-public', wrap(() => getVapidPublic()));
app.post('/api/push/subscribe', wrap((req) => subscribe((req.body ?? {}) as never)));

// ---- Battery control (REAL device writes) ----
// status is read-only (any authed user); arm/command/apply are admin-gated.
app.get('/api/control/status', wrap(() => getControlStatus()));
app.post(
  '/api/control/arm',
  requireAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { armed?: boolean; mode?: string };
    if (typeof body.armed !== 'boolean') {
      const e = new Error('armed (boolean) required') as Error & { code?: string };
      e.code = 'BAD_INPUT';
      throw e;
    }
    return setArm(body.armed, body.mode as ControlMode | undefined);
  }),
);
app.post(
  '/api/control/command',
  requireAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { device?: string; lever?: string; value?: unknown };
    return controlCommand(body.device as ControlDevice, body.lever as Lever, body.value);
  }),
);
app.post('/api/control/apply-scenario', requireAdmin, wrap(() => applyScenarioToDevices()));

// ---- Devices / Climate (REAL device writes; reads are any-authed) ----
app.get('/api/devices', wrap(() => getDevices()));
app.get('/api/devices/status', wrap(() => getDevicesStatus()));
app.get('/api/devices/:id', wrap((req) => getDevice(String(req.params.id))));
app.post(
  '/api/devices/arm',
  requireAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { armed?: boolean; mode?: string };
    if (typeof body.armed !== 'boolean') {
      const e = new Error('armed (boolean) required') as Error & { code?: string };
      e.code = 'BAD_INPUT';
      throw e;
    }
    return setDevicesArm(body.armed, body.mode as ControlMode | undefined);
  }),
);
app.post(
  '/api/devices/bulk-command',
  requireAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { ids?: string[]; lever?: string; value?: unknown };
    return bulkCommand(body.ids ?? [], body.lever as ClimateLever, body.value);
  }),
);
app.post(
  '/api/devices/:id/command',
  requireAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { lever?: string; value?: unknown };
    return commandDevice(String(req.params.id), body.lever as ClimateLever, body.value);
  }),
);
app.put(
  '/api/devices/:id/settings',
  requireAdmin,
  wrap((req) => setDeviceSettings(String(req.params.id), (req.body ?? {}) as never)),
);
app.post(
  '/api/devices/:id/release',
  requireAdmin,
  wrap((req) => releaseDevice(String(req.params.id))),
);

// ---- AC Cloud integration ----
app.get('/api/integrations/intesis', wrap(() => getIntegration()));
app.post(
  '/api/integrations/intesis',
  requireAdmin,
  wrap((req) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    return setIntegration(body.username, body.password);
  }),
);
app.delete('/api/integrations/intesis', requireAdmin, wrap(() => disconnectIntegration()));

// ---- Schedules CRUD (admin for writes) ----
app.get('/api/schedules', wrap(() => listSchedules()));
app.post('/api/schedules', requireAdmin, wrap((req) => createSchedule((req.body ?? {}) as never)));
app.put('/api/schedules/:id', requireAdmin, wrap((req) => updateSchedule(String(req.params.id), (req.body ?? {}) as never)));
app.delete('/api/schedules/:id', requireAdmin, wrap((req) => deleteSchedule(String(req.params.id))));

// ---- Automations CRUD (admin for writes) ----
app.get('/api/automations', wrap(() => listAutomations()));
app.post('/api/automations', requireAdmin, wrap((req) => createAutomation((req.body ?? {}) as never)));
app.put('/api/automations/:id', requireAdmin, wrap((req) => updateAutomation(String(req.params.id), (req.body ?? {}) as never)));
app.delete('/api/automations/:id', requireAdmin, wrap((req) => deleteAutomation(String(req.params.id))));

// Ensure VAPID keys exist on boot (generate + persist if missing).
try {
  notify.ensureVapid();
} catch (e) {
  console.error('[energy-api] VAPID init failed:', (e as Error).message);
}

// Seed the first admin + setup link if no users exist yet (no open self-signup).
try {
  bootstrapAdmin();
} catch (e) {
  console.error('[energy-api] auth bootstrap failed:', (e as Error).message);
}

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

app.listen(config.port, config.host, () => {
  console.log(`[energy-api] http://${config.host}:${config.port}  (env=${config.env})`);
});
