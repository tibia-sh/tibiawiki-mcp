import { inflateSync } from 'node:zlib';
import type { Mask } from '../src/area.ts';

/**
 * Decodes a TibiaWiki spell-area animation into a tile mask. Offline only.
 *
 * This file lives under `scripts/` and not `src/` on purpose: `tsconfig.build.json`
 * sets `rootDir: src`, so nothing here can reach `dist/` and the server cannot import
 * it by accident. It imports `Mask` from `src/area.ts`; the reverse direction is
 * TS6059 and fails the build.
 *
 * The classifier's one non-obvious rule is in `classify()`. Getting it wrong the
 * first time produced confidently wrong shapes for every image but one - see
 * docs/superpowers/spikes/2026-09-12-spell-area-decoding.md.
 */

export type Frame = { x: number; y: number; width: number; height: number; pixels: Uint8Array };
export type ClassifyOptions = { tileSize?: number; tolerance?: number; relativeThreshold?: number };

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Minimal non-interlaced 8-bit PNG reader. Returns RGBA, four bytes per pixel. */
export function readPng(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error('Not a PNG.');

  let pos = 8;
  let width = 0, height = 0, colour = 0, depth = 0;
  let palette: Uint8Array | undefined;
  let alpha: Uint8Array | undefined;
  const idat: Uint8Array[] = [];

  while (pos < bytes.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') {
      width = view.getUint32(pos - 12 - length + 8);
      height = view.getUint32(pos - 12 - length + 12);
      depth = body[8]!; colour = body[9]!;
      if (depth !== 8 || body[12] !== 0) throw new Error(`Unsupported PNG: depth ${depth}, interlace ${body[12]}.`);
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') alpha = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colour}.`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let p = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[p]!;
    const line = Uint8Array.prototype.slice.call(raw, p + 1, p + 1 + stride);
    p += 1 + stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      if (filter === 1) line[i] = (line[i]! + a) & 255;
      else if (filter === 2) line[i] = (line[i]! + b) & 255;
      else if (filter === 3) line[i] = (line[i]! + ((a + b) >> 1)) & 255;
      else if (filter === 4) line[i] = (line[i]! + paeth(a, b, c)) & 255;
    }
    prev = line;
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (colour === 6) out.set(line.subarray(s, s + 4), d);
      else if (colour === 2) { out.set(line.subarray(s, s + 3), d); out[d + 3] = 255; }
      else if (colour === 4) { out.fill(line[s]!, d, d + 3); out[d + 3] = line[s + 1]!; }
      else if (colour === 0) { out.fill(line[s]!, d, d + 3); out[d + 3] = 255; }
      else {
        const i = line[s]!;
        out[d] = palette![i * 3]!; out[d + 1] = palette![i * 3 + 1]!; out[d + 2] = palette![i * 3 + 2]!;
        out[d + 3] = alpha && i < alpha.length ? alpha[i]! : 255;
      }
    }
  }
  return { width, height, pixels: out };
}

/**
 * Splits an animated WebP into its frames, rewrapping each ANMF payload as a
 * standalone still WebP that an image tool can convert.
 *
 * The x/y offsets are load-bearing: ANMF stores them divided by two, and a frame
 * placed at the wrong offset shifts every tile it touches.
 */
export function extractWebpFrames(webp: Uint8Array): Array<{ x: number; y: number; payload: Uint8Array }> {
  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  const tag = (at: number) => String.fromCharCode(...webp.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') throw new Error('Not a WebP container.');

  const out: Array<{ x: number; y: number; payload: Uint8Array }> = [];
  const u24 = (at: number) => webp[at]! | (webp[at + 1]! << 8) | (webp[at + 2]! << 16);

  for (let pos = 12; pos + 8 <= webp.length; ) {
    const type = tag(pos);
    const size = view.getUint32(pos + 4, true);
    if (type === 'ANMF') {
      const body = pos + 8;
      let sub = new Uint8Array(0);
      for (let q = body + 16; q + 8 <= body + size; ) {
        const st = tag(q);
        const ss = view.getUint32(q + 4, true);
        if (st === 'VP8 ' || st === 'VP8L' || st === 'ALPH') {
          const chunk = webp.subarray(q, q + 8 + ss + (ss & 1));
          const merged = new Uint8Array(sub.length + chunk.length);
          merged.set(sub); merged.set(chunk, sub.length);
          sub = merged;
        }
        q += 8 + ss + (ss & 1);
      }
      if (sub.length > 0) {
        const payload = new Uint8Array(12 + sub.length);
        payload.set([0x52, 0x49, 0x46, 0x46]);
        new DataView(payload.buffer).setUint32(4, 4 + sub.length, true);
        payload.set([0x57, 0x45, 0x42, 0x50], 8);
        payload.set(sub, 12);
        out.push({ x: u24(body) * 2, y: u24(body + 3) * 2, payload });
      }
    }
    pos += 8 + size + (size & 1);
  }
  return out;
}

/**
 * Marks a tile affected when its pixels DIFFER FROM THE BACKGROUND PLATE.
 *
 * Not "non-transparent". These animations' delta frames redraw the opaque grey floor,
 * so counting opaque pixels marks every tile the frame covers and collapses every
 * shape to its bounding box - a cone reads as a rectangle. `tolerance: -1` reproduces
 * that bug exactly, which is how the regression test asserts it stays fixed.
 *
 * The threshold is relative to the most-covered tile of the selected frame because
 * sprite density varies enormously between a dense explosion and a thin slash.
 */
export function classify(
  background: Frame,
  deltas: readonly Frame[],
  opts: ClassifyOptions = {},
): Mask {
  const tile = opts.tileSize ?? 32;
  const tolerance = opts.tolerance ?? 40;
  const relative = opts.relativeThreshold ?? 0.25;
  const [cols, rows] = [Math.ceil(background.width / tile), Math.ceil(background.height / tile)];

  let best: Mask = { width: cols, height: rows, cells: new Array(cols * rows).fill(0) };
  let bestCount = -1;

  for (const delta of deltas) {
    const counts = new Array<number>(cols * rows).fill(0);
    for (let y = 0; y < delta.height; y += 1) {
      for (let x = 0; x < delta.width; x += 1) {
        const s = (y * delta.width + x) * 4;
        if (delta.pixels[s + 3]! <= 16) continue;
        const [gx, gy] = [delta.x + x, delta.y + y];
        if (gx < 0 || gy < 0 || gx >= background.width || gy >= background.height) continue;
        const b = (gy * background.width + gx) * 4;
        const diff = Math.abs(delta.pixels[s]! - background.pixels[b]!)
          + Math.abs(delta.pixels[s + 1]! - background.pixels[b + 1]!)
          + Math.abs(delta.pixels[s + 2]! - background.pixels[b + 2]!);
        if (diff > tolerance) counts[Math.floor(gy / tile) * cols + Math.floor(gx / tile)]! += 1;
      }
    }
    const max = Math.max(...counts);
    if (max === 0) continue;
    const cells: number[] = counts.map((c) => (c > max * relative ? 1 : 0));
    const hit = cells.reduce((n, c) => n + c, 0);
    if (hit > bestCount) { bestCount = hit; best = { width: cols, height: rows, cells }; }
  }
  return best;
}
