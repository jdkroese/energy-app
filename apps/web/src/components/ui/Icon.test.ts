// Guard tests for the Icon wrapper. An unknown lucide name renders a blank span with
// no error, so a typo (or a name lucide has since retired) is invisible until someone
// notices a missing glyph in the UI — that is how alert-triangle/alert-circle and
// bar-chart-3 all shipped broken. These tests sweep the source and fail loudly instead.
//
// apps/web has no formal test runner; mirror lib/health.test.ts and run with tsx +
// node:test. tsx is a devDep of @energy/api, so invoke it from there:
//   cd apps/api && node --import tsx --test ../web/src/components/ui/Icon.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALIASES, resolveIcon } from './Icon';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Pull icon-name string literals out of one source file. Covers the three shapes the
 * app uses: `<Icon name=…>`, an `icon` prop or object field, and the curated *ICONS
 * palettes. Strings on the left of a comparison (`kind === 'ok' ? 'x' : 'y'`) are
 * ternary conditions rather than icon names, so they are stripped first.
 */
function iconNamesIn(src: string): string[] {
  const found: string[] = [];
  const collect = (fragment: string) => {
    const cleaned = fragment.replace(/[=!]==?\s*(['"])[^'"]*\1/g, '');
    for (const m of cleaned.matchAll(/(['"])([a-z][a-z0-9-]*)\1/g)) found.push(m[2]);
  };
  const value = String.raw`(?:(['"])[a-z0-9-]*\1|\{[^}]*\})`;

  for (const tag of src.matchAll(/<Icon\b[^>]*>/g)) {
    const m = tag[0].match(new RegExp(String.raw`\bname\s*=\s*(${value})`));
    if (m) collect(m[1]);
  }
  for (const m of src.matchAll(new RegExp(String.raw`\bicon\s*[=:]\s*(${value})`, 'g'))) collect(m[1]);
  for (const m of src.matchAll(/\b[A-Z][A-Z_]*ICONS\b\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g)) collect(m[1]);

  return found;
}

test('every alias points at an icon lucide actually ships', () => {
  // Guards the alias table itself: an alias whose target is also wrong would resolve to
  // nothing and reintroduce the silent blank.
  for (const legacy of Object.keys(ALIASES)) {
    assert.ok(resolveIcon(legacy), `alias "${legacy}" → "${ALIASES[legacy]}" does not resolve`);
  }
});

test('unknown names resolve to null rather than a lookalike', () => {
  assert.equal(resolveIcon('definitely-not-an-icon'), null);
  assert.equal(resolveIcon(''), null);
});

test('every icon name used in apps/web resolves to a real lucide icon', () => {
  const broken: string[] = [];
  for (const file of sourceFiles(SRC)) {
    for (const name of new Set(iconNamesIn(readFileSync(file, 'utf8')))) {
      if (!resolveIcon(name)) broken.push(`${relative(SRC, file).split(sep).join('/')}: "${name}"`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    `these icon names render nothing — fix the spelling, or alias them in Icon.tsx:\n  ${broken.join('\n  ')}`,
  );
});
