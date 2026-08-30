import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AppShell, type ShellContext } from './components/shell/AppShell';
import { Login } from './screens/auth/Login';
import { Setup } from './screens/auth/Setup';
import { Reset } from './screens/auth/Reset';
import { PowerMark } from './screens/auth/AuthShell';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { ThemeProvider } from './lib/ThemeProvider';

// Route screens are code-split: each loads its own chunk on first navigation so
// the initial bundle stays small. Auth screens + the shell stay eager (critical
// path). lazy() needs a default export, so we adapt our named exports inline.
const Live = lazy(() => import('./screens/Live').then((m) => ({ default: m.Live })));
const Reports = lazy(() => import('./screens/Reports').then((m) => ({ default: m.Reports })));
const Settings = lazy(() => import('./screens/Settings').then((m) => ({ default: m.Settings })));
const Scenarios = lazy(() => import('./screens/Scenarios').then((m) => ({ default: m.Scenarios })));
const Batteries = lazy(() => import('./screens/Batteries').then((m) => ({ default: m.Batteries })));
const BatteryDetail = lazy(() => import('./screens/BatteryDetail').then((m) => ({ default: m.BatteryDetail })));
const Devices = lazy(() => import('./screens/Devices').then((m) => ({ default: m.Devices })));
const DeviceDetail = lazy(() => import('./screens/DeviceDetail').then((m) => ({ default: m.DeviceDetail })));
// Irrigation merged into the Water hub (docs/51) as its own tab — see /water below.
const Water = lazy(() => import('./screens/Water').then((m) => ({ default: m.Water })));
const GenericDeviceDetail = lazy(() =>
  import('./screens/GenericDeviceDetail').then((m) => ({ default: m.GenericDeviceDetail })),
);
const SceneControllerDetail = lazy(() =>
  import('./screens/SceneControllerDetail').then((m) => ({ default: m.SceneControllerDetail })),
);
const RoomsManage = lazy(() => import('./screens/RoomsManage').then((m) => ({ default: m.RoomsManage })));
const Automations = lazy(() => import('./screens/Automations').then((m) => ({ default: m.Automations })));
const AlarmScreen = lazy(() => import('./screens/Speakers').then((m) => ({ default: m.AlarmScreen })));
// Kitchen Hub (docs/38 + docs/39) — Cooking (planner + library) & Groceries (order builder).
const Cooking = lazy(() => import('./screens/kitchen/Cooking').then((m) => ({ default: m.Cooking })));
const Groceries = lazy(() => import('./screens/kitchen/Groceries').then((m) => ({ default: m.Groceries })));
// Cooking mode (P3, docs/42) — the 3-phase guided cook; also mounted by the kiosk TabletShell.
const Cook = lazy(() => import('./screens/kitchen/Cook').then((m) => ({ default: m.Cook })));
const MusicScreen = lazy(() => import('./screens/Speakers').then((m) => ({ default: m.MusicScreen })));
// AlarmActiveBanner renders on every authed page but shares a module with the
// Radio/Speakers panels (~1k lines). Lazy-load it with a null fallback so it
// doesn't drag that code into the main bundle and doesn't gate the page paint.
const AlarmActiveBanner = lazy(() => import('./screens/Speakers').then((m) => ({ default: m.AlarmActiveBanner })));

const PUBLIC_PATHS = ['/login', '/setup', '/reset'];
const isPublic = (path: string) => PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));

/** Minimal centered splash shown while the initial session probe runs. */
function Splash() {
  return (
    <div className="pwr-splash">
      <span className="pwr-splash__mark">
        <PowerMark size={56} />
      </span>
    </div>
  );
}

/** The signed-in application: AppShell + routed screens. */
function AppRoutes() {
  return (
    <AppShell>
      {(ctx: ShellContext) => (
        <>
        <Suspense fallback={null}>
          <AlarmActiveBanner />
        </Suspense>
        <Suspense fallback={<Splash />}>
        <Routes>
          <Route path="/" element={<Live ctx={ctx} />} />
          <Route path="/reports" element={<Reports ctx={ctx} />} />
          {/* /alerts removed — notifications live on Live; rules + channels in Settings */}
          <Route path="/alerts" element={<Navigate to="/" replace />} />
          <Route path="/settings" element={<Settings ctx={ctx} />} />
          <Route path="/scenarios" element={<Scenarios />} />
          {/* Autopilot folded into Automations — /brain redirects to the merged screen. */}
          <Route path="/brain" element={<Navigate to="/automations" replace />} />
          <Route path="/batteries" element={<Batteries ctx={ctx} />} />
          <Route path="/batteries/:id" element={<BatteryDetail ctx={ctx} />} />
          {/* Solar Inverters merged into the Energy hub (/batteries); keep the path as a redirect. */}
          <Route path="/solar-inverters" element={<Navigate to="/batteries" replace />} />
          <Route path="/devices" element={<Devices ctx={ctx} />} />
          <Route path="/water" element={<Water ctx={ctx} />} />
          {/* Irrigation merged into the Water hub (/water) as its own tab; keep the
              path as a deep-linkable redirect (docs/51, same pattern as PR #170's
              /solar-inverters -> /batteries). */}
          <Route path="/irrigation" element={<Navigate to="/water?tab=irrigation" replace />} />
          <Route path="/rooms" element={<RoomsManage ctx={ctx} />} />
          <Route path="/devices/generic/:id" element={<GenericDeviceDetail ctx={ctx} />} />
          <Route path="/devices/controller/:id" element={<SceneControllerDetail ctx={ctx} />} />
          <Route path="/devices/:id" element={<DeviceDetail ctx={ctx} />} />
          {/* /schedules folded into Automations behind a tab — keep the path as a
              back-compat redirect to the Schedules tab for bookmarks/links. */}
          <Route path="/schedules" element={<Navigate to="/automations?tab=schedules" replace />} />
          <Route path="/automations" element={<Automations ctx={ctx} />} />
          {/* Music — dedicated Spotify + radio experience (also the mini-player target). */}
          <Route path="/music" element={<MusicScreen ctx={ctx} />} />
          {/* Kitchen Hub — the weekly food loop (plan → order → cook). */}
          <Route path="/cooking" element={<Cooking ctx={ctx} />} />
          <Route path="/groceries" element={<Groceries ctx={ctx} />} />
          <Route path="/cook/:recipeId" element={<Cook ctx={ctx} />} />
          {/* House-alarm panic page — a big trigger/STOP button for a phone shortcut. */}
          <Route path="/alarm" element={<AlarmScreen ctx={ctx} />} />
          {/* a signed-in user hitting an auth path goes home */}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
        </>
      )}
    </AppShell>
  );
}

/** Gate: routes public auth screens, the splash, and the authed app. */
function Gate() {
  const { status } = useAuth();
  const location = useLocation();
  const onPublic = isPublic(location.pathname);

  // Public auth routes render regardless of auth status (so e.g. /setup works
  // for a brand-new, signed-out user and /reset works even if a stale session
  // exists). An already-authed user hitting /login is bounced home.
  if (onPublic) {
    return (
      <Routes>
        <Route path="/login" element={status === 'authed' ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/reset" element={<Reset />} />
      </Routes>
    );
  }

  if (status === 'loading') return <Splash />;
  if (status === 'anon') return <Login />;
  return <AppRoutes />;
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
