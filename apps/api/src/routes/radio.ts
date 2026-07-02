// HTTP surface for Sonos internet radio: a searchable online directory (Radio Browser),
// 10-slot favourites (add via search / manual URL / import from Sonos), play a station on
// chosen speakers at a chosen volume, stop, and radio schedules. Reads are any-authed; all
// writes are admin-gated at the route in index.ts. Playback is a takeover (see sonos.ts).

import * as sonos from '../connectors/sonos';
import * as store from '../store';

function badInput(msg: string): never {
  const e = new Error(msg) as Error & { code?: string };
  e.code = 'BAD_INPUT';
  throw e;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---- Online directory search (Radio Browser API) ---------------------------
// Free, no API key. We fetch server-side to avoid CORS + keep it off the client, and send a
// descriptive User-Agent as the API requests. We map results to a slim shape and prefer the
// resolved stream URL. Multiple mirrors are tried so one bad host doesn't fail the search.

const RADIO_BROWSER_SERVERS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://all.api.radio-browser.info',
];

const RB_USER_AGENT = 'EnergyApp/1.0 (Sonos radio; +https://home.hirobo.nl)';

export interface RadioSearchResult {
  name: string;
  streamUrl: string;
  logo: string | null;
  codec: string | null;
  bitrate: number | null;
  countryCode: string | null;
  tags: string[];
}

interface RbStation {
  name?: string;
  url_resolved?: string;
  url?: string;
  favicon?: string;
  codec?: string;
  bitrate?: number;
  countrycode?: string;
  tags?: string;
}

