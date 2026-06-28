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
});

// Copy static assets (the bundled alarm siren clip) into dist/ so they travel with the
// deploy (CI copies apps/api/dist/. to the mini). The media route resolves dist/assets.
if (existsSync('assets')) {
  mkdirSync('dist/assets', { recursive: true });
  cpSync('assets', 'dist/assets', { recursive: true });
  console.log('[build] copied assets/ -> dist/assets/');
}

console.log('[build] apps/api -> dist/index.cjs');
