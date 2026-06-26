# Dev brief — Alerts out of the menu (feed → Live, rules → Settings)

**Context:** Dissolve the standalone **Alerts** page. Its three sections move to where they belong:
the **notifications feed** becomes a **Live-page widget**, the **alert rules** move into **Settings ▸
Notifications** (the **channels are already there**), and the **Alerts nav item is removed**.
Owner-requested 2026-06-26. Brand = "Power" design system (dark control-room).

**Standing rule:** ship web (≥768px, `ctx.desktop`) **and** mobile (<768px) — both branches; verify
both viewports before calling it done.

**Affected files:**
- `apps/web/src/components/Notifications.tsx` (NEW — extract the feed + rules as reusable pieces)
- `apps/web/src/screens/Live.tsx` (render the notifications widget in BOTH branches)
- `apps/web/src/screens/Settings.tsx` (render the alert-rules card in the Notifications tab)
- `apps/web/src/components/shell/nav.ts` (remove the Alerts nav item; fix mobile primary tabs)
- `apps/web/src/App.tsx` (remove the `/alerts` route + import)
- `apps/web/src/screens/Alerts.tsx` (DELETE once its pieces are extracted)

**No backend changes.** All endpoints already exist: `api.alerts` → `AlertsResponse { alerts,
channels, rules }`; `api.ackAlert(id)`, `api.resolveAlert(id)`, `api.setRule(id, enabled)`,
`api.setChannel(type, enabled)`. Types: `Alert`, `AlertsResponse`, `AlertSeverity`, `AlertStatus`.
Offline fallback `MOCK_ALERTS` in `lib/mock.ts`. The current `Alerts.tsx` already implements every
behavior below — this is mostly a relocation + split into two reusable components.

---

## 1. Notifications feed → Live widget

Create `components/Notifications.tsx` exporting **`NotificationsWidget`** — a self-contained card
that ports the **feed** half of `Alerts.tsx` (lines ~67–175):
- Polls `api.alerts` (30s) with the `MOCK_ALERTS` fallback + a local optimistic mirror (so
  ack/resolve persist across polls), exactly as `Alerts.tsx` does today.
- `Card` titled **"Notifications"**, with an active-count badge (`alerts.filter(status !==
  'resolved').length` → "N active", danger pill) in the card actions/right.
- Rows: severity icon in a washed tile (`COL`/`WASH`), title + sub, `StatusPill`, relative time
  (`fmtAlertTime`). Actionable (non-resolved) rows expand on click → **Acknowledge** (status
  'new' only) + **Resolve** buttons (`api.ackAlert` / `api.resolveAlert`).
- Cap to the **~5 most recent**, sort active (new/ack) before resolved; resolved dimmed. Empty
  state: "No notifications." (Don't let it grow unbounded on Live.)
- Move the helpers it needs into this file: `COL`, `WASH`, `STATUS_LABEL`, `StatusPill`,
  `fmtAlertTime`. (Channel helpers `chanIcon`/`channelType` are NOT needed here — channels live
  in Settings.)

Render `<NotificationsWidget />` on **Live** in BOTH branches (`Live.tsx`):
- **Desktop** (`LiveDesktop`, ~line 289): add as a card in the layout — e.g. a full-width card
  after the batteries/insight row (before `DayChartCard`), or as the right column of a new row.
  Match the existing `Card`/grid rhythm.
- **Mobile** (`Live`, ~line 171): add to the column — sensible spot is after the insight card,
  before the day chart.

## 2. Channels — already in Settings (no change)

Settings ▸ Notifications (`NotificationsCard`, `Settings.tsx:302–462`) **already** renders the
WhatsApp / Push / Email channel toggles (`api.setChannel`). The Alerts page's "Notify via" is a
duplicate — it simply goes away with the page. **Do not add channels anywhere.**

## 3. Alert rules → Settings ▸ Notifications

In `components/Notifications.tsx` also export **`AlertRulesCard`** — ports the **rules** half of
`Alerts.tsx` (lines ~194–204):
- Polls `api.alerts` for `rules`, renders a `Card` titled **"Alert rules"** with one row per rule
  (`Icon name={r.icon}` + `r.label` + `Switch`), toggling via `api.setRule(id, enabled)` with an
  optimistic local mirror + revert on failure.
- In `Settings.tsx`, render it in the Notifications tab right under `NotificationsCard`
  (~line 1253): `{active === 'Notifications' && (<><NotificationsCard …/><AlertRulesCard/></>)}`.

## 4. Remove the menu item + route

- `nav.ts`: delete the `{ to: '/alerts', label: 'Alerts', icon: 'bell' }` entry (line ~14). Set
  `MOBILE_PRIMARY_PATHS` back to `['/', '/reports', '/batteries', '/devices']` (line ~32) so the
  mobile bottom bar keeps **4** primary tabs (Alerts was the 4th).
- `App.tsx`: remove `import { Alerts }` (line 5) and the `<Route path="/alerts" element={<Alerts
  />} />` (line 43). The existing catch-all `<Route path="*" element={<Navigate to="/" replace
  />} />` already redirects any stray `/alerts` link home — no extra redirect needed.
- Delete `screens/Alerts.tsx` after extraction. Keep `MOCK_ALERTS` in `lib/mock.ts` (the widget
  uses it).

## 5. Notes / out of scope

- Reuse `components/ui` primitives (Card, Switch, Icon, Button) + the 5 energy hues only. Numerals
  in `.pwr-mono`. The widget is read + act (ack/resolve) — channel/rule **editing** stays in
  Settings.
- No backend/route/type changes.

## Verify

Typecheck + build both apps. Run the dev server: Live shows the **Notifications** widget at desktop
AND mobile widths (with working ack/resolve), Settings ▸ Notifications shows the **Alert rules**
card under the channels, and the **Alerts** item is gone from the rail + mobile bar (a `/alerts`
link redirects home). Screenshot both viewports. Open a PR; do not merge to `main` (the owner /
orchestrator lands it).
