import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Generates the golden frames for test/spell-decode.test.ts.
 *
 * The invariant these fixtures exist to encode: EVERY DELTA FRAME IS FULLY OPAQUE
 * ACROSS ITS RECT, repainting the floor colour everywhere except the effect cells.
 *
 * That is the real-world condition - TibiaWiki's animations redraw the grey floor in
 * each delta - and it is what makes the opacity-regression test meaningful. A fixture
 * with a transparent background would let the broken "any non-transparent pixel"
 * classifier produce the right answer, and the guard would prove nothing. Generating
 * them here rather than committing hand-made images keeps that property enforced.
 */

const TILE = 32;
const FLOOR: [number, number, number] = [128, 128, 128];
const EFFECT: [number, number, number] = [240, 90, 20];

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width); iv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Paints a full-canvas, fully opaque frame: floor everywhere, effect on `cells`. */
function frame(cols: number, rows: number, cells: ReadonlyArray<readonly [number, number]>): Uint8Array {
  const [w, h] = [cols * TILE, rows * TILE];
  const px = new Uint8Array(w * h * 4);
  const lit = new Set(cells.map(([x, y]) => `${x},${y}`));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const c = lit.has(`${Math.floor(x / TILE)},${Math.floor(y / TILE)}`) ? EFFECT : FLOOR;
      const i = (y * w + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return encodePng(w, h, px);
}

const plate = (cols: number, rows: number) => frame(cols, rows, []);

const CONE: ReadonlyArray<readonly [number, number]> = [
  [2, 0], [1, 1], [2, 1], [3, 1], [1, 2], [2, 2], [3, 2], [0, 3], [1, 3], [2, 3], [3, 3], [4, 3],
];
const CIRCLE: ReadonlyArray<readonly [number, number]> = (() => {
  const out: Array<readonly [number, number]> = [];
  const widths = [3, 5, 7, 7, 7, 5, 3];
  widths.forEach((w, y) => {
    const start = (7 - w) / 2;
    for (let i = 0; i < w; i += 1) out.push([start + i, y] as const);
  });
  return out;
})();

const dir = fileURLToPath(new URL('../test/fixtures/spell-frames/', import.meta.url));
mkdirSync(dir, { recursive: true });

const cases: Array<[string, number, number, ReadonlyArray<readonly [number, number]>]> = [
  ['cone', 5, 4, CONE],
  ['strike', 3, 3, [[1, 1]]],
  ['square3', 3, 3, [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]]],
  ['beam', 3, 7, [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4]]],
  ['circle', 7, 7, CIRCLE],
];
for (const [name, cols, rows, cells] of cases) {
  writeFileSync(`${dir}${name}-plate.png`, plate(cols, rows));
  writeFileSync(`${dir}${name}-delta.png`, frame(cols, rows, cells));
}

// A two-delta case where the union differs from the winning frame, so an
// implementation that took the first frame or unioned everything is caught.
writeFileSync(`${dir}multi-plate.png`, plate(5, 4));
// [0, 0] is OUTSIDE the cone, so union(small, big) !== big. Without a cell outside,
// a union classifier produces exactly `big` and the "not the union" test proves nothing.
writeFileSync(`${dir}multi-delta-small.png`, frame(5, 4, [[0, 0], [2, 1], [2, 2]]));
writeFileSync(`${dir}multi-delta-big.png`, frame(5, 4, CONE));

console.log(`wrote ${cases.length * 2 + 3} golden frames to ${dir}`);
console.log('every delta is fully opaque across the canvas - that is the point');
