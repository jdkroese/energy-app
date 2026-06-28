import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AppShell, type ShellContext } from './components/shell/AppShell';
import { Live } from './screens/Live';
import { Reports } from './screens/Reports';
import { Settings } from './screens/Settings';
import { Scenarios } from './screens/Scenarios';
import { Batteries } from './screens/Batteries';
import { BatteryDetail } from './screens/BatteryDetail';
import { Devices } from './screens/Devices';
import { DeviceDetail } from './screens/DeviceDetail';
import { GenericDeviceDetail } from './screens/GenericDeviceDetail';
import { RoomsManage } from './screens/RoomsManage';
import { Automations } from './screens/Automations';
import { AlarmScreen, AlarmActiveBanner } from './screens/Speakers';
import { Login } from './screens/auth/Login';
import { Setup } from './screens/auth/Setup';
import { Reset } from './screens/auth/Reset';
import { PowerMark } from './screens/auth/AuthShell';
import { AuthProvider, useAuth } from './auth/AuthProvider';

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
        <AlarmActiveBanner />
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
          <Route path="/devices" element={<Devices ctx={ctx} />} />
          <Route path="/rooms" element={<RoomsManage ctx={ctx} />} />
          <Route path="/devices/generic/:id" element={<GenericDeviceDetail ctx={ctx} />} />
          <Route path="/devices/:id" element={<DeviceDetail ctx={ctx} />} />
          {/* /schedules folded into Automations behind a tab — keep the path as a
              back-compat redirect to the Schedules tab for bookmarks/links. */}
          <Route path="/schedules" element={<Navigate to="/automations?tab=schedules" replace />} />
          <Route path="/automations" element={<Automations ctx={ctx} />} />
          {/* House-alarm panic page — a big trigger/STOP button for a phone shortcut. */}
          <Route path="/alarm" element={<AlarmScreen ctx={ctx} />} />
          {/* a signed-in user hitting an auth path goes home */}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
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
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
