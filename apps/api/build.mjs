import { build } from 'esbuild';

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

console.log('[build] apps/api -> dist/index.cjs');
