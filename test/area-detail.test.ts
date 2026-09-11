import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

type Ability = {
  name: string;
  effect: string | null;
  element: string | null;
  area: null | {
    key: string; width: number; height: number; cells: number[];
    ascii: string; effectTiles: number; effectOnCaster: boolean;
  };
};

type Handle = Awaited<ReturnType<typeof connect>>;

const abilitiesOf = async (h: Handle, name: string, includeInactive = false): Promise<Ability[]> => {
  const res = await h.client.callTool({
    name: 'tibia_get',
    arguments: { name, ...(includeInactive ? { include_inactive: true } : {}) },
  });
  assert.notEqual(res.isError, true, `${name}: ${JSON.stringify(res.content)}`);
  const out = res.structuredContent as { abilities?: Ability[] };
  assert.ok(out.abilities, `${name} should resolve to a creature with abilities`);
  return out.abilities;
};

/** Opens one connection, runs the body, and always closes it. */
const withServer = async <T>(fn: (h: Handle) => Promise<T>): Promise<T> => {
  const h = await connect();
  try { return await fn(h); } finally { await h.close(); }
};
const find = (list: Ability[], name: string): Ability => {
  const hit = list.find((a) => a.name === name);
  assert.ok(hit, `${name} should be present`);
  return hit;
};

const WAVE = [
  '. . . . . . # # #',
  '. . . # # # # # #',
  '@ # # # # # # # #',
  '. . . * # # # # #',
  '. . . . . . # # #',
].join('\n');

test("Dragon's Fire Wave returns the 8sqmwave cone", async () => withServer(async (h) => {
  const area = find(await abilitiesOf(h, 'Dragon'), 'Fire Wave').area;
  assert.ok(area, 'Fire Wave must carry an area');
  assert.equal(area.key, '8sqmwave');
  assert.equal(area.width, 9);
  assert.equal(area.height, 5);
  assert.equal(area.ascii, WAVE);
}));

/**
 * The regression that matters most. A fallback tier matches precisely when the
 * dropped component differs, so 39.7% of real joins store an identity that differs
 * from what the page's wikitext supplied. Bonelord writes its element positionally
 * rather than as `element=`, so every one of its abilities joins on a fallback tier.
 * A tier-1 anchor such as Fire Wave cannot detect a regression here.
 */
test('an ability joined on a fallback tier still resolves at runtime', async () => withServer(async (h) => {
  const bonelord = await abilitiesOf(h, 'Bonelord');
  const strike = find(bonelord, 'Death Strike');
  assert.equal(strike.element, 'death');
  assert.ok(strike.area, 'a tier-2 join must still be retrievable, not silently null');
  assert.equal(strike.area.key, '7sqmstrike');

  // Not one lucky row: every Bonelord strike is a fallback join.
  const withAreas = bonelord.filter((a) => a.area !== null);
  assert.ok(withAreas.length >= 5, `expected several areas, got ${withAreas.length}`);
}));

test('an ability whose element is empty still resolves', async () => withServer(async (h) => {
  // Demon's Distance Paralyze carries effect '?' and element '', the shape that a
  // naive `=` join against a NULL-or-empty upstream column gets wrong.
  const paralyze = find(await abilitiesOf(h, 'Demon'), 'Distance Paralyze');
  assert.equal(paralyze.element, '');
  assert.ok(paralyze.area, 'an empty-element ability must not lose its area');
}));

test('effect_on_caster reaches the response as a boolean', async () => withServer(async (h) => {
  const heal = find(await abilitiesOf(h, 'Dragon'), 'Self-Healing');
  assert.ok(heal.area);
  assert.equal(heal.area.effectOnCaster, true);

  const wave = find(await abilitiesOf(h, 'Dragon'), 'Fire Wave');
  assert.equal(wave.area?.effectOnCaster, false);
}));

test('a grid using extra-sprite cells keeps them', async () => withServer(async (h) => {
  const aoe = find(await abilitiesOf(h, 'The Rootkraken'), 'Death and Holy AoE');
  assert.ok(aoe.area);
  assert.equal(aoe.area.key, 'rootkraken1');
  assert.equal(aoe.area.height, 13);
  assert.ok(aoe.area.ascii.includes('4'), 'extra sprite cells must survive to the wire');
}));

