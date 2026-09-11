import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSceneRefs } from '../src/indexer/ability-scenes.ts';

type Row = { name: string; effect: string | null; element: string | null };

/**
 * Ability rows are copied verbatim from the real index, so the join is not
 * author-invented on both sides. Source: the creature named in each comment.
 */
const DRAGON: Row[] = [
  { name: 'Fire Wave', effect: '100-170', element: 'fire' },
  { name: 'Great Fireball', effect: '60-140', element: 'fire' },
  { name: 'Melee', effect: '0-120', element: 'physical' },
  { name: 'Self-Healing', effect: '40-70', element: 'healing' },
];
const ROOTKRAKEN: Row[] = [
  { name: 'Root', effect: '?', element: 'rooted' },
  { name: 'Death and Holy AoE', effect: '', element: '' },
  { name: 'Earth and Rootting AoE', effect: '', element: 'earth' },
  { name: 'Death Strike', effect: '', element: 'death' },
];

const scene = (key: string, extra = '') => `scene={{Scene|spell=${key}|effect=X${extra}}}`;
const only = (r: ReturnType<typeof extractSceneRefs>) => {
  assert.equal(r.refs.length, 1, `expected one ref, got ${r.refs.length}`);
  return r.refs[0]!;
};

test('a nested Scene inside an Ability yields its pattern key', () => {
  // Verbatim shape from the Dragon page, including the newline before |scene=.
  const wt = `|{{Ability|Fire Wave|100-170|element=fire\n  |${scene('8sqmwave')}}}`;
  const ref = only(extractSceneRefs(wt, DRAGON));
  assert.equal(ref.patternKey, '8sqmwave');
  assert.equal(ref.abilityName, 'Fire Wave');
});

test('a trailing newline after element= does not truncate the value', () => {
  // 32% of real |element= occurrences carry trailing whitespace or a newline.
  const wt = `|{{Ability|Fire Wave|100-170|element=fire\n  |${scene('8sqmwave')}}}`;
  const r = extractSceneRefs(wt, DRAGON);
  assert.equal(r.stats.joined, 1);
  assert.equal(only(r).abilityElement, 'fire');
});

test('element values containing spaces are kept whole', () => {
  const rows: Row[] = [{ name: 'Fire Field', effect: '10', element: 'fire field' }];
  const wt = `|{{Ability|Fire Field|10|element=fire field|${scene('8sqmwave')}}}`;
  assert.equal(only(extractSceneRefs(wt, rows)).abilityElement, 'fire field');
});

test('a wiki-linked ability name collapses to its display text', () => {
  const rows: Row[] = [{ name: 'Throws Knives', effect: '10-20', element: 'physical' }];
  const wt = `|{{Ability|Throws [[Distance Fighting|Knives]]|10-20|element=physical|${scene('8sqmwave')}}}`;
  assert.equal(only(extractSceneRefs(wt, rows)).abilityName, 'Throws Knives');
});

test('a Healing member maps to Self-Healing with element healing', () => {
  const wt = `|{{Healing|range=40-70\n  |${scene('buffspell', '|effect_on_caster=yes')}}}`;
  const ref = only(extractSceneRefs(wt, DRAGON));
  assert.equal(ref.abilityName, 'Self-Healing');
  assert.equal(ref.abilityEffect, '40-70');
  assert.equal(ref.abilityElement, 'healing');
  assert.equal(ref.effectOnCaster, true);
});

test('an absent damage argument maps to the ? default', () => {
  const rows: Row[] = [{ name: 'Root', effect: '?', element: 'rooted' }];
  const wt = `|{{Ability|Root|element=rooted|${scene('8sqmwave')}}}`;
  assert.equal(only(extractSceneRefs(wt, rows)).abilityEffect, '?');
});

test('an empty-string row joins and keeps its empty identity', () => {
  // The Rootkraken supplies element= with an empty value; row is ('', '').
  const wt = `|{{Ability|Death and Holy AoE||element=|${scene('rootkraken1')}}}`;
  const ref = only(extractSceneRefs(wt, ROOTKRAKEN));
  assert.equal(ref.abilityEffect, '');
  assert.equal(ref.abilityElement, '');
  assert.equal(ref.patternKey, 'rootkraken1');
});

test('a tier-2 join carries the matched ROW identity, not the extracted text', () => {
  // The wikitext omits element=; the generator's row defaults it to physical.
  // Storing the extracted '' would make this row unretrievable at runtime -
  // 39.7% of all real joins are tier-2 or tier-3 and every one of them drifts.
  const rows: Row[] = [{ name: 'Smoke Wave', effect: '1300-1500', element: 'physical' }];
  const wt = `|{{Ability|Smoke Wave|1300-1500|${scene('8sqmwave')}}}`;
  const ref = only(extractSceneRefs(wt, rows));
  assert.equal(ref.abilityElement, 'physical', 'must be the row value, not the extracted one');
  assert.equal(ref.abilityEffect, '1300-1500');
});

