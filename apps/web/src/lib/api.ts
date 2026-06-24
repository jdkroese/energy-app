import type {
  AlertsResponse,
  AuthUser,
  BatteriesResponse,
  BrainPlanResponse,
  Channels,
  ChannelType,
  ControlCommandValue,
  ControlDevice,
  ControlLever,
  ControlMode,
  ControlStatus,
  CreateUserResponse,
  HistoryResponse,
  LiveResponse,
  LoginResponse,
  MeResponse,
  OtpChannel,
  ScenarioDef,
  ScenarioPreview,
  ScenariosResponse,
  SessionsResponse,
  SettingsResponse,
  UserRole,
  UsersResponse,
  VapidPublicResponse,
} from './types';

/**
 * Thrown for non-2xx responses. Carries the HTTP status and any parsed JSON
 * error body so callers (e.g. Login) can distinguish 401 from other failures.
 */
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/* ---- Global unauthorized handler ------------------------------------------
 * On any 401 outside the auth routes, notify the app so it can flip to the
 * "logged out" state. AuthProvider registers a callback; we also dispatch a
 * DOM event so non-React code can react if needed. */
export const AUTH_UNAUTHORIZED_EVENT = 'power:unauthorized';
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}
function isAuthRoute(): boolean {
  if (typeof window === 'undefined') return false;
  return /^\/(login|setup|reset)\b/.test(window.location.pathname);
}
function notifyUnauthorized(): void {
  if (isAuthRoute()) return;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
  }
  onUnauthorized?.();
}

export async function getJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401) notifyUnauthorized();
    const msg =
      (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `${path} -> HTTP ${res.status}`);
    throw new ApiError(res.status, msg, body);
  }
  return (await res.json()) as T;
}

/** Generic typed mutation helper — sends a JSON body with the given method. */
async function sendJSON<T>(method: string, path: string, body?: unknown): Promise<T> {
  return getJSON<T>(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** DELETE helper (some endpoints return no body). */
async function delJSON<T>(path: string): Promise<T> {
  return getJSON<T>(path, { method: 'DELETE', credentials: 'same-origin' });
}

export const postJSON = <T>(path: string, body?: unknown) => sendJSON<T>('POST', path, body);
export const putJSON = <T>(path: string, body?: unknown) => sendJSON<T>('PUT', path, body);
export const patchJSON = <T>(path: string, body?: unknown) => sendJSON<T>('PATCH', path, body);

const enc = encodeURIComponent;

/** Typed API clients for each endpoint in the contract (docs/11-build-spec §6). */
export const api = {
  // reads
  live: () => getJSON<LiveResponse>('/api/live'),
  batteries: () => getJSON<BatteriesResponse>('/api/batteries'),
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

  /* ---- Autopilot / live battery control (arm/command/apply are admin) ---- */
  control: {
    status: () => getJSON<ControlStatus>('/api/control/status'),
    arm: (armed: boolean, mode: ControlMode) =>
      postJSON<ControlStatus>('/api/control/arm', { armed, mode }),
    command: (device: ControlDevice, lever: ControlLever, value: ControlCommandValue) =>
      postJSON<ControlStatus>('/api/control/command', { device, lever, value }),
    applyScenario: () => postJSON<ControlStatus>('/api/control/apply-scenario', {}),
  },
};

/* ---- Auth API -------------------------------------------------------------
 * Every call is cookie-authed (same-origin). 401s surface as ApiError so the
 * Login screen can show "Invalid email or password" without a global flip. */
export const auth = {
  me: () => getJSON<MeResponse>('/api/auth/me'),
  login: (email: string, password: string) =>
    postJSON<LoginResponse>('/api/auth/login', { email, password }),
  verifyOtp: (email: string, code: string, trustDevice: boolean) =>
    postJSON<MeResponse>('/api/auth/verify-otp', { email, code, trustDevice }),
  logout: () => postJSON<{ ok: boolean }>('/api/auth/logout', {}),
  requestReset: (email: string) =>
    postJSON<{ ok: true }>('/api/auth/request-reset', { email }),
  reset: (token: string, password: string) =>
    postJSON<{ ok: boolean }>('/api/auth/reset', { token, password }),
  setup: (token: string, password: string, name?: string) =>
    postJSON<MeResponse>('/api/auth/setup', { token, password, name }),
  set2fa: (enabled: boolean, channel: OtpChannel) =>
    postJSON<{ ok: boolean }>('/api/auth/2fa', { enabled, channel }),

  // sessions & trusted devices
  sessions: () => getJSON<SessionsResponse>('/api/auth/sessions'),
  revokeSession: (id: string) => delJSON<{ ok: boolean }>(`/api/auth/sessions/${enc(id)}`),
  revokeTrusted: (id: string) => delJSON<{ ok: boolean }>(`/api/auth/trusted/${enc(id)}`),

  // admin user management
  listUsers: () => getJSON<UsersResponse>('/api/auth/users'),
  createUser: (email: string, name: string, role: UserRole) =>
    postJSON<CreateUserResponse>('/api/auth/users', { email, name, role }),
  deleteUser: (id: string) => delJSON<{ ok: boolean }>(`/api/auth/users/${enc(id)}`),
};

// re-export for convenience
export type { AuthUser };
