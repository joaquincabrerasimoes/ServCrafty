// Generates the ServCrafty PWA icons (PNG + SVG) from a 16x16 pixel-art grid.
// Pure Node, no dependencies:  node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(join(root, 'icons'), { recursive: true });

const PALETTE = {
  bg: [0x1a, 0x1e, 0x21, 255],
  a: [0x9b, 0xd8, 0xc8, 255], // copper highlight
  b: [0x5f, 0xb3, 0xa1, 255], // copper face
  c: [0x2f, 0x7f, 0x70, 255], // copper shadow
  k: [0x14, 0x33, 0x2d, 255], // drive slot
  g: [0x4c, 0xc3, 0x8a, 255], // led on
  y: [0xe3, 0xb3, 0x41, 255], // led busy
};

// Three stacked server "blocks" with status lights.
function buildGrid() {
  const g = Array.from({ length: 16 }, () => Array(16).fill(null));
  const slabs = [
    { y: 3, led: 'g' },
    { y: 7, led: 'g' },
    { y: 11, led: 'y' },
  ];
  for (const s of slabs) {
    const y0 = Math.round(s.y);
    for (let y = y0; y < y0 + 3; y++) {
      for (let x = 2; x < 14; x++) {
        let c = 'b';
        if (y === y0 || x === 2) c = 'a';
        if (y === y0 + 2 || x === 13) c = 'c';
        if (y === y0 + 1 && x >= 4 && x <= 8) c = 'k';
        if (y === y0 + 1 && x === 11) c = s.led;
        g[y][x] = c;
      }
    }
  }
  return g;
}
const GRID = buildGrid();

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const p = pixel(x, y);
      raw.set(p, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** mode: 'any' (rounded tile, transparent corners) | 'full' (full-bleed, maskable-safe padding) */
function render(size, mode) {
  const pad = mode === 'maskable' ? 0.2 : mode === 'full' ? 0.1 : 0.08;
  const radius = mode === 'any' ? size * 0.2 : 0;
  const inner = size * (1 - pad * 2);
  const off = size * pad;
  return encodePng(size, (x, y) => {
    if (radius) {
      const cx = Math.min(Math.max(x + 0.5, radius), size - radius);
      const cy = Math.min(Math.max(y + 0.5, radius), size - radius);
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > radius) return [0, 0, 0, 0];
    }
    const gx = Math.floor(((x + 0.5 - off) / inner) * 16);
    const gy = Math.floor(((y + 0.5 - off) / inner) * 16);
    const cell = gx >= 0 && gx < 16 && gy >= 0 && gy < 16 ? GRID[gy][gx] : null;
    return PALETTE[cell ?? 'bg'];
  });
}

function svg() {
  const hex = (c) => '#' + c.slice(0, 3).map((n) => n.toString(16).padStart(2, '0')).join('');
  let rects = '';
  GRID.forEach((row, y) =>
    row.forEach((c, x) => {
      if (c) rects += `<rect x="${x + 1}" y="${y + 1}" width="1.02" height="1.02" fill="${hex(PALETTE[c])}"/>`;
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" shape-rendering="crispEdges"><rect width="18" height="18" rx="3.6" fill="${hex(PALETTE.bg)}"/>${rects}</svg>\n`;
}

writeFileSync(join(root, 'icons', 'icon-192.png'), render(192, 'any'));
writeFileSync(join(root, 'icons', 'icon-512.png'), render(512, 'any'));
writeFileSync(join(root, 'icons', 'maskable-192.png'), render(192, 'maskable'));
writeFileSync(join(root, 'icons', 'maskable-512.png'), render(512, 'maskable'));
writeFileSync(join(root, 'apple-touch-icon.png'), render(180, 'full'));
writeFileSync(join(root, 'favicon.svg'), svg());
console.log('icons written to', root);
