import type {
  AlertsResponse,
  BrainPlanResponse,
  Channels,
  ChannelType,
  HistoryResponse,
  LiveResponse,
  ScenarioDef,
  ScenarioPreview,
  ScenariosResponse,
  SettingsResponse,
  VapidPublicResponse,
} from './types';

export async function getJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Generic typed mutation helper — sends a JSON body with the given method. */
async function sendJSON<T>(method: string, path: string, body?: unknown): Promise<T> {
  return getJSON<T>(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const postJSON = <T>(path: string, body?: unknown) => sendJSON<T>('POST', path, body);
export const putJSON = <T>(path: string, body?: unknown) => sendJSON<T>('PUT', path, body);
export const patchJSON = <T>(path: string, body?: unknown) => sendJSON<T>('PATCH', path, body);

const enc = encodeURIComponent;

/** Typed API clients for each endpoint in the contract (docs/11-build-spec §6). */
export const api = {
  // reads
  live: () => getJSON<LiveResponse>('/api/live'),
  history: (range: string) => getJSON<HistoryResponse>(`/api/history?range=${enc(range)}`),
  alerts: () => getJSON<AlertsResponse>('/api/alerts'),
  settings: () => getJSON<SettingsResponse>('/api/settings'),
  brainPlan: () => getJSON<BrainPlanResponse>('/api/brain/plan'),
  scenarios: () => getJSON<ScenariosResponse>('/api/scenarios'),

  // settings + channels
  setWhatsapp: (number: string) => putJSON<{ channels: Channels }>('/api/settings/whatsapp', { number }),
  setChannel: (type: ChannelType, enabled: boolean) =>
    patchJSON<{ channels: Channels }>('/api/alerts/channels', { type, enabled }),

  // alert rules + actions
  setRule: (id: string, enabled: boolean) =>
    patchJSON<{ ok: boolean }>(`/api/alerts/rules/${enc(id)}`, { enabled }),
  ackAlert: (id: string) => postJSON<{ ok: boolean }>(`/api/alerts/${enc(id)}/ack`, {}),
  resolveAlert: (id: string) => postJSON<{ ok: boolean }>(`/api/alerts/${enc(id)}/resolve`, {}),

  // scenarios
  scenarioPreview: (def: ScenarioDef) => postJSON<ScenarioPreview>('/api/scenarios/preview', def),
  scenarioSave: (id: string, def: ScenarioDef) => putJSON<{ ok: boolean }>(`/api/scenarios/${enc(id)}`, def),
  scenarioApply: (id: string) => postJSON<{ ok: boolean }>(`/api/scenarios/${enc(id)}/apply`, {}),

  // push
  vapidPublic: () => getJSON<VapidPublicResponse>('/api/push/vapid-public'),
  pushSubscribe: (subscription: PushSubscriptionJSON) =>
    postJSON<{ ok: boolean }>('/api/push/subscribe', { subscription }),
};
