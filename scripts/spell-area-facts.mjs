#!/usr/bin/env node
/**
 * Derives the Verified Facts figures for the spell-area plan from the spike's
 * measurement artefact. Three successive hand-derived counts of these were wrong,
 * because four overlapping sets - images, spell-image associations, spells, and
 * shape families - have near-equal cardinalities. Read the numbers, do not retype them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../docs/superpowers/spikes/2026-09-12-spell-areas-measured.json', import.meta.url));
const { images, spellImages } = JSON.parse(readFileSync(path, 'utf8'));

/** Crop to the affected bounding box: raw canvases differ by padding alone. */
const normalise = ({ mask }) => {
  const ys = mask.flatMap((row, y) => row.some(Boolean) ? [y] : []);
  const xs = [...mask[0].keys()].filter((x) => mask.some((row) => row[x]));
  if (!ys.length) return null;
  return JSON.stringify(
    mask.slice(ys[0], ys.at(-1) + 1).map((row) => row.slice(xs[0], xs.at(-1) + 1)),
  );
};

const shapeOf = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, normalise(v)]));
const imagesByShape = {};
for (const [img, s] of Object.entries(shapeOf)) (imagesByShape[s] ??= []).push(img);

const assoc = Object.values(spellImages).reduce((n, f) => n + f.length, 0);
const shared = Object.entries(
  Object.values(spellImages).flat().reduce((m, f) => ((m[f] = (m[f] ?? 0) + 1), m), {}),
).filter(([, n]) => n > 1);

let excluded = [], sameSpell = [], family = [], alone = [];
for (const [spell, imgs] of Object.entries(spellImages)) {
  const shapes = new Set(imgs.map((i) => shapeOf[i]).filter(Boolean));
  if (shapes.size !== 1) { excluded.push(spell); continue; }
  const [s] = [...shapes];
  if (imgs.length > 1) sameSpell.push(spell);
  else if (imagesByShape[s].length > 1) family.push(spell);
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
