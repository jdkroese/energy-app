import express, { type Request, type Response } from 'express';
import { config } from './config';
import * as sonnen from './connectors/sonnen';
import * as tesla from './connectors/tesla';

const app = express();
app.use(express.json());

const wrap =
  (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  };

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'energy-api', env: config.env, time: new Date().toISOString() });
});

// Individual connectors (handy while developing)
app.get('/api/sonnen/status', wrap(() => sonnen.getStatus()));
app.get('/api/tesla/live', wrap(() => tesla.getLiveStatus()));

// Combined live snapshot — each source is best-effort so one failure doesn't 502 the whole call.
app.get('/api/live', async (_req: Request, res: Response) => {
  const [s, t] = await Promise.allSettled([sonnen.getStatus(), tesla.getLiveStatus()]);
  res.json({
    time: new Date().toISOString(),
    sonnen: s.status === 'fulfilled' ? s.value : { error: (s.reason as Error)?.message ?? String(s.reason) },
    tesla: t.status === 'fulfilled' ? t.value : { error: (t.reason as Error)?.message ?? String(t.reason) },
  });
});

app.listen(config.port, config.host, () => {
  console.log(`[energy-api] http://${config.host}:${config.port}  (env=${config.env})`);
});
