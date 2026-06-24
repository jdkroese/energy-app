// Dependency-free PWA icon generator for "Power".
// Renders the solar-green logomark bolt on the dark canvas, anti-aliased,
// and writes PNGs at the sizes iOS + the manifest need. Run: node gen-icons.cjs
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = path.join(__dirname, 'icons');
fs.mkdirSync(OUT, { recursive: true });

// Logomark bolt, scaled into a 512px canvas (from assets/logo-mark.svg).
const POLY = [[280,100],[154,282],[231,282],[196,412],[358,225],[281,225]];
const BG = [0x0b, 0x0e, 0x14]; // --bg canvas
const FG = [0x2e, 0xe6, 0xa0]; // solar green

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function render(size) {
  const s = size / 512;
  const poly = POLY.map(p => [p[0] * s, p[1] * s]);
  const buf = Buffer.alloc(size * size * 4);
  const SS = 3; // 3x3 supersample for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++)
        if (inPoly(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, poly)) cov++;
      cov /= SS * SS;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) buf[i + c] = Math.round(BG[c] * (1 - cov) + FG[c] * cov);
      buf[i + 3] = 255;
    }
  }
  return buf;
}

const CRCTAB = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRCTAB[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const names = { 512: 'icon-512.png', 192: 'icon-192.png', 180: 'apple-touch-icon.png', 32: 'favicon-32.png' };
for (const size of [512, 192, 180, 32]) fs.writeFileSync(path.join(OUT, names[size]), png(size, render(size)));
fs.copyFileSync(path.join(OUT, 'icon-512.png'), path.join(OUT, 'icon-maskable-512.png'));
console.log('icons written to', OUT);
