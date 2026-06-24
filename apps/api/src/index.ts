import express, { type Request, type Response } from 'express';
import { config } from './config';
import * as sonnen from './connectors/sonnen';
import * as tesla from './connectors/tesla';
import { getLive } from './routes/live';
import { getHistory } from './routes/history';
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
import * as notify from './notify';
import { startAlertLoop } from './alert-loop';
import type { ScenarioDef, AlertStatus } from './store';

const app = express();
app.use(express.json());

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

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'energy-api', env: config.env, time: new Date().toISOString() });
});

// Individual connectors (handy while developing).
app.get('/api/sonnen/status', wrap(() => sonnen.getStatus()));
app.get('/api/tesla/live', wrap(() => tesla.getLiveStatus()));

// Normalized frontend contract.
app.get('/api/live', wrap(() => getLive()));

app.get(
  '/api/history',
  wrap((req) => {
    const range = String(req.query.range ?? 'day');
    const valid = ['day', 'week', 'month', 'year'] as const;
    const r = (valid as readonly string[]).includes(range) ? (range as (typeof valid)[number]) : 'day';
    return getHistory(r);
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

// Ensure VAPID keys exist on boot (generate + persist if missing).
try {
  notify.ensureVapid();
} catch (e) {
  console.error('[energy-api] VAPID init failed:', (e as Error).message);
}

// Start the background alert loop (shadow/read-only — notifications only).
startAlertLoop();

app.listen(config.port, config.host, () => {
  console.log(`[energy-api] http://${config.host}:${config.port}  (env=${config.env})`);
});
