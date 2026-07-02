#!/usr/bin/env node
// Kitchen Hub seed-library photos (docs/39 "Seed library"): downloads one Wikimedia
// Commons photo per seed recipe into apps/web/public/recipes/<slug>.jpg (500px thumb —
// only the fixed allowed widths like 330/500 work; arbitrary widths 400) and writes
// ATTRIBUTION.md alongside with file / author / license per image.
//
// Run from the repo root:  node scripts/fetch-recipe-photos.mjs
// Idempotent: re-running refreshes every photo + the attribution file. A failed search
// or download just skips that slug (the UI degrades to a placeholder tile).

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public', 'recipes');
const THUMB_WIDTH = 500; // one of Commons' pre-rendered widths (330/500 ok; 400 → HTTP 400)
const UA = 'EnergyApp-KitchenHub/1.0 (home.hirobo.nl; j.kroese@levante.nl) node-fetch';

/** slug (matches seed-recipes.ts photo path) → Commons search term. */
const RECIPES = {
  'paella-pollo': 'paella valenciana mixta',
  'gazpacho-tortilla': 'gazpacho',
  'gambas-ajillo': 'gambas al ajillo',
  'lentejas-chorizo': 'lentejas con chorizo',
  'pollo-ajillo': 'pollo al ajillo',
  'merluza-plancha': 'merluza a la plancha',
  'albondigas': 'albondigas sauce',
  'pisto-huevo': 'pisto manchego',
  'fideua': 'fideua',
  'croquetas-ensalada': 'croquetas de jamon',
  'salmorejo-flamenquin': 'salmorejo cordobes',
  'pannenkoeken': 'pannenkoek',
  'hutspot': 'hutspot',
  'boerenkool': 'boerenkool stamppot rookworst',
  'erwtensoep': 'erwtensoep snert',
  'kipsate': 'chicken satay peanut',
  'gehaktballen': 'gehaktbal stamppot',
  'witlof-ham-kaas': 'witlof ham kaas oven',
  'nasi-goreng': 'nasi goreng fried egg',
  'kibbeling': 'kibbeling',
  'katsu-curry': 'katsu curry',
  'yakitori-bowls': 'yakitori skewers',
  'miso-ramen': 'miso ramen bowl',
  'oyakodon': 'oyakodon',
  'teriyaki-salmon': 'salmon teriyaki',
  'gyoza': 'gyoza plate',
  'okonomiyaki': 'okonomiyaki',
  'karaage': 'chicken karaage',
  'yaki-udon': 'yaki udon',
  'chirashi-bowls': 'chirashi sushi bowl',
  'vongole': 'spaghetti alle vongole',
  'pizza-night': 'pizza margherita homemade',
  'lasagne': 'lasagne al forno',
  'ragu-bolognese': 'spaghetti bolognese',
  'arrabbiata': 'penne arrabbiata',
  'risotto-funghi': 'risotto ai funghi',
  'pollo-parmigiana': 'chicken parmigiana',
  'gnocchi-pesto': 'gnocchi pesto',
  'carbonara': 'spaghetti carbonara',
  'minestrone': 'minestrone soup',
  'caesar-pollo': 'Caesar salad',
  'chili-con-carne': 'chili con carne',
  'tacos-pollo': 'chicken tacos',
  'burgers-caseros': 'homemade hamburger',
  'pad-thai-pollo': 'Pad Thai',
  'curry-garbanzos': 'chickpea curry chana masala',
  'salmon-horno': 'baked salmon vegetables',
  'wraps-pollo': 'chicken wrap tortilla',
  'shakshuka': 'shakshuka pan',
  'couscous-verduras': 'couscous vegetables',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function commons(params) {
  const url = `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`commons API ${res.status}`);
  return res.json();
}

/** Search Commons for a photo (namespace 6 = File) and return its 500px thumb + credits. */
async function findPhoto(term) {
  const json = await commons({
    action: 'query',
    generator: 'search',
    gsrsearch: `${term} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: '8',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime',
    iiurlwidth: String(THUMB_WIDTH),
  });
  const pages = Object.values(json.query?.pages ?? {}).sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    if (info.mime !== 'image/jpeg' && info.mime !== 'image/png') continue;
    const meta = info.extmetadata ?? {};
    const strip = (html) => (html ?? '').replace(/<[^>]+>/g, '').trim();
    return {
      title: page.title,
      thumbUrl: info.thumburl ?? info.url,
      pageUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
      author: strip(meta.Artist?.value) || 'unknown',
      license: strip(meta.LicenseShortName?.value) || 'see file page',
    };
  }
  return null;
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

mkdirSync(OUT_DIR, { recursive: true });
const attribution = [
  '# Recipe photo attribution',
  '',
  'Seed-library photos downloaded from Wikimedia Commons by `scripts/fetch-recipe-photos.mjs`',
  `(500px thumbs, descriptive User-Agent). Each entry lists the source file, author and license.`,
  'Licenses are as reported by the Commons API at download time — follow the file link for full terms.',
  '',
];
let ok = 0;
let fail = 0;

for (const [slug, term] of Object.entries(RECIPES)) {
  try {
    const photo = await findPhoto(term);
    if (!photo) throw new Error('no bitmap result');
    const dest = resolve(OUT_DIR, `${slug}.jpg`);
    const bytes = await download(photo.thumbUrl, dest);
    attribution.push(`- **${slug}.jpg** — [${photo.title.replace('File:', '')}](${photo.pageUrl}) · ${photo.author} · ${photo.license}`);
    console.log(`ok   ${slug}  (${Math.round(bytes / 1024)} KB) ← ${photo.title}`);
    ok++;
  } catch (e) {
    attribution.push(`- **${slug}.jpg** — MISSING (${e.message}) — UI falls back to a placeholder tile`);
    console.error(`FAIL ${slug}: ${e.message}`);
    fail++;
  }
  await sleep(350); // be polite to the Commons API
}

writeFileSync(resolve(OUT_DIR, 'ATTRIBUTION.md'), attribution.join('\n') + '\n');
console.log(`\ndone: ${ok} ok, ${fail} failed → ${OUT_DIR}`);
