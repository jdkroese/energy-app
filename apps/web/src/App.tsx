import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppShell, type ShellContext } from './components/shell/AppShell';
import { Live } from './screens/Live';
import { Reports } from './screens/Reports';
import { Alerts } from './screens/Alerts';
import { Settings } from './screens/Settings';
import { Scenarios } from './screens/Scenarios';
import { Brain } from './screens/Brain';
import { Batteries } from './screens/Batteries';

export default function App() {
  return (
    <BrowserRouter>
      <AppShell>
        {(ctx: ShellContext) => (
          <Routes>
            <Route path="/" element={<Live ctx={ctx} />} />
            <Route path="/reports" element={<Reports ctx={ctx} />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/scenarios" element={<Scenarios />} />
            <Route path="/brain" element={<Brain ctx={ctx} />} />
            <Route path="/batteries" element={<Batteries />} />
          </Routes>
        )}
      </AppShell>
    </BrowserRouter>
  );
}