test('a tier-3 join also carries the matched row identity', () => {
  const rows: Row[] = [{ name: 'Energy Beam', effect: '300-400', element: 'energy' }];
  const wt = `|{{Ability|Energy Beam|${scene('8sqmwave')}}}`;
  const ref = only(extractSceneRefs(wt, rows));
  assert.equal(ref.abilityEffect, '300-400');
  assert.equal(ref.abilityElement, 'energy');
});

test('a supplied element is never dropped to reach a contradicting row', () => {
  const rows: Row[] = [{ name: 'Ice Strike', effect: '50', element: 'ice' }];
  const wt = `|{{Ability|Ice Strike|50|element=fire|${scene('8sqmwave')}}}`;
  const r = extractSceneRefs(wt, rows);
  assert.equal(r.refs.length, 0, 'fire must not fall back onto an ice row');
  assert.equal(r.stats.noRow, 1);
});

test('a Haste member is discarded, never mapped by element', () => {
  const rows: Row[] = [{ name: 'Haste', effect: '', element: 'haste' }];
  const wt = `|{{Haste|${scene('buffspell')}}}`;
  const r = extractSceneRefs(wt, rows);
  assert.equal(r.refs.length, 0);
  assert.equal(r.stats.discardedKind, 1);
  assert.equal(r.stats.joined, 0);
});

test('a rotate90 Scene is discarded rather than stored transposed', () => {
  const wt = `|{{Ability|Fire Wave|100-170|element=fire|scene={{Scene|spell=8sqmwave|rotate90=yes}}}}`;
  const r = extractSceneRefs(wt, DRAGON);
  assert.equal(r.refs.length, 0);
  assert.equal(r.stats.discardedRotate, 1);
});

test('a Scene with no spell= is discarded', () => {
  const wt = `|{{Ability|Fire Wave|100-170|element=fire|scene={{Scene|input_array=0,1,0}}}}`;
  const r = extractSceneRefs(wt, DRAGON);
  assert.equal(r.refs.length, 0);
  assert.equal(r.stats.discardedNoSpell, 1);
});

test('a non-canonical member opener is counted, not silently skipped', () => {
  // 18 real scenes sit behind openers like `{{Ability |`. The generator emits no
  // row for them, so discarding is right - but they must stay visible, or a parser
  // regression would shrink the denominator and RAISE the reported success rate.
  const wt = `|{{Ability |Fire Wave|100-170|element=fire|${scene('8sqmwave')}}}`;
  const r = extractSceneRefs(wt, DRAGON);
  assert.equal(r.refs.length, 0);
  assert.equal(r.stats.unparsedMember, 1);
  assert.equal(r.stats.scenes, 1, 'the scene still counts toward the total');
});

test('an ambiguous name yields no ref', () => {
  const rows: Row[] = [
    { name: 'Twin', effect: '1', element: 'fire' },
    { name: 'Twin', effect: '2', element: 'ice' },
  ];
  const wt = `|{{Ability|Twin|${scene('8sqmwave')}}}`;
  const r = extractSceneRefs(wt, rows);
  assert.equal(r.refs.length, 0);
  assert.equal(r.stats.ambiguous, 1);
});

test('counters are mutually exclusive and sum to the scene total', () => {
  const wt = [
    `|{{Ability|Fire Wave|100-170|element=fire|${scene('8sqmwave')}}}`,
    `|{{Haste|${scene('buffspell')}}}`,
    `|{{Ability|Nonexistent|${scene('8sqmwave')}}}`,
    `|{{Ability |Fire Wave|100-170|element=fire|${scene('8sqmwave')}}}`,
    `|{{Ability|Great Fireball|60-140|element=fire|scene={{Scene|spell=x|rotate90=yes}}}}`,
  ].join('\n');
  const s = extractSceneRefs(wt, DRAGON).stats;
  assert.equal(s.scenes, 5);
  const outcomes = s.joined + s.ambiguous + s.noRow
    + s.discardedKind + s.discardedNoSpell + s.discardedRotate + s.unparsedMember;
  assert.equal(outcomes, s.scenes, 'every scene lands in exactly one bucket');
  assert.equal(s.joined, 1);
});

test('Melee and Summon mappings are defensive only', () => {
  // No Melee or Summon member carries a scene anywhere in the live corpus, so
  // these fixtures exercise a path that never fires in production.
  const melee = extractSceneRefs(`|{{Melee|0-120|${scene('8sqmwave')}}}`, DRAGON);
  assert.equal(only(melee).abilityName, 'Melee');
  assert.equal(only(melee).abilityElement, 'physical');

  const rows: Row[] = [{ name: 'Fire Elemental', effect: '1', element: 'summon' }];
  const summon = extractSceneRefs(`|{{Summon|Fire Elemental|1|${scene('8sqmwave')}}}`, rows);
  assert.equal(only(summon).abilityElement, 'summon');
});
