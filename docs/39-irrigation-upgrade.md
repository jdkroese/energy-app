# 39 — Irrigation upgrade (production hardening + smart forecast bypass)

Owner request (2026-07-02), delivered together. Seven changes to the Rain Bird smart-watering
feature, web + mobile.

## 1. Irrigation events on the page
The `/irrigation` screen's "Recent decisions" card read only the coordinator's own domain log
(`irrigation.log`). Replaced with a live **Activity** feed backed by the unified event bus
(`GET /api/events?category=irrigation`) — so it shows the physical watering **sessions**
(start/end + duration, from PR #174), fires, skips, suppression, and alerts, exactly as the
Event Viewer does, with a "View all" link into `/events?category=irrigation`.

## 2. "Water now" duration
Previously fired the zone for its weather-trimmed minutes with no choice. Now opens a small
**duration modal with a slider** (1–60 min, **default 20**), then `command(zone,'run',mins)`.

## 3. Weekly schedule overview
New **Weekly plan** card: computed client-side from every app-managed zone's `wateringTimes`,
a 7-day view (Mon–Sun) listing each run (time · zone · ceiling min · ≈L), per-day totals, today
highlighted. Gives the whole configured program at a glance.

## 4. iPhone photo upload
Root cause: iPhone "Take Photo" hands the browser an **HEIC/HEIF** file (and full-res 12 MP,
often > the 8 MB cap). The server only accepts jpeg/png/webp → rejected. Fix is client-side:
the picker now uses `accept="image/*"` and every chosen file is **re-encoded to a downscaled
JPEG** (max 1600 px, q0.85) on a `<canvas>` before upload — Safari decodes HEIC to canvas, so
this normalises format AND size. Falls back to the original file if canvas encoding fails.

## 5. Watering window — removed
`windowFavorable()` only annotated the log ("solar surplus" / "P3" / "early morning"); the
coordinator "fires a due run regardless." It changed **no** behaviour, so per the owner it's
deleted end-to-end (type, state field, coordinator helper, UI select).

## 6. Forecast outlook + bypass rules + 2 h skip decision
- **Outlook:** new `weather.getDailyOutlook()` (Open-Meteo `daily=` precip sum, precip
  probability max, ET₀, tMax) for the next ~6 days. Surfaced on the page as an **upcoming-days**
  strip (rain mm + %). 
- **Bypass rules:** the existing `globalRainSkipMm` + `rainSkipProbabilityPct` are relabelled
  as the **bypass thresholds** ("skip if rain ≥ X mm" / "skip if chance ≥ Y %"). Per-zone
  `rainSkipMm` still overrides.
- **2 h decision:** each coordinator tick, for every app-managed zone's next occurrence starting
  **within 2 h**, we evaluate that run-day's *freshest* forecast against the thresholds and record
  a **skip / run decision** (`irrigation.skipDecisions`, keyed `zoneId@YYYY-MM-DDTHH:MM`), logged
  as a `decide` event. At fire time a `skip` decision suppresses the run. The next-run decision
  per zone is returned in `/api/irrigation/plan` so the card shows "next run will skip — 8 mm/70 %".
  Decisions older than 2 days are pruned.

## 7. Remove shadow — production
`IrrigationMode` is now **`off | live`**. `shadow` migrates to `off`. The coordinator's shadow
branch is gone; when `mode==='live'` but not actuating (disarmed/unreachable) it still logs the
intended run (`live=false`) as before. UI mode control is **Off / Live**.

All additive/defensively-migrated; log-only + skip-only forecast logic never waters *more*.
