import express, { type Request, type Response } from 'express';
import { config } from './config';
import * as sonnen from './connectors/sonnen';
import * as tesla from './connectors/tesla';
import { getLive } from './routes/live';
import { getHistory } from './routes/history';
import { getAlerts } from './routes/alerts';
import { getSettings } from './routes/settings';
import { getPlan } from './routes/brain';
import {
  getScenarios,
  applyScenario,
  previewScenario,
  type PreviewInput,
} from './routes/scenarios';

const app = express();
app.use(express.json());

const wrap =
  (fn: (req: Request) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message, code: 'UPSTREAM' });
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

app.get('/api/alerts', wrap(() => getAlerts()));
app.get('/api/settings', wrap(() => getSettings()));
app.get('/api/brain/plan', wrap(() => getPlan()));

app.get('/api/scenarios', wrap(() => getScenarios()));
app.post('/api/scenarios/preview', wrap((req) => previewScenario((req.body ?? {}) as PreviewInput)));
app.post('/api/scenarios/:id/apply', wrap((req) => applyScenario(String(req.params.id))));

app.listen(config.port, config.host, () => {
  console.log(`[energy-api] http://${config.host}:${config.port}  (env=${config.env})`);
});
