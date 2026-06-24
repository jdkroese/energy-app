import dotenv from 'dotenv';
import { resolve } from 'node:path';

// In production the env is provided by systemd (EnvironmentFile=/opt/energy/.env).
// In dev, load the repo-root .env (cwd is apps/api when started via `pnpm --filter`).
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: resolve(process.cwd(), '../../.env') });
  dotenv.config(); // also a local .env if present (does not override)
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.API_PORT ?? 3002),
  host: process.env.API_HOST ?? '127.0.0.1',
  sonnen: {
    host: process.env.SONNEN_HOST ?? '192.168.1.197',
    token: process.env.SONNEN_API_TOKEN ?? '',
  },
  tesla: {
    audience: process.env.TESLA_AUDIENCE ?? 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
    tokenUrl:
      process.env.TESLA_TOKEN_URL ?? 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
    clientId: process.env.TESLA_CLIENT_ID ?? '',
    clientSecret: process.env.TESLA_CLIENT_SECRET ?? '',
    refreshToken: process.env.TESLA_REFRESH_TOKEN ?? '',
    siteId: process.env.TESLA_ENERGY_SITE_ID ?? '',
  },
  site: {
    // Jávea (Xàbia), Costa Blanca.
    lat: Number(process.env.SITE_LAT ?? 38.79),
    lon: Number(process.env.SITE_LON ?? 0.17),
    solarKwp: Number(process.env.SITE_SOLAR_KWP ?? 18.2),
  },
  assets: {
    // Real nameplate facts (see docs/00-project-brief, capability matrix).
    sonnenUsableKwh: 9.2,
    sonnenNominalKwh: 11,
    sonnenMaxKw: 4.6,
    teslaUsableKwh: 27, // 2× PW3
    teslaMaxKw: 10, // nameplate_power
    criticalLoadKw: 0.6, // critical-load estimate for backup autonomy
  },
} as const;
