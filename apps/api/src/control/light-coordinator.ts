// Light-schedule coordinator. Every 30s it fires any schedule EDGE that fell in
// the window since the last tick: at onTime it applies the target (turn lights
// on at their dim level, or apply a scene); at offTime it switches the target's
// lights off. Edge-triggered (not continuously enforced) so a manual change
// between edges is respected. No arm gate — light scheduling is admin-configured
// and runs autonomously; every write still goes through the Tuya cloud.

import * as store from '../store';
import * as tuya from '../connectors/tuya';
import { applyScheduleOn, applyScheduleOff } from '../routes/lights';
import { sunriseSunsetMin } from '../solar-model';
import { config } from '../config';

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

function resolveTimeMin(
  hhmm: string,
  anchor: store.TimeAnchor | undefined,
  offsetMin: number,
  sunriseMin: number,
  sunsetMin: number,
): number {
  if (!anchor || anchor === 'fixed') return hhmmToMin(hhmm);
  return (anchor === 'sunrise' ? sunriseMin : sunsetMin) + offsetMin;
}

/** Did a scheduled (weekday, minute) fall in the half-open interval (prev, now]? */
function crossed(
  prev: { day: number; min: number },
  now: { day: number; min: number },
  day: number,
  min: number,
): boolean {
  if (prev.day === now.day) {
    // Common case (30s tick): a forward step within one weekday.
    return now.day === day && prev.min < min && min <= now.min;
  }
  // Tick straddled midnight: fire the tail of the previous day and the head of
  // the new day for a matching weekday.
  if (prev.day === day && min > prev.min) return true;
  if (now.day === day && min <= now.min) return true;
  return false;
}

async function tick(): Promise<void> {
  try {
    const now = nowDM();
    if (!tuya.isConfigured()) {
      last = now;
      return;
    }
    if (!last) {
      last = now; // first tick establishes a baseline; never fire on boot
      return;
    }
    const { sunriseMin, sunsetMin } = sunriseSunsetMin(config.site.lat, config.site.lon, new Date());
    const schedules = store.get().lightSchedules.filter((s) => s.enabled);
    for (const s of schedules) {
      const onMin = resolveTimeMin(s.onTime, s.onAnchor, s.onOffsetMin ?? 0, sunriseMin, sunsetMin);
      const resolvedOffMin = s.offTime
        ? resolveTimeMin(s.offTime, s.offAnchor, s.offOffsetMin ?? 0, sunriseMin, sunsetMin)
        : null;
      for (const day of s.days) {
        if (crossed(last, now, day, onMin)) await applyScheduleOn(s);
        if (resolvedOffMin !== null && crossed(last, now, day, resolvedOffMin)) await applyScheduleOff(s);
      }
    }
    last = now;
  } catch (e) {
    console.error('[lights] schedule coordinator tick failed:', (e as Error).message);
  }
}

export function startLightCoordinator(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  console.log(`[lights] schedule coordinator started (every ${TICK_MS / 1000}s)`);
}

export function stopLightCoordinator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
