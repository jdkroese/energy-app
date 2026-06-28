import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

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

// Vendor the RUNTIME closure of native externals into dist/node_modules/ so the
// deployed bundle can resolve them. The deploy copies ONLY apps/api/dist/. to the
// mini (there is no node_modules next to the served bundle), and esbuild can't
// bundle a native .node addon — so `require('better-sqlite3')` from dist/index.cjs
// must find the package as a sibling in dist/node_modules/. We copy better-sqlite3
// plus its runtime deps (bindings → file-uri-to-path), dereferencing pnpm's symlinks
// and the prebuilt build/Release/*.node binary (built for the host arch during CI's
// `pnpm install`). `prebuild-install` is INSTALL-only, so it's skipped.
const NATIVE_EXTERNALS = ['better-sqlite3'];
const RUNTIME_SKIP = new Set(['prebuild-install']); // install-time tooling, not needed at runtime
const vendorRoot = 'dist/node_modules';

function vendorDep(name, fromDir, seen) {
  if (seen.has(name) || RUNTIME_SKIP.has(name)) return;
  seen.add(name);
  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve(`${name}/package.json`, { paths: [fromDir] });
  } catch (e) {
    // A missing runtime dep would silently break the native require at runtime; fail
    // the build loudly rather than ship a bundle that can only fail-soft-disable.
    throw new Error(`[build] cannot resolve runtime dep '${name}' from ${fromDir}: ${e.message}`);
  }
  const srcDir = dirname(pkgJsonPath);
  cpSync(srcDir, join(vendorRoot, name), { recursive: true, dereference: true });
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) vendorDep(dep, srcDir, seen);
}

mkdirSync(vendorRoot, { recursive: true });
const vendored = new Set();
for (const name of NATIVE_EXTERNALS) vendorDep(name, process.cwd(), vendored);
console.log(`[build] vendored native externals into ${vendorRoot}/: ${[...vendored].join(', ')}`);

console.log('[build] apps/api -> dist/index.cjs');
