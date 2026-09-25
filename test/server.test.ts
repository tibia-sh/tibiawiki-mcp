import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVINCE_COST_MEANING, FARE_MEANING, GOLD_PER_KILL_MEANING, IMAGE_MEANING, RASHID_PLACE_MEANING,
  RUNS_AT_MEANING, SUMMON_COST_MEANING, inGameNameSchema, inGamePluralSchema, inGameArticleSchema,
} from '../src/domain.ts';
import { CAPABILITIES } from '../src/server.ts';
import { connect, connectTo, FIXTURE } from './harness.ts';

/**
 * Claude Code cuts server instructions and each tool description at 2,048 characters,
 * silently (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH), and a cut drops the end.
 */
const CLAUDE_CODE_CUT = 2048;
const LICENCE = 'licensed CC BY-SA.';

/**
 * The `initialize` instructions and `tools/list` of a server on the fixture that reports
 * the provenance of a real index, since the instructions carry it and its length counts.
 */
async function realisticHandshake() {
  const h = await connectTo(FIXTURE, {
    generatedAt: '2026-09-24T00:58:39.504571+00:00', version: '9.0.0',
  });
  try {
    return { instructions: String(h.client.getInstructions()), tools: (await h.client.listTools()).tools };
  } finally {
    await h.close();
  }
}

test('tools/list advertises tibia_get as read-only', async () => {
  const h = await connect();
  const { tools } = await h.client.listTools();
  const get = tools.find((t) => t.name === 'tibia_get');
  assert.ok(get, 'tibia_get should be registered');
  assert.equal(get.annotations?.readOnlyHint, true);
  assert.equal(get.annotations?.openWorldHint, false);
  await h.close();
});

test('the server instructions carry provenance and the CC-BY-SA attribution', async () => {
  const h = await connect();
  const instructions = h.client.getInstructions();
  assert.match(String(instructions), /CC BY-SA/);
  assert.match(String(instructions), /CipSoft/);
  assert.match(String(instructions), /9\.0\.0/);
  await h.close();
});

test('Claude Code\'s cut drops neither the instructions\' end nor any tool description\'s', async () => {
  const { instructions, tools } = await realisticHandshake();
  assert.ok(instructions.length <= CLAUDE_CODE_CUT, `instructions: ${instructions.length} characters`);
  const licence = instructions.indexOf(LICENCE);
  assert.ok(licence !== -1, 'the instructions carry the licence');
  assert.ok(licence + LICENCE.length <= CLAUDE_CODE_CUT, 'the licence falls inside the cut');
  for (const tool of tools) {
    const length = (tool.description ?? '').length;
    assert.ok(length <= CLAUDE_CODE_CUT, `${tool.name}'s description is ${length} characters`);
  }
});

// The facts that no other test pins, so trimming the instructions cannot drop them.
test('the instructions keep the snapshot, modifier and spell-area caveats', async () => {
  const { instructions } = await realisticHandshake();
  assert.match(instructions, /not live game state/);
  assert.match(instructions, /Damage modifiers are percentages where 100 is neutral/);
  assert.match(instructions, /above 100 the creature takes extra damage/);
  assert.match(instructions, /present for a minority of spells/);
  assert.match(instructions, /creature area glyphs do not apply/);
});

// A host gives the model the instructions and the input schemas, not the output schemas,
// so a meaning a model needs to read a result has to reach it through the instructions.
test('the instructions tell a model what the zeros and nulls in results mean', async () => {
  const { instructions } = await realisticHandshake();
  for (const meaning of [
    `runsAt: ${RUNS_AT_MEANING}`,
    `summonCost: ${SUMMON_COST_MEANING}`,
    `convinceCost: ${CONVINCE_COST_MEANING}`,
    `goldPerKill: ${GOLD_PER_KILL_MEANING}`,
    `image: ${IMAGE_MEANING}`,
    RASHID_PLACE_MEANING,
    FARE_MEANING,
  ]) {
    assert.ok(instructions.includes(meaning), `the instructions lack: ${meaning}`);
  }
  assert.match(RUNS_AT_MEANING, /0: never flees/);
  assert.match(SUMMON_COST_MEANING, /0: cannot be summoned/);
  assert.match(CONVINCE_COST_MEANING, /0: cannot be convinced/);
  assert.match(GOLD_PER_KILL_MEANING, /^Estimated/);
  assert.match(RASHID_PLACE_MEANING, /city and position coordinates are null/);
  assert.match(FARE_MEANING, /0: free or not recorded/);
});

