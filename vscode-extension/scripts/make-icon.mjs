/**
 * Generate the extension's marketplace icon (media/icon.png) with zero dependencies:
 * a brand-pink tile with three stacked white "container" bars (the service stack).
 * A deliberate placeholder — replace media/icon.png with real artwork before publish.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const PINK = [0xff, 0x6f, 0xb5];
const WHITE = [0xf7, 0xf7, 0xf7];

const px = Buffer.alloc(SIZE * SIZE * 4);
function set(x, y, [r, g, b]) {
  const i = (y * SIZE + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = 0xff;
}

/** Fill a rounded rectangle (corners clipped to a quarter-circle of `radius`). */
function roundRect(x0, y0, w, h, radius, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.min(x - x0, x0 + w - 1 - x);
      const dy = Math.min(y - y0, y0 + h - 1 - y);
      if (dx < radius && dy < radius) {
        // Inside a corner region: clip to the quarter-circle around the corner center.
        const ccx = x - x0 < radius ? x0 + radius : x0 + w - 1 - radius;
        const ccy = y - y0 < radius ? y0 + radius : y0 + h - 1 - radius;
        if ((x - ccx) ** 2 + (y - ccy) ** 2 > radius * radius) continue;
      }
      set(x, y, color);
    }
  }
}

// Background + three stacked bars.
roundRect(0, 0, SIZE, SIZE, 48, PINK);
const barX = 44;
const barW = SIZE - 88;
const barH = 34;
for (let i = 0; i < 3; i++) {
  roundRect(barX, 70 + i * 52, barW, barH, 10, WHITE);
}

// --- encode PNG (truecolor+alpha, one filter byte per scanline) ---
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const CRC = (() => {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(typeData), 0);
  return Buffer.concat([len, typeData, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), 'media', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
