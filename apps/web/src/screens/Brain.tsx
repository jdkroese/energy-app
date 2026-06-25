import { Autopilot } from './Autopilot';
import type { ShellContext } from '../components/shell/AppShell';

/**
 * Brain — the `/brain` ("Autopilot") route. The screen was reorganised into a
 * tabbed Autopilot (Summary · Status · Activity · Settings); this is a thin
 * wrapper so the existing route keeps working.
 */
export function Brain({ ctx }: { ctx: ShellContext }) {
  return <Autopilot ctx={ctx} />;
}
