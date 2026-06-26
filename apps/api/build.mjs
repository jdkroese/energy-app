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
  // store.ts/history5m.ts reference import.meta.url for the ESM dev runner, but
  // guard it behind `typeof __dirname` so the branch is dead in this CJS bundle.
  // esbuild can't see that statically and warns it'll be empty — silence it.
  logOverride: { 'empty-import-meta': 'silent' },
});

console.log('[build] apps/api -> dist/index.cjs');
