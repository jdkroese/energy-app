import type {
  AlertsResponse,
  AuthUser,
  Automation,
  AutomationsResponse,
  BatteriesResponse,
  BatteryPriorityKey,
  BatteryPriorityRule,
  SoakExportRule,
  BlindLever,
  BlindsResponse,
  BlindDetailResponse,
  BrainPlanResponse,
  CapabilityKind,
  CapabilityOverride,
  Channels,
  ChannelType,
  ClimateLever,
  ConfiguredResponse,
  CustomDeviceType,
  CustomTypesResponse,
  DeviceDiagnosticsResponse,
  DeviceCommandTestResponse,
  ControlCommandValue,
  ControlDevice,
  ControlLever,
  ControlMode,
  ControlStatus,
  CreateUserResponse,
  DeviceDetailResponse,
  DevicesResponse,
  DevicesStatus,
  DiscoveredResponse,
  HistoryDayResponse,
  HistoryResponse,
  IntegrationsConfig,
  IntegrationStatus,
  LightLever,
  LightsResponse,
  LightDetailResponse,
  LightHsv,
  LightScene,
  LightSchedule,
  ScenesResponse,
  LightSchedulesResponse,
  TuyaIntegrationStatus,
  SpeakersResponse,
  AlarmStatus,
  AlarmConfig,
  AlarmConfigResponse,
  SonosIntegrationStatus,
  RadioStation,
  RadioFavoritesResponse,
  RadioSearchResponse,
  SonosFavoritesResponse,
  RadioPlayResponse,
  RadioNowPlayingResponse,
  RadioSchedule,
  RadioSchedulesResponse,
  LiveResponse,
  ProbeResult,
  LoginResponse,
  MeResponse,
  OtpChannel,
  ScenarioDef,
  ScenarioPreview,
  ScenariosResponse,
  Schedule,
  SchedulesResponse,
  Room,
  RoomsResponse,
  RoomAllOffResponse,
  SessionsResponse,
  SettingsResponse,
  UserRole,
  UsersResponse,
  VapidPublicResponse,
  VoltageMonitor,
  VoltageHistoryResponse,
  BreakerUsageGranularity,
  BreakerUsageResponse,
  BreakerUsageSummaryResponse,
  ParsedInvoice,
  InvoicesListResponse,
  InvoiceParseResponse,
  InvoiceSaveResponse,
  InvoiceDetail,
  IrrigationResponse,
  IrrigationZoneDetailResponse,
  IrrigationLever,
  RainbirdIntegrationStatus,
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
  history: (range: string, offset = 0) =>
    getJSON<HistoryResponse>(`/api/history?range=${enc(range)}&offset=${enc(String(offset))}`),
  historyDay: (offset: number) =>
    getJSON<HistoryDayResponse>(`/api/history/day?offset=${enc(String(offset))}`),
  alerts: () => getJSON<AlertsResponse>('/api/alerts'),
  settings: () => getJSON<SettingsResponse>('/api/settings'),
  brainPlan: () => getJSON<BrainPlanResponse>('/api/brain/plan'),
  scenarios: () => getJSON<ScenariosResponse>('/api/scenarios'),

  // settings + channels
  setWhatsapp: (number: string) => putJSON<{ channels: Channels }>('/api/settings/whatsapp', { number }),
  setChannel: (type: ChannelType, enabled: boolean) =>
    patchJSON<{ channels: Channels }>('/api/alerts/channels', { type, enabled }),

  // grid-voltage band monitor
  voltageMonitor: () => getJSON<{ voltageMonitor: VoltageMonitor }>('/api/settings/voltage-monitor'),
  setVoltageMonitor: (patch: Partial<Pick<VoltageMonitor, 'enabled' | 'minV' | 'maxV'>>) =>
    patchJSON<{ voltageMonitor: VoltageMonitor }>('/api/settings/voltage-monitor', patch),
  voltageHistory: () => getJSON<VoltageHistoryResponse>('/api/voltage/history'),

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
    batteryPriority: (rule: BatteryPriorityKey, patch: Partial<BatteryPriorityRule>) =>
      putJSON<ControlStatus>(`/api/control/battery-priority/${enc(rule)}`, patch),
    soakExport: (patch: Partial<SoakExportRule>) =>
      putJSON<ControlStatus>('/api/control/soak-export', patch),
  },

  /* ---- Devices / Climate (command/arm/CRUD are admin) ---- */
  devices: {
    list: () => getJSON<DevicesResponse>('/api/devices'),
    status: () => getJSON<DevicesStatus>('/api/devices/status'),
    detail: (id: string) => getJSON<DeviceDetailResponse>(`/api/devices/${enc(id)}`),
    arm: (armed: boolean, mode: ControlMode) =>
      postJSON<DevicesStatus>('/api/devices/arm', { armed, mode }),
    command: (id: string, lever: ClimateLever, value: boolean | number | string) =>
      postJSON<{ ts: string; result: unknown }>(`/api/devices/${enc(id)}/command`, { lever, value }),
    bulkCommand: (ids: string[], lever: ClimateLever, value: boolean | number | string) =>
      postJSON<{ ts: string; results: unknown[] }>('/api/devices/bulk-command', { ids, lever, value }),
    setSettings: (
      id: string,
      patch: { room?: string; roomId?: string | null; automationEnabled?: boolean; solarCoolEnabled?: boolean; solarHeatEnabled?: boolean; comfortCeilingC?: number; comfortFloorC?: number; invertPosition?: boolean },
    ) => putJSON<{ ts: string }>(`/api/devices/${enc(id)}/settings`, patch),
    // Assign / clear a device's room (cross-cutting Rooms model). null = Unassigned.
    setRoom: (id: string, roomId: string | null) =>
      postJSON<{ ts: string; id: string; roomId: string | null }>(`/api/devices/${enc(id)}/room`, { roomId }),
    release: (id: string) =>
      postJSON<{ ts: string; id: string; released: boolean }>(`/api/devices/${enc(id)}/release`, {}),

    // Onboarding inbox — discovered (not-yet-set-up) Tuya devices + triage (admin writes).
    discovered: () => getJSON<DiscoveredResponse>('/api/devices/discovered'),
    ignore: (id: string) => postJSON<{ ts: string; id: string; ignored: boolean }>(`/api/devices/${enc(id)}/ignore`, {}),
    keep: (id: string) => postJSON<{ ts: string; id: string; ignored: boolean }>(`/api/devices/${enc(id)}/keep`, {}),

    // Onboarding Phase 2 — set-up flow + generic control of configured devices (admin writes).
    configured: () => getJSON<ConfiguredResponse>('/api/devices/configured'),
    setup: (id: string, body: { typeId: string; name: string; capOverrides?: CapabilityOverride[] }) =>
      postJSON<{ ts: string; id: string }>(`/api/devices/${enc(id)}/setup`, body),
    unsetup: (id: string) => postJSON<{ ts: string; id: string }>(`/api/devices/${enc(id)}/unsetup`, {}),
    customTypes: () => getJSON<CustomTypesResponse>('/api/devices/custom-types'),
    createCustomType: (label: string, icon: string) =>
      postJSON<{ customDeviceType: CustomDeviceType }>('/api/devices/custom-types', { label, icon }),
    // Generic capability command ({ dp, kind, value }) — confirmed in the UI for sensitive actions.
    commandCap: (id: string, dp: string, kind: CapabilityKind, value: unknown) =>
      postJSON<{ ts: string; ok: boolean }>(`/api/devices/${enc(id)}/command`, { dp, kind, value }),
    // Rename a configured (set-up) device in place.
    rename: (id: string, name: string) => putJSON<{ ts: string }>(`/api/devices/${enc(id)}/name`, { name }),
    // Identity + network + datapoint table for debugging control issues (on-demand).
    diagnostics: (id: string) => getJSON<DeviceDiagnosticsResponse>(`/api/devices/${enc(id)}/diagnostics`),
    // Fire a DP command through a chosen Tuya API (v1 legacy / v2 thing-model) and
    // return the raw response — for debugging devices that ignore the normal path.
    testCommand: (id: string, dp: string, value: unknown, cmdApi: 'v1' | 'iot03' | 'v2') =>
      postJSON<DeviceCommandTestResponse>(`/api/devices/${enc(id)}/diagnostics/test`, { dp, value, api: cmdApi }),
  },

  /* ---- Circuit-breaker usage metering (read-only) ---- */
  breakers: {
    // Per-breaker usage time-series over [from,to]; granularity auto-picked when omitted.
    usage: (id: string, params: { from?: string; to?: string; granularity?: BreakerUsageGranularity } = {}) => {
      const q = new URLSearchParams();
      if (params.from) q.set('from', params.from);
      if (params.to) q.set('to', params.to);
      if (params.granularity) q.set('granularity', params.granularity);
      const qs = q.toString();
      return getJSON<BreakerUsageResponse>(`/api/breakers/${enc(id)}/usage${qs ? `?${qs}` : ''}`);
    },
    // Fleet usage summary (per-breaker kWh + share) for a period.
    usageSummary: (period: 'today' | 'week' | 'month' = 'today') =>
      getJSON<BreakerUsageSummaryResponse>(`/api/breakers/usage/summary?period=${enc(period)}`),
  },

  /* ---- Lights (Tuya); command/bulk are admin ---- */
  lights: {
    list: () => getJSON<LightsResponse>('/api/lights'),
    detail: (id: string) => getJSON<LightDetailResponse>(`/api/lights/${enc(id)}`),
    command: (id: string, lever: LightLever, value: boolean | number | LightHsv) =>
      postJSON<{ ts: string; ok: boolean }>(`/api/lights/${enc(id)}/command`, { lever, value }),
    bulkCommand: (ids: string[], lever: LightLever, value: boolean | number | LightHsv) =>
      postJSON<{ ts: string; results: unknown[] }>('/api/lights/bulk-command', { ids, lever, value }),
    rename: (id: string, name: string) => putJSON<{ ts: string }>(`/api/lights/${enc(id)}/name`, { name }),

    // Scenes (named on/off + dim presets; create/update/delete/apply are admin).
    scenes: () => getJSON<ScenesResponse>('/api/lights/scenes'),
    createScene: (s: Partial<LightScene>) => postJSON<{ scene: LightScene }>('/api/lights/scenes', s),
    updateScene: (id: string, s: Partial<LightScene>) => putJSON<{ scene: LightScene }>(`/api/lights/scenes/${enc(id)}`, s),
    deleteScene: (id: string) => delJSON<{ ok: boolean }>(`/api/lights/scenes/${enc(id)}`),
    applyScene: (id: string, on = true) => postJSON<{ ts: string; applied: number; failed: number }>(`/api/lights/scenes/${enc(id)}/apply`, { on }),

    // Schedules (lights/scenes at time windows; writes admin).
    schedules: () => getJSON<LightSchedulesResponse>('/api/lights/schedules'),
    createSchedule: (s: Partial<LightSchedule>) => postJSON<{ schedule: LightSchedule }>('/api/lights/schedules', s),
    updateSchedule: (id: string, s: Partial<LightSchedule>) => putJSON<{ schedule: LightSchedule }>(`/api/lights/schedules/${enc(id)}`, s),
    deleteSchedule: (id: string) => delJSON<{ ok: boolean }>(`/api/lights/schedules/${enc(id)}`),
  },

  /* ---- Sonos speakers + house alarm (Phase 1); writes are admin ---- */
  speakers: {
    list: () => getJSON<SpeakersResponse>('/api/speakers'),
    setVolume: (id: string, pct: number) =>
      postJSON<{ ts: string; ok: boolean }>(`/api/speakers/${enc(id)}/volume`, { pct }),
    test: (id: string) => postJSON<{ ts: string; ok: boolean }>(`/api/speakers/${enc(id)}/test`, {}),
  },
  alarm: {
    status: () => getJSON<AlarmStatus>('/api/alarm/status'),
    trigger: (body: { lightIds?: string[]; speakerIds?: string[]; durationSec?: number; volumePct?: number; blinkMs?: number } = {}) =>
      postJSON<AlarmStatus>('/api/alarm/trigger', body),
    stop: () => postJSON<AlarmStatus>('/api/alarm/stop', {}),
    config: () => getJSON<AlarmConfigResponse>('/api/alarm/config'),
    setConfig: (patch: Partial<AlarmConfig>) => putJSON<AlarmConfigResponse>('/api/alarm/config', patch),
  },

  /* ---- Sonos internet radio; play/stop + favourite/schedule writes are admin ---- */
  radio: {
    search: (q: string, limit = 30) =>
      getJSON<RadioSearchResponse>(`/api/radio/search?q=${enc(q)}&limit=${enc(String(limit))}`),
    favorites: () => getJSON<RadioFavoritesResponse>('/api/radio/favorites'),
    createFavorite: (s: Partial<RadioStation>) => postJSON<{ favorite: RadioStation }>('/api/radio/favorites', s),
    updateFavorite: (id: string, s: Partial<RadioStation>) =>
      putJSON<{ favorite: RadioStation }>(`/api/radio/favorites/${enc(id)}`, s),
    deleteFavorite: (id: string) => delJSON<{ ok: boolean }>(`/api/radio/favorites/${enc(id)}`),
    sonosFavorites: () => getJSON<SonosFavoritesResponse>('/api/radio/sonos-favorites'),
    play: (body: { stationId?: string; streamUrl?: string; name?: string; speakerIds: string[]; volumePct: number }) =>
      postJSON<RadioPlayResponse>('/api/radio/play', body),
    stop: (speakerIds: string[] = []) => postJSON<{ ts: string; ok: boolean }>('/api/radio/stop', { speakerIds }),
    nowPlaying: () => getJSON<RadioNowPlayingResponse>('/api/radio/now-playing'),
    schedules: () => getJSON<RadioSchedulesResponse>('/api/radio/schedules'),
    createSchedule: (s: Partial<RadioSchedule>) => postJSON<{ schedule: RadioSchedule }>('/api/radio/schedules', s),
    updateSchedule: (id: string, s: Partial<RadioSchedule>) =>
      putJSON<{ schedule: RadioSchedule }>(`/api/radio/schedules/${enc(id)}`, s),
    deleteSchedule: (id: string) => delJSON<{ ok: boolean }>(`/api/radio/schedules/${enc(id)}`),
  },

  /* ---- Irrigation (Rain Bird); run/stop/rain-delay are admin + require armed ---- */
  irrigation: {
    list: () => getJSON<IrrigationResponse>('/api/irrigation'),
    detail: (id: string) => getJSON<IrrigationZoneDetailResponse>(`/api/irrigation/${enc(id)}`),
    command: (id: string, lever: IrrigationLever, value?: number) =>
      postJSON<{ ts: string; result: { ok: boolean; reason: string; detail: string } }>(
        `/api/irrigation/${enc(id)}/command`,
        { lever, value },
      ),
    setSettings: (id: string, patch: { roomId?: string | null; name?: string }) =>
      putJSON<{ ts: string }>(`/api/irrigation/${enc(id)}/settings`, patch),
  },

  /* ---- Blinds / curtains (Tuya); command/bulk are admin ---- */
  blinds: {
    list: () => getJSON<BlindsResponse>('/api/blinds'),
    detail: (id: string) => getJSON<BlindDetailResponse>(`/api/blinds/${enc(id)}`),
    command: (id: string, lever: BlindLever, value?: number) =>
      postJSON<{ ts: string; ok: boolean }>(`/api/blinds/${enc(id)}/command`, { lever, value }),
    bulkCommand: (ids: string[], lever: BlindLever, value?: number) =>
      postJSON<{ ts: string; results: unknown[] }>('/api/blinds/bulk-command', { ids, lever, value }),
  },

  integrations: {
    intesisStatus: () => getJSON<IntegrationStatus>('/api/integrations/intesis'),
    intesisConnect: (username: string, password: string) =>
      postJSON<IntegrationStatus>('/api/integrations/intesis', { username, password }),
    intesisDisconnect: () => delJSON<{ ok: boolean }>('/api/integrations/intesis'),

    // Sonos house-alarm (local UPnP; enable + optional seed IP).
    sonosStatus: () => getJSON<SonosIntegrationStatus>('/api/integrations/sonos'),
    setSonos: (enabled: boolean, seedIp?: string) =>
      putJSON<SonosIntegrationStatus & { discoveredCount: number; names: string[] }>('/api/integrations/sonos', { enabled, seedIp }),
    rescanSonos: () =>
      postJSON<{ ts: string; discoveredCount: number; names: string[]; lastError: string | null }>('/api/integrations/sonos/rescan', {}),

    // Tuya Cloud (lights + future categories).
    tuyaStatus: () => getJSON<TuyaIntegrationStatus>('/api/integrations/tuya'),
    tuyaConnect: (region: string, accessId: string, accessSecret: string) =>
      postJSON<TuyaIntegrationStatus>('/api/integrations/tuya', { region, accessId, accessSecret }),
    tuyaDisconnect: () => delJSON<{ ok: boolean }>('/api/integrations/tuya'),

    // Configurable connections (Sonnen / Weather / Tesla).
    config: () => getJSON<IntegrationsConfig>('/api/integrations/config'),
    testSonnen: (host?: string, token?: string) =>
      postJSON<ProbeResult>('/api/integrations/sonnen/test', { host, token }),
    setSonnen: (host: string, token?: string) =>
      putJSON<ProbeResult & { config: IntegrationsConfig }>('/api/integrations/sonnen', { host, token }),
    setWeather: (lat: number, lon: number) =>
      putJSON<ProbeResult & { config: IntegrationsConfig }>('/api/integrations/weather', { lat, lon }),
    testTesla: () => postJSON<ProbeResult>('/api/integrations/tesla/test'),
    setTeslaSite: (siteId: string) =>
      putJSON<{ ok: boolean; config: IntegrationsConfig }>('/api/integrations/tesla', { siteId }),
    reauthTesla: (refreshToken: string) =>
      postJSON<ProbeResult>('/api/integrations/tesla/reauth', { refreshToken }),
    testAirzone: (host?: string) =>
      postJSON<ProbeResult>('/api/integrations/airzone/test', { host }),
    setAirzone: (host: string) =>
      putJSON<ProbeResult & { config: IntegrationsConfig }>('/api/integrations/airzone', { host }),

    // Rain Bird irrigation (LAN-local SIP; host prefilled, password required).
    rainbirdStatus: () => getJSON<RainbirdIntegrationStatus>('/api/integrations/rainbird'),
    testRainbird: (host?: string, password?: string) =>
      postJSON<ProbeResult>('/api/integrations/rainbird/test', { host, password }),
    setRainbird: (host: string, password?: string) =>
      putJSON<ProbeResult & { config: RainbirdIntegrationStatus }>('/api/integrations/rainbird', { host, password }),
    disconnectRainbird: () => delJSON<{ ok: boolean }>('/api/integrations/rainbird'),
  },

  schedules: {
    list: () => getJSON<SchedulesResponse>('/api/schedules'),
    create: (s: Partial<Schedule>) => postJSON<{ schedule: Schedule }>('/api/schedules', s),
    update: (id: string, s: Partial<Schedule>) => putJSON<{ schedule: Schedule }>(`/api/schedules/${enc(id)}`, s),
    remove: (id: string) => delJSON<{ ok: boolean }>(`/api/schedules/${enc(id)}`),
  },

  automations: {
    list: () => getJSON<AutomationsResponse>('/api/automations'),
    create: (a: Partial<Automation>) => postJSON<{ automation: Automation }>('/api/automations', a),
    update: (id: string, a: Partial<Automation>) => putJSON<{ automation: Automation }>(`/api/automations/${enc(id)}`, a),
    remove: (id: string) => delJSON<{ ok: boolean }>(`/api/automations/${enc(id)}`),
  },

  /* ---- Invoice vault (Bills); parse/save/delete are admin, reads any-authed ---- */
  invoices: {
    list: () => getJSON<InvoicesListResponse>('/api/invoices'),
    detail: (id: string) => getJSON<InvoiceDetail>(`/api/invoices/${enc(id)}`),
    // Multipart PDF upload → parse only (NOT saved). FormData sets its own content-type.
    parse: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return getJSON<InvoiceParseResponse>('/api/invoices/parse', { method: 'POST', body: fd });
    },
    save: (body: { sourceFile?: string; parsed: ParsedInvoice; edits?: Partial<ParsedInvoice>; pdfBase64?: string }) =>
      postJSON<InvoiceSaveResponse>('/api/invoices', body),
    remove: (id: string) => delJSON<{ ok: boolean }>(`/api/invoices/${enc(id)}`),
    pdfUrl: (id: string) => `/api/invoices/${enc(id)}/pdf`,
  },

  /* ---- Rooms (cross-cutting); create/rename/reorder/delete/all-off are admin ---- */
  rooms: {
    list: () => getJSON<RoomsResponse>('/api/rooms'),
    create: (name: string, icon: string) => postJSON<{ room: Room }>('/api/rooms', { name, icon }),
    update: (id: string, patch: Partial<Pick<Room, 'name' | 'icon' | 'order'>>) =>
      patchJSON<{ room: Room }>(`/api/rooms/${enc(id)}`, patch),
    remove: (id: string) => delJSON<{ ok: boolean }>(`/api/rooms/${enc(id)}`),
    allOff: (id: string, scope: 'all' | 'lights' = 'all') =>
      postJSON<RoomAllOffResponse>(`/api/rooms/${enc(id)}/all-off`, { scope }),
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
