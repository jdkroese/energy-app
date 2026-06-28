// Radio-schedule coordinator. Every 30s it fires any schedule EDGE that fell in the
// window since the last tick: at onTime it plays the schedule's station on its chosen
// speakers at its chosen volume; at offTime it stops those speakers. Edge-triggered (not
// continuously enforced) so a manual change between edges is respected. No arm gate —
// radio scheduling is admin-configured and runs autonomously (it never touches the
// battery/climate control authority). Mirrors control/light-coordinator.ts.

import * as store from '../store';
import * as sonos from '../connectors/sonos';

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
          const station = state.radioFavorites.find((f) => f.id === s.stationId);
          if (station) {
            await sonos
              .playStation({
                streamUrl: station.streamUrl,
                name: station.name,
                speakerIds: s.speakerIds,
                volumePct: s.volumePct,
              })
              .catch((e) => console.error('[radio] schedule play failed:', (e as Error).message));
          }
        }
        if (offMin !== null && crossed(last, now, day, offMin)) {
          await sonos
            .stopSpeakers(s.speakerIds.length ? s.speakerIds : undefined)
            .catch((e) => console.error('[radio] schedule stop failed:', (e as Error).message));
        }
      }
    }
    last = now;
  } catch (e) {
    console.error('[radio] schedule coordinator tick failed:', (e as Error).message);
  }
}

export function startRadioCoordinator(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  console.log(`[radio] schedule coordinator started (every ${TICK_MS / 1000}s)`);
}

export function stopRadioCoordinator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
