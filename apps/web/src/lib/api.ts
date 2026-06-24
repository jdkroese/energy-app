import type {
  AlertsResponse,
  BrainPlanResponse,
  HistoryResponse,
  LiveResponse,
  ScenarioPreview,
  ScenariosResponse,
  SettingsResponse,
} from './types';

export async function getJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  return getJSON<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Typed API clients for each endpoint in the contract (docs/11-build-spec §6). */
export const api = {
  live: () => getJSON<LiveResponse>('/api/live'),
  history: (range: string) => getJSON<HistoryResponse>(`/api/history?range=${encodeURIComponent(range)}`),
  alerts: () => getJSON<AlertsResponse>('/api/alerts'),
  settings: () => getJSON<SettingsResponse>('/api/settings'),
  brainPlan: () => getJSON<BrainPlanResponse>('/api/brain/plan'),
  scenarios: () => getJSON<ScenariosResponse>('/api/scenarios'),
  scenarioPreview: (body: unknown) => postJSON<ScenarioPreview>('/api/scenarios/preview', body),
  scenarioApply: (id: string) => postJSON<{ ok: boolean }>(`/api/scenarios/${encodeURIComponent(id)}/apply`, {}),
};