test('each meaning in the instructions is the description of its output fields', async () => {
  const { tools } = await realisticHandshake();
  const output = (name: string): any => tools.find((t) => t.name === name)!.outputSchema;
  const branch = (type: string): any => output('tibia_get').oneOf
    .find((b: any) => b.properties.type.const === type).properties;
  const creature = output('tibia_find_creatures').properties.results.items.properties;
  const boughtBy = branch('item').boughtBy.items.properties;
  const city = output('tibia_where_to_sell').properties.cities.items.properties;
  const route = output('tibia_find_travel').properties.results.items.properties;
  for (const [where, description, meaning] of [
    ['tibia_find_creatures runsAt', creature.runsAt.description, RUNS_AT_MEANING],
    ['tibia_find_creatures summonCost', creature.summonCost.description, SUMMON_COST_MEANING],
    ['tibia_find_creatures convinceCost', creature.convinceCost.description, CONVINCE_COST_MEANING],
    ['tibia_find_creatures goldPerKill', creature.goldPerKill.description, GOLD_PER_KILL_MEANING],
    ['tibia_get runsAt', branch('creature').runsAt.description, RUNS_AT_MEANING],
    ['tibia_get summonCost', branch('creature').summonCost.description, SUMMON_COST_MEANING],
    ['tibia_get convinceCost', branch('creature').convinceCost.description, CONVINCE_COST_MEANING],
    ['tibia_get goldPerKill', branch('creature').goldPerKill.description, GOLD_PER_KILL_MEANING],
    ['tibia_get image', branch('creature').image.description, IMAGE_MEANING],
    ['tibia_get boughtBy city', boughtBy.city.description, RASHID_PLACE_MEANING],
    ['tibia_get boughtBy position', boughtBy.position.description, RASHID_PLACE_MEANING],
    ['tibia_where_to_sell city', city.city.description, RASHID_PLACE_MEANING],
    ['tibia_where_to_sell position',
      city.buyers.items.properties.position.description, RASHID_PLACE_MEANING],
    ['tibia_get destinations price',
      branch('npc').destinations.items.properties.price.description, FARE_MEANING],
    ['tibia_find_travel price', route.price.description, FARE_MEANING],
  ] as const) {
    assert.equal(description, meaning, where);
  }
});

test('each in-game name field has one description in every tool', async () => {
  const { tools } = await realisticHandshake();
  const output = (name: string): any => tools.find((t) => t.name === name)!.outputSchema;
  const branch = (type: string): any => output('tibia_get').oneOf
    .find((b: any) => b.properties.type.const === type).properties;
  const row = (name: string): any => output(name).properties.results.items.properties;
  for (const schema of [inGameNameSchema, inGamePluralSchema, inGameArticleSchema]) {
    assert.ok(schema.description, 'guard: the schema has a description');
  }
  for (const [where, description, schema] of [
    ['tibia_get item actualName', branch('item').actualName.description, inGameNameSchema],
    ['tibia_get item plural', branch('item').plural.description, inGamePluralSchema],
    ['tibia_get creature name', branch('creature').name.description, inGameNameSchema],
    ['tibia_get creature plural', branch('creature').plural.description, inGamePluralSchema],
    ['tibia_get creature article', branch('creature').article.description, inGameArticleSchema],
    ['tibia_find_items actualName', row('tibia_find_items').actualName.description, inGameNameSchema],
    ['tibia_find_creatures name', row('tibia_find_creatures').name.description, inGameNameSchema],
  ] as const) {
    assert.equal(description, schema.description, where);
  }
});

test('the server tells clients its tool list never changes', async () => {
  const h = await connect();
  assert.equal(h.client.getServerCapabilities()?.tools?.listChanged, false);
  await h.close();
});

test('the capabilities every server is handed are frozen at both levels', () => {
  assert.ok(Object.isFrozen(CAPABILITIES), 'the capabilities object is not frozen');
  assert.ok(Object.isFrozen(CAPABILITIES.tools), 'the tools capability is not frozen');
  assert.deepEqual(CAPABILITIES, { tools: { listChanged: false } });
});

test('the instructions call the index a snapshot without assuming a transport', async () => {
  const h = await connect();
  const instructions = String(h.client.getInstructions());
  assert.match(instructions, /^TibiaWiki knowledge base: a snapshot of the wiki generated /);
  // Every transport sends these same instructions, and over a network the snapshot is
  // neither offline nor local.
  assert.doesNotMatch(instructions, /local snapshot|Offline/);
  await h.close();
});

test('tibia_get returns known-good structured data for Dragon', async () => {
  const h = await connect();
  const res = await h.client.callTool({ name: 'tibia_get', arguments: { name: 'Dragon' } });
  const data = res.structuredContent as Record<string, any>;
  assert.equal(data.type, 'creature');
  assert.equal(data.title, 'Dragon', 'must echo canonical title casing, not name="dragon"');
  assert.equal(data.hitpoints, 1000);
  assert.equal(data.experience, 700);
  assert.equal(data.modifiers.fire, 0);
  assert.equal(data.source.url, 'https://tibia.fandom.com/wiki/Dragon');
  await h.close();
});

test('tibia_get resolves a lowercase name to the canonical title', async () => {
  const h = await connect();
  const res = await h.client.callTool({ name: 'tibia_get', arguments: { name: 'dragon' } });
  assert.equal((res.structuredContent as Record<string, any>).title, 'Dragon');
  await h.close();
});