/**
 * Two abilities share the name `Self-Healing` and differ only in effect. Dropping
 * the effect clause from the join makes each one match both stored rows, so the
 * left join emits the ability twice - a duplicated ability list rather than a
 * missing area, which no null-check would catch.
 */
test('abilities sharing a name are matched on effect, not duplicated', async () => withServer(async (h) => {
  // Infernatil is a test-server page, so it needs include_inactive.
  const abilities = await abilitiesOf(h, 'Infernatil', true);
  const heals = abilities.filter((a) => a.name === 'Self-Healing');
  assert.equal(heals.length, 2, 'exactly two rows, not a cross product');
  assert.deepEqual(heals.map((a) => a.effect).sort(), ['2000-3000', '5000-10000']);
  assert.ok(heals.every((a) => a.area?.key === 'buffspell'));
}));

test('an element containing a space survives to the runtime join', async () => withServer(async (h) => {
  // `element=fire field` is the value a regex of ([a-z]+) truncates at the space.
  const fields = find(await abilitiesOf(h, 'Demon'), 'Shoots Fire Field');
  assert.equal(fields.element, 'fire field');
  assert.ok(fields.area, 'a space in the element must not lose the area');
  assert.equal(fields.area.key, '3sqmstrike');
}));

/**
 * The area join must never multiply rows. A creature's ability list has to match
 * creature_ability exactly; a join that over-matches (dropping creature_id, or the
 * effect clause) silently duplicates abilities instead of losing them.
 *
 * A targeted "one creature gets another's grid" assertion is not written here on
 * purpose: no two fixture creatures share an identical (name, effect, element)
 * where only one has an area, so such a test could not fail for the right reason.
 */
test('the area join returns each ability exactly once', async () => withServer(async (h) => {
  const counts = new Map<string, number>();
  for (const name of ['Dragon', 'Bonelord', 'Demon', 'The Rootkraken']) {
    const abilities = await abilitiesOf(h, name);
    const seen = new Set<string>();
    for (const a of abilities) {
      const identity = `${a.name}\u0000${a.effect}\u0000${a.element}`;
      assert.ok(!seen.has(identity), `${name} returned "${a.name}" more than once`);
      seen.add(identity);
    }
    counts.set(name, abilities.length);
  }
  assert.equal(counts.get('Dragon'), 4, 'Dragon has exactly four ability rows');
  assert.equal(counts.get('Bonelord'), 8, 'Bonelord has exactly eight');
}));

test('an ability with no matched scene returns null, never an empty grid', async () => withServer(async (h) => {
  const melee = find(await abilitiesOf(h, 'Dragon'), 'Melee');
  assert.equal(melee.area, null);
}));

test('a creature with no scenes at all returns every ability with a null area', async () => withServer(async (h) => {
  const abilities = await abilitiesOf(h, 'Rotworm');
  assert.ok(abilities.length > 0);
  // Accepting "null or any string" would pass even if every ability were handed an
  // unrelated grid. Rotworm has no scenes upstream, so every area must be null.
  assert.deepEqual(abilities.map((a) => a.area), abilities.map(() => null));
}));

test('the legend ships once in the tool description, not per area', async () => withServer(async (h) => {
  const { tools } = await h.client.listTools();
  const get = tools.find((t) => t.name === 'tibia_get');
  assert.ok(get);
  assert.match(get.description ?? '', /caster/i);
  assert.match(get.description ?? '', /target/i);

  // Repeating it per ability would cost ~400 bytes six times over for one creature.
  const wave = find(await abilitiesOf(h, 'Dragon'), 'Fire Wave');
  assert.ok(wave.area);
  assert.ok(!('legend' in wave.area), 'the legend must not be duplicated onto every area');
}));

test('tools/list stays within its byte budget', async () => withServer(async (h) => {
  const { tools } = await h.client.listTools();
  const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  assert.ok(bytes < 30_000, `tools/list is ${bytes} bytes, over the 30,000 budget`);
}));