/** GET /api/radio/search?q=… — search the online directory (server-side fetch). */
export async function searchRadio(qRaw: unknown, limitRaw?: unknown): Promise<unknown> {
  const q = String(qRaw ?? '').trim();
  if (!q) return { ts: new Date().toISOString(), query: '', results: [] };
  const limit = Math.max(1, Math.min(50, Number(limitRaw) || 30));
  const path =
    `/json/stations/search?name=${encodeURIComponent(q)}&limit=${limit}` +
    '&hidebroken=true&order=clickcount&reverse=true';

  let lastErr: string | null = null;
  for (const server of RADIO_BROWSER_SERVERS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(server + path, {
        headers: { 'User-Agent': RB_USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) {
        lastErr = `directory HTTP ${res.status}`;
        continue;
      }
      const raw = (await res.json()) as RbStation[];
      const results: RadioSearchResult[] = (Array.isArray(raw) ? raw : [])
        .map((s) => {
          const url = (s.url_resolved || s.url || '').trim();
          if (!url) return null;
          return {
            name: (s.name || 'Station').trim(),
            streamUrl: url,
            logo: s.favicon?.trim() || null,
            codec: s.codec?.trim() || null,
            bitrate: typeof s.bitrate === 'number' && s.bitrate > 0 ? s.bitrate : null,
            countryCode: s.countrycode?.trim() || null,
            tags: (s.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6),
          } as RadioSearchResult;
        })
        .filter((r): r is RadioSearchResult => !!r);
      return { ts: new Date().toISOString(), query: q, results };
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  return { ts: new Date().toISOString(), query: q, results: [], error: lastErr || 'directory unreachable' };
}

// ---- Favourites (10 slots) --------------------------------------------------

export function listFavorites(): unknown {
  return {
    ts: new Date().toISOString(),
    slots: store.RADIO_FAVORITE_SLOTS,
    favorites: [...store.get().radioFavorites].sort((a, b) => a.slot - b.slot),
  };
}

/** Lowest free slot index, or -1 when full. */
function firstFreeSlot(favorites: store.RadioStation[]): number {
  const used = new Set(favorites.map((f) => f.slot));
  for (let i = 0; i < store.RADIO_FAVORITE_SLOTS; i++) if (!used.has(i)) return i;
  return -1;
}

function sanitizeStationInput(body: Partial<store.RadioStation>): { name: string; streamUrl: string; logo?: string; codec?: string } {
  const streamUrl = String(body.streamUrl ?? '').trim();
  if (!streamUrl) badInput('streamUrl is required');
  if (!/^https?:\/\//i.test(streamUrl)) badInput('streamUrl must be an http(s):// URL');
  const name = String(body.name ?? '').trim() || 'Station';
  const logo = typeof body.logo === 'string' && body.logo.trim() ? body.logo.trim() : undefined;
  const codec = typeof body.codec === 'string' && body.codec.trim() ? body.codec.trim() : undefined;
  return { name, streamUrl, ...(logo ? { logo } : {}), ...(codec ? { codec } : {}) };
}

/** POST /api/radio/favorites — save a station into a slot (explicit slot, or first free). */
export function createFavorite(body: Partial<store.RadioStation>): unknown {
  const input = sanitizeStationInput(body ?? {});
  const saved = store.update((s) => {
    let slot: number;
    if (typeof body?.slot === 'number') {
      slot = Math.max(0, Math.min(store.RADIO_FAVORITE_SLOTS - 1, Math.round(body.slot)));
      // Replace whatever is in that slot.
      s.radioFavorites = s.radioFavorites.filter((f) => f.slot !== slot);
    } else {
      slot = firstFreeSlot(s.radioFavorites);
      if (slot < 0) return null; // all 10 slots full
    }
    const station: store.RadioStation = { id: newId('radio'), slot, ...input };
    s.radioFavorites.push(station);
    return station;
  });
  if (!saved) badInput(`all ${store.RADIO_FAVORITE_SLOTS} favourite slots are full — remove one first`);
  return { ts: new Date().toISOString(), favorite: saved };
}

/** PUT /api/radio/favorites/:id — edit a saved station (name / URL / logo / codec). */
export function updateFavorite(id: string, body: Partial<store.RadioStation>): unknown {
  const saved = store.update((s) => {
    const idx = s.radioFavorites.findIndex((f) => f.id === id);
    if (idx < 0) return null;
    const cur = s.radioFavorites[idx];
    const streamUrl = body.streamUrl !== undefined ? String(body.streamUrl).trim() : cur.streamUrl;
    if (!/^https?:\/\//i.test(streamUrl)) return 'BAD_URL';
    const merged: store.RadioStation = {
      ...cur,
      name: body.name !== undefined ? String(body.name).trim() || cur.name : cur.name,
      streamUrl,
      logo: body.logo !== undefined ? (String(body.logo).trim() || undefined) : cur.logo,
      codec: body.codec !== undefined ? (String(body.codec).trim() || undefined) : cur.codec,
    };
    s.radioFavorites[idx] = merged;
    return merged;
  });
  if (saved === 'BAD_URL') badInput('streamUrl must be an http(s):// URL');
  if (!saved) badInput(`favourite ${id} not found`);
  return { ts: new Date().toISOString(), favorite: saved };
}

/** DELETE /api/radio/favorites/:id — clear a slot (and drop schedules pointing at it). */
export function deleteFavorite(id: string): unknown {
  store.update((s) => {
    s.radioFavorites = s.radioFavorites.filter((f) => f.id !== id);
    s.radioSchedules = s.radioSchedules.filter((sc) => sc.stationId !== id);
  });
  return { ts: new Date().toISOString(), ok: true };
}

// ---- Import from the Sonos system's own radio favourites -------------------

/** GET /api/radio/sonos-favorites — the speakers' own radio favourites (for import). Also
 *  reports the non-radio favourites that were skipped, so the UI can explain an empty list
 *  (the owner's favourites are typically Spotify/SoundCloud playlists, not radio stations). */
export async function getSonosFavorites(): Promise<unknown> {
  const { radio, skipped } = await sonos.getSonosRadioFavorites();
  return { ts: new Date().toISOString(), favorites: radio, skipped };
}

// ---- Play / stop ------------------------------------------------------------

/** POST /api/radio/play { stationId?, streamUrl?, name?, speakerIds, volumePct } (admin). */
export async function playRadio(body: unknown): Promise<unknown> {
  const b = (body ?? {}) as {
    stationId?: unknown;
    streamUrl?: unknown;
    name?: unknown;
    speakerIds?: unknown;
    volumePct?: unknown;
  };
  let streamUrl = String(b.streamUrl ?? '').trim();
  let name = String(b.name ?? '').trim();
  // Resolve from a saved favourite when a stationId is given.
  if (typeof b.stationId === 'string' && b.stationId) {
    const fav = store.get().radioFavorites.find((f) => f.id === b.stationId);
    if (!fav) badInput(`station ${b.stationId} not found`);
    streamUrl = fav.streamUrl;
    name = name || fav.name;
  }
  if (!streamUrl) badInput('stationId or streamUrl is required');
  if (!/^https?:\/\//i.test(streamUrl)) badInput('streamUrl must be an http(s):// URL');
  const speakerIds = Array.isArray(b.speakerIds) ? b.speakerIds.filter((x): x is string => typeof x === 'string') : [];
  const volumePct = Number(b.volumePct);
  if (!Number.isFinite(volumePct) || volumePct < 0 || volumePct > 100) badInput('volumePct must be 0–100');

  const res = await sonos
    .playStation({ streamUrl, name: name || 'Radio', speakerIds, volumePct })
    .catch((e) => badInput(`play failed: ${(e as Error).message}`));
  // Persist the ACTUAL target speakers so the now-playing banner reflects reality (and
  // survives a refresh/restart). `wholeHouse` = the play targeted every speaker explicitly
  // (no selection sent), so the UI can say "All speakers" only when that's truly the case.
  const wholeHouse = speakerIds.length === 0;
  store.update((s) => {
    s.radioNowPlaying = {
      name: name || 'Radio',
      stationId: typeof b.stationId === 'string' && b.stationId ? b.stationId : null,
      speakerIds: res.playedOn,
      wholeHouse,
      coordinator: res.coordinator,
      startedAt: new Date().toISOString(),
    };
  });
  return { ts: new Date().toISOString(), ok: true, ...res };
}

/** GET /api/radio/now-playing — the active radio session (with the real target speakers). */
export function nowPlaying(): unknown {
  return { ts: new Date().toISOString(), nowPlaying: store.get().radioNowPlaying };
}

/**
 * POST /api/radio/speakers { speakerIds } (admin) — LIVE-edit which zones the active radio session
 * plays on, without re-pressing Play. Reconciles the current now-playing group to the target set:
 * newly-checked zones JoinGroup the coordinator (start in sync); un-checked zones leave + stop.
 *
 * Removing the LAST speaker stops the session entirely (an empty set = stop everything + clear the
 * banner). Otherwise the coordinator's stream keeps running and the persisted set is updated so
 * /now-playing reflects the change. Fail-soft — grouping errors surface as BAD_INPUT.
 */
export async function setRadioSpeakers(body: unknown): Promise<unknown> {
  const b = (body ?? {}) as { speakerIds?: unknown };
  const targetIds = Array.isArray(b.speakerIds)
    ? [...new Set(b.speakerIds.filter((x): x is string => typeof x === 'string'))]
    : [];

  const np = store.get().radioNowPlaying;
  if (!np) badInput('nothing is playing on the radio');

  // Empty target = stop the whole session.
  if (targetIds.length === 0) {
    await sonos.stopSpeakers(np.wholeHouse ? undefined : np.speakerIds).catch(() => {});
    store.update((s) => {
      s.radioNowPlaying = null;
    });
    return { ts: new Date().toISOString(), ok: true, stopped: true };
  }

  // The coordinator anchors the stream. Fall back to the first current/target id if unset.
  const coordinator = np.coordinator || np.speakerIds[0] || targetIds[0];
  // If the coordinator is being removed, we can't keep its stream on it — keep it in-scope and
  // let the owner remove it explicitly by unchecking others down to a set that includes it. To
  // keep behaviour simple + predictable we always retain the coordinator while ≥1 zone is chosen.
  const withCoord = targetIds.includes(coordinator) ? targetIds : [coordinator, ...targetIds];

  const res = await sonos
    .reconcileGroup(coordinator, np.speakerIds, withCoord)
    .catch((e) => badInput(`could not update speakers: ${(e as Error).message}`));

  // A specific set was chosen — this is no longer a whole-house play.
  store.update((s) => {
    if (!s.radioNowPlaying) return;
    s.radioNowPlaying = {
      ...s.radioNowPlaying,
      speakerIds: res.joined,
      wholeHouse: false,
      coordinator: res.coordinator,
    };
  });
  return { ts: new Date().toISOString(), ok: true, ...res };
}

/** POST /api/radio/stop { speakerIds? } (admin) — stop the chosen speakers (or all). */
export async function stopRadio(body: unknown): Promise<unknown> {
  const b = (body ?? {}) as { speakerIds?: unknown };
  const speakerIds = Array.isArray(b.speakerIds) ? b.speakerIds.filter((x): x is string => typeof x === 'string') : [];
  await sonos.stopSpeakers(speakerIds.length ? speakerIds : undefined);
  // Clear the now-playing banner when the stop covers the active session: a whole-house stop
  // (no ids), or a targeted stop that overlaps the speakers the station is playing on.
  store.update((s) => {
    const np = s.radioNowPlaying;
    if (!np) return;
    const covers = speakerIds.length === 0 || speakerIds.some((id) => np.speakerIds.includes(id));
    if (covers) s.radioNowPlaying = null;
  });
  return { ts: new Date().toISOString(), ok: true };
}

// ---- Music schedules (radio OR Spotify) -------------------------------------
// A schedule plays either an internet-radio station (source:'radio', stationId) OR a Spotify
// context (source:'spotify', spotify:{contextUri,…}). The array is still persisted as
// `radioSchedules` (see store.ts) but these routes accept + return the unified music schedule.

/** Coerce a Spotify schedule target from request input; null when unusable. */
function sanitizeSpotifyTarget(raw: unknown): store.SpotifyScheduleTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<store.SpotifyScheduleTarget>;
  const contextUri = typeof t.contextUri === 'string' ? t.contextUri.trim() : '';
  if (!contextUri) return null;
  const kind = t.kind === 'album' || t.kind === 'track' || t.kind === 'liked' ? t.kind : 'playlist';
  const contextImage = typeof t.contextImage === 'string' && t.contextImage.trim() ? t.contextImage.trim() : null;
  return {
    contextUri,
    contextName: typeof t.contextName === 'string' && t.contextName.trim() ? t.contextName.trim() : 'Spotify',
    contextImage,
    kind,
  };
}

function sanitizeSchedule(body: Partial<store.RadioSchedule>, base?: store.RadioSchedule): store.RadioSchedule {
  const onTime = typeof body.onTime === 'string' && HHMM_RE.test(body.onTime) ? body.onTime : base?.onTime ?? '08:00';
  const offRaw = body.offTime;
  const offTime =
    offRaw === null
      ? null
      : typeof offRaw === 'string' && HHMM_RE.test(offRaw)
        ? offRaw
        : base?.offTime ?? null;
  // Source: explicit if valid, else fall back to the base's source, else 'radio' (legacy default).
  const source: 'radio' | 'spotify' =
    body.source === 'spotify' || body.source === 'radio' ? body.source : base?.source ?? 'radio';
  const stationId = typeof body.stationId === 'string' && body.stationId ? body.stationId : base?.stationId ?? '';
  const spotify =
    body.spotify !== undefined ? sanitizeSpotifyTarget(body.spotify) : base?.spotify ?? null;
  return {
    id: base?.id ?? newId('msched'),
    name: body.name?.trim() || base?.name || 'Music schedule',
    enabled: typeof body.enabled === 'boolean' ? body.enabled : base?.enabled ?? true,
    days: Array.isArray(body.days) ? body.days.filter((d) => d >= 0 && d <= 6) : base?.days ?? [1, 2, 3, 4, 5],
    onTime,
    offTime,
    source,
    stationId: source === 'radio' ? stationId : '',
    spotify: source === 'spotify' ? spotify : null,
    speakerIds: Array.isArray(body.speakerIds)
      ? body.speakerIds.filter((x): x is string => typeof x === 'string')
      : base?.speakerIds ?? [],
    volumePct:
      typeof body.volumePct === 'number'
        ? Math.max(0, Math.min(100, Math.round(body.volumePct)))
        : base?.volumePct ?? 25,
  };
}

/** Reject a schedule whose chosen source has no usable target. */
function assertTarget(sched: store.RadioSchedule): void {
  if (sched.source === 'radio' && !sched.stationId) badInput('stationId is required for a radio schedule');
  if (sched.source === 'spotify' && (!sched.spotify || !sched.spotify.contextUri))
    badInput('a Spotify context is required for a Spotify schedule');
}

export function listSchedules(): unknown {
  return { ts: new Date().toISOString(), schedules: store.get().radioSchedules };
}

export function createSchedule(body: Partial<store.RadioSchedule>): unknown {
  const sched = sanitizeSchedule(body ?? {});
  assertTarget(sched);
  store.update((s) => {
    s.radioSchedules.push(sched);
  });
  return { ts: new Date().toISOString(), schedule: sched };
}

export function updateSchedule(id: string, body: Partial<store.RadioSchedule>): unknown {
  const existing = store.get().radioSchedules.find((x) => x.id === id);
  if (!existing) badInput(`music schedule ${id} not found`);
  const merged = sanitizeSchedule(body, existing);
  assertTarget(merged);
  store.update((s) => {
    const idx = s.radioSchedules.findIndex((x) => x.id === id);
    if (idx >= 0) s.radioSchedules[idx] = merged;
  });
  return { ts: new Date().toISOString(), schedule: merged };
}

export function deleteSchedule(id: string): unknown {
  store.update((s) => {
    s.radioSchedules = s.radioSchedules.filter((x) => x.id !== id);
  });
  return { ts: new Date().toISOString(), ok: true };
}
