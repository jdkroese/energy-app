// Music-schedule coordinator. Every 30s it fires any schedule EDGE that fell in the
// window since the last tick: at onTime it plays the schedule's source (an internet-radio
// station OR a Spotify context) on its chosen speakers at its chosen volume; at offTime it
// stops those speakers. Edge-triggered (not continuously enforced) so a manual change
// between edges is respected. No arm gate — music scheduling is admin-configured and runs
// autonomously (it never touches the battery/climate control authority). Mirrors
// control/light-coordinator.ts.
//
// FAIL-SOFT (critical — this runs alongside the armed battery loop): every play/stop is
// wrapped so a Spotify error / not-connected / not-Premium / mapping failure only LOGS and
// no-ops. A single schedule can never throw out of the tick and crash the coordinator.

import * as store from '../store';
import * as sonos from '../connectors/sonos';
import * as spotify from '../connectors/spotify';

const TICK_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;
let last: { day: number; min: number } | null = null;

function nowDM(): { day: number; min: number } {
  const d = new Date();
  return { day: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Did a scheduled (weekday, minute) fall in the half-open interval (prev, now]? */
function crossed(
  prev: { day: number; min: number },
  now: { day: number; min: number },
  day: number,
  min: number,
): boolean {
  if (prev.day === now.day) {
    return now.day === day && prev.min < min && min <= now.min;
  }
  // Tick straddled midnight: fire the tail of the previous day + the head of the new day.
  if (prev.day === day && min > prev.min) return true;
  if (now.day === day && min <= now.min) return true;
  return false;
}

/** Fire a radio-source schedule: play the favourite station on its speakers + set the banner.
 *  Fail-soft — a missing station or a play error logs and no-ops. */
async function fireRadio(s: store.RadioSchedule, state: store.StoreSchema): Promise<void> {
  const station = state.radioFavorites.find((f) => f.id === s.stationId);
  if (!station) {
    console.error(`[music] radio schedule "${s.name}": station ${s.stationId} not found — skipped`);
    return;
  }
  const res = await sonos
    .playStation({
      streamUrl: station.streamUrl,
      name: station.name,
      speakerIds: s.speakerIds,
      volumePct: s.volumePct,
    })
    .catch((e) => {
      console.error('[music] radio schedule play failed:', (e as Error).message);
      return null;
    });
  // Reflect the scheduled play in the now-playing banner (real target speakers).
  if (res) {
    store.update((st) => {
      st.radioNowPlaying = {
        name: station.name,
        stationId: station.id,
        speakerIds: res.playedOn,
        wholeHouse: s.speakerIds.length === 0,
        coordinator: res.coordinator,
        startedAt: new Date().toISOString(),
      };
    });
  }
}

/**
 * Fire a Spotify-source schedule: start the saved context on the schedule's speakers via the
 * Phase-1 play path. STRICTLY FAIL-SOFT — if Spotify isn't connected / not Premium / the target
 * is missing / any Web API or grouping error occurs, we log one clear line and return. Nothing
 * here can throw out of the tick. A whole-house schedule (no speakers) resolves to the full fleet
 * because Spotify Connect must target at least one device.
 */
async function fireSpotify(s: store.RadioSchedule): Promise<void> {
  const t = s.spotify;
  if (!t || !t.contextUri) {
    console.error(`[music] spotify schedule "${s.name}": no context — skipped`);
    return;
  }
  if (!spotify.isConnected()) {
    console.warn(`[music] spotify schedule "${s.name}": Spotify not connected — skipped (connect in Settings)`);
    return;
  }
  try {
    // Resolve whole-house (empty selection) to the full fleet — Connect needs ≥1 device.
    let speakerIds = s.speakerIds;
    if (speakerIds.length === 0) {
      const fleet = await sonos.getFleet().catch(() => [] as sonos.SonosSpeaker[]);
      speakerIds = fleet.map((f) => f.id);
    }
    if (speakerIds.length === 0) {
      console.warn(`[music] spotify schedule "${s.name}": no speakers available — skipped`);
      return;
    }
    // Playlists/albums play as a context; single tracks / liked songs play by uri.
    const asContext = t.kind === 'playlist' || t.kind === 'album';
    await spotify.playOnSpeakers({
      ...(asContext ? { contextUri: t.contextUri } : { uris: [t.contextUri] }),
      speakerIds,
      volumePct: s.volumePct,
    });
    console.log(`[music] spotify schedule "${s.name}" started "${t.contextName}" on ${speakerIds.length} speaker(s)`);
  } catch (e) {
    const err = e as { reason?: string; message?: string };
    const why = err.reason === 'PREMIUM_REQUIRED' ? 'Spotify Premium required' : err.message || String(e);
    console.error(`[music] spotify schedule "${s.name}" play failed (fail-soft): ${why}`);
  }
}

async function tick(): Promise<void> {
  try {
    const now = nowDM();
    if (!sonos.isConfigured()) {
      last = now;
      return;
    }
    if (!last) {
      last = now; // first tick establishes a baseline; never fire on boot
      return;
    }
    const state = store.get();
    const schedules = state.radioSchedules.filter((s) => s.enabled);
    for (const s of schedules) {
      const onMin = hhmmToMin(s.onTime);
      const offMin = s.offTime ? hhmmToMin(s.offTime) : null;
      for (const day of s.days) {
        if (crossed(last, now, day, onMin)) {
          if (s.source === 'spotify') {
            await fireSpotify(s);
          } else {
            await fireRadio(s, state);
          }
        }
        if (offMin !== null && crossed(last, now, day, offMin)) {
          // Stop is source-agnostic: silence the schedule's speakers (or all).
          await sonos
            .stopSpeakers(s.speakerIds.length ? s.speakerIds : undefined)
            .catch((e) => console.error('[music] schedule stop failed:', (e as Error).message));
          // Clear the radio banner when the scheduled stop overlaps the active radio session.
          store.update((st) => {
            const np = st.radioNowPlaying;
            if (!np) return;
            const covers = s.speakerIds.length === 0 || s.speakerIds.some((id) => np.speakerIds.includes(id));
            if (covers) st.radioNowPlaying = null;
          });
        }
      }
    }
    last = now;
  } catch (e) {
    console.error('[music] schedule coordinator tick failed:', (e as Error).message);
  }
}

export function startRadioCoordinator(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  console.log(`[music] schedule coordinator started (every ${TICK_MS / 1000}s)`);
}

