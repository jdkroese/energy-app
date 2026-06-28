import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/index.cjs',
  sourcemap: true,
  logLevel: 'info',
  // better-sqlite3 is a NATIVE module — it ships a compiled .node binary and
  // cannot be bundled. Mark it external so the bundle keeps a runtime require()
  // that resolves to node_modules/better-sqlite3 on the host. The metering layer
  // requires it lazily inside a try/catch, so a host where the dep is absent
  // disables metering gracefully rather than crashing the API.
  external: ['better-sqlite3'],
});

// Copy static assets (the bundled alarm siren clip) into dist/ so they travel with the
// deploy (CI copies apps/api/dist/. to the mini). The media route resolves dist/assets.
if (existsSync('assets')) {
  mkdirSync('dist/assets', { recursive: true });
  cpSync('assets', 'dist/assets', { recursive: true });
  console.log('[build] copied assets/ -> dist/assets/');
}

console.log('[build] apps/api -> dist/index.cjs');
