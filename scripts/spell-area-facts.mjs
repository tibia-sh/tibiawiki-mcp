#!/usr/bin/env node
/**
 * Derives the Verified Facts figures for the spell-area plan from the spike's
 * measurement artefact. Three successive hand-derived counts of these were wrong,
 * because four overlapping sets - images, spell-image associations, spells, and
 * shape families - have near-equal cardinalities. Read the numbers, do not retype them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @typedef {{ w: number, h: number, mask: number[][] }} Decoded */

const path = fileURLToPath(new URL('../docs/superpowers/spikes/2026-09-12-spell-areas-measured.json', import.meta.url));
/** @type {{ images: Record<string, Decoded>, spellImages: Record<string, string[]> }} */
const { images, spellImages } = JSON.parse(readFileSync(path, 'utf8'));

/** Crop to the affected bounding box: raw canvases differ by padding alone. */
/** @type {(d: Decoded) => string | null} */
const normalise = ({ mask }) => {
  /** @type {number[]} */ const ys = [];
  /** @type {number[]} */ const xs = [];
  for (let y = 0; y < mask.length; y += 1) {
    const row = mask[y] ?? [];
    for (let x = 0; x < row.length; x += 1) {
      if (row[x]) { ys.push(y); xs.push(x); }
    }
  }
  if (ys.length === 0) return null;
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  return JSON.stringify(mask.slice(y0, y1 + 1).map((row) => row.slice(x0, x1 + 1)));
};

/** @type {Record<string, string | null>} */
const shapeOf = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, normalise(v)]));
/** @type {Record<string, string[]>} */
const imagesByShape = {};
for (const [img, s] of Object.entries(shapeOf)) {
  if (s !== null) (imagesByShape[s] ??= []).push(img);
}

const assoc = Object.values(spellImages).reduce((n, f) => n + f.length, 0);
/** @type {Record<string, number>} */
const useCount = {};
for (const f of Object.values(spellImages).flat()) useCount[f] = (useCount[f] ?? 0) + 1;
const shared = Object.entries(useCount).filter(([, n]) => n > 1);

/** @type {string[]} */ const excluded = [];
/** @type {string[]} */ const sameSpell = [];
/** @type {string[]} */ const family = [];
/** @type {string[]} */ const alone = [];
for (const [spell, imgs] of Object.entries(spellImages)) {
  const shapes = new Set(imgs.map((/** @type {string} */ i) => shapeOf[i]).filter((x) => x !== null));
  if (shapes.size !== 1) { excluded.push(spell); continue; }
  const [s] = [...shapes];
  if (imgs.length > 1) sameSpell.push(spell);
  else if ((imagesByShape[s ?? ''] ?? []).length > 1) family.push(spell);
  else alone.push(spell);
}

const served = sameSpell.length + family.length + alone.length;
console.log(`unique area images                 ${Object.keys(images).length}`);
console.log(`spell-image associations           ${assoc}`);
console.log(`spells covered                     ${Object.keys(spellImages).length}`);
console.log(`images shared by two spells        ${shared.length}  (${shared.map(([f]) => f).join(', ')})`);
console.log(`distinct shapes                    ${Object.keys(imagesByShape).length}`);
console.log(`excluded (images disagree)         ${excluded.length}  (${excluded.join(', ') || '-'})`);
console.log(`SERVED                             ${served}`);
console.log(`  corroborated by a 2nd image      ${sameSpell.length}`);
console.log(`  family-corroborated              ${family.length}`);
console.log(`  wholly uncorroborated            ${alone.length}  (${alone.join(', ')})`);
