/* Status-board helpers: where a device/connector "resolves to" (click-through
 * target) and how to turn a raw connector error into something a human can read.
 * Route map mirrors the app router + Event Viewer #164's deviceHref. */

/** Per-device detail route for a subsystem's device, or null when the subsystem
 *  has no per-device page (lighting/blinds open the filtered Devices list). */
export function deviceHrefFor(subsystemKey: string, id: string): string | null {
  switch (subsystemKey) {
    case 'climate':
      return `/devices/${id}`;
    case 'circuits':
      return `/devices/generic/${id}`;
    case 'batteries':
      return `/batteries/${id}`;
    case 'lighting':
      return '/devices?type=lighting';
    case 'blinds':
      return '/devices?type=blinds';
    case 'speakers':
      return '/devices?type=speakers';
    case 'irrigation':
      return '/irrigation';
    case 'inverters':
      return '/solar-inverters';
    default:
      return null;
  }
}

/** Where to go to fix a connector-level problem (the "resolve via the UI" link). */
export function connectorHref(key: string): { href: string; label: string } {
  if (key === 'inverters') return { href: '/solar-inverters', label: 'Open Solar Inverters' };
  if (key === 'irrigation') return { href: '/irrigation', label: 'Open Irrigation' };
  if (key === 'lighting') return { href: '/devices?type=lighting', label: 'Open Lighting' };
  if (key === 'blinds') return { href: '/devices?type=blinds', label: 'Open Blinds' };
  // Connectors whose credentials/health live in Settings → Connections.
  return { href: '/settings', label: 'Open Settings · Connections' };
}

/** Turn a raw connector error into a short, human summary. Keeps the raw string
 *  for the detail view. Strips a leading "<deviceId>.<field>:" prefix that Intesis
 *  and friends prepend, and classifies the common failure modes. */
export function humanizeConnectorError(raw: string): string {
  const s = raw.replace(/^\s*\d{6,}\.[a-zA-Z_]+:\s*/, '').trim();
  const l = s.toLowerCase();
  if (/socket closed|closed before|econnreset|disconne/.test(l))
    return 'Connection dropped — reconnecting automatically.';
  if (/etimedout|timeout|timed out|\b50[24]\b|gateway/.test(l))
    return 'The service timed out — it will retry on the next poll.';
  if (/enotfound|ehostunreach|econnrefused|no response|unreachable|network/.test(l))
    return 'Not reachable on the network — check the device is powered and on Wi‑Fi.';
  if (/401|403|token|auth|unauthor|credential|login/.test(l))
    return 'Authentication needs attention — reconnect it in Settings.';
  // Fall back to the (de-prefixed) message, capped so a tile never shows a wall of text.
  return s.length > 90 ? `${s.slice(0, 88)}…` : s || 'Connector reported an error.';
}

/** Transient upstream failure (cloud 5xx / gateway timeout / dropped socket) that the
 *  coordinator retries next tick — e.g. Tesla `/site_info -> HTTP 504`. Rendered as a
 *  quiet amber "retrying", not a red hard fault, and not counted as an alert. */
export function isTransientUpstream(detail: string): boolean {
  return /HTTP\s*5\d\d|\b5\d\d\s+(?:bad gateway|gateway|service unavailable|server error)|gateway time-?out|\btimeouts?\b|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|network error|temporarily unavailable/i.test(detail);
}