test('Dragon loot is ordered by chance ascending with nulls last', async () => {
  const h = await connect();
  const res = await h.client.callTool({ name: 'tibia_get', arguments: { name: 'Dragon' } });
  const loot = (res.structuredContent as Record<string, any>).loot as Array<{ chance: number | null }>;
  assert.ok(loot.length > 0);
  const firstNull = loot.findIndex((d) => d.chance === null);
  if (firstNull !== -1) {
    assert.ok(
      loot.slice(firstNull).every((d) => d.chance === null),
      'once nulls start they must not be followed by a non-null chance',
    );
  }
  const known = loot.find((d: any) => d.item === 'Dragonbone Staff');
  assert.ok(known, 'Dragonbone Staff should be in Dragon loot');
  assert.ok(Math.abs((known as any).chance - 0.0557) < 0.001, 'known drop chance');
  await h.close();
});

test('tibia_get returns the item shape for an item', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'Magic Longsword' },
  });
  const data = res.structuredContent as Record<string, any>;
  assert.equal(data.type, 'item');
  assert.equal(data.title, 'Magic Longsword');
  assert.equal(data.attributes.attack, 55);
  assert.equal(data.attributes.defense, 40);
  assert.equal(data.attributes.required_level, 140);
  await h.close();
});

test('tibia_get finds a spell despite spell.title lacking COLLATE NOCASE', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'light healing' },
  });
  const data = res.structuredContent as Record<string, any>;
  assert.equal(data.type, 'spell');
  assert.equal(data.title, 'Light Healing');
  await h.close();
});

test('tibia_get returns a spell description and its requirements', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'Fierce Berserk', type: 'spell' },
  });
  assert.notEqual(res.isError, true);
  const data = res.structuredContent as Record<string, any>;
  assert.match(data.effect, /^Performs a furious whirlwind attack/);
  assert.deepEqual(data.vocations, ['knight']);
  assert.equal(data.isPromotion, false);
  assert.equal(data.isWheelSpell, false);
  assert.equal(data.isPassive, false);
  assert.equal(data.basePower, 92);
  assert.equal(data.group, 'Attack');
  assert.equal(data.secondaryGroup, null);
  assert.equal(data.runeGroup, null);
  assert.equal(data.groupCooldown, 2);
  assert.equal(data.secondaryGroupCooldown, null);
  await h.close();
});

test('tibia_get lists every vocation that casts a spell, in a fixed order', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'Light Healing', type: 'spell' },
  });
  assert.notEqual(res.isError, true);
  const data = res.structuredContent as Record<string, any>;
  assert.deepEqual(data.vocations, ['sorcerer', 'druid', 'paladin', 'monk']);
  assert.equal(data.basePower, 40);
  assert.equal(data.group, 'Healing');
  assert.equal(data.groupCooldown, 1);
  await h.close();
});

test('tibia_get reports an unrecorded spell power and group cooldown as null', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'Gift of Life', type: 'spell' },
  });
  assert.notEqual(res.isError, true);
  const data = res.structuredContent as Record<string, any>;
  assert.equal(data.basePower, null);
  assert.equal(data.groupCooldown, null);
  assert.equal(data.secondaryGroupCooldown, null);
  await h.close();
});

test('an ambiguous name asks the caller to disambiguate', async () => {
  const h = await connect();
  const res = await h.client.callTool({ name: 'tibia_get', arguments: { name: 'Mud' } });
  assert.equal(res.isError, true);
  const text = (res.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /item/);
  assert.match(text, /npc/);
  await h.close();
});

test('an ambiguous name resolves when the type is given', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'Mud', type: 'npc' },
  });
  assert.equal((res.structuredContent as Record<string, any>).type, 'npc');
  await h.close();
});

test('tibia_get reports an unknown name as a model-recoverable error', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'Nonexistent Beast' },
  });
  assert.equal(res.isError, true);
  assert.match((res.content as Array<{ text: string }>)[0]!.text, /tibia_search/);
  await h.close();
});

test('detailed verbosity adds real columns', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'Dragon', verbosity: 'detailed' },
  });
  const data = res.structuredContent as Record<string, any>;
  assert.ok(data.detail, 'detailed should populate a detail block');
  assert.ok('location' in data.detail);
  await h.close();
});

// A well-formed cursor whose offset is past Number.MAX_SAFE_INTEGER reached SQLite as a
// REAL and failed there with a raw "datatype mismatch" instead of the invalid-cursor answer.
test('every paged tool refuses a cursor offset past a safe integer', async () => {
  const h = await connect();
  const huge = Buffer.from(`o:${'9'.repeat(20)}`, 'utf8').toString('base64url');
  for (const [name, args] of [
    ['tibia_search', { query: 'Dragon' }],
    ['tibia_find_creatures', {}],
    ['tibia_find_items', {}],
    ['tibia_find_spells', {}],
    ['tibia_find_quests', {}],
    ['tibia_find_houses', {}],
    ['tibia_find_travel', { to: 'Carlin' }],
    ['tibia_find_updates', {}],
  ] as const) {
    const res = await h.client.callTool({ name, arguments: { ...args, cursor: huge } });
    assert.equal(res.isError, true, `${name} must refuse the cursor`);
    assert.match((res.content as Array<{ text: string }>)[0]!.text, /^Invalid cursor: /, name);
  }
  await h.close();
});
