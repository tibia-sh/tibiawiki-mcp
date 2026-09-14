import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

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

test('the server tells clients its tool list never changes', async () => {
  const h = await connect();
  assert.equal(h.client.getServerCapabilities()?.tools?.listChanged, false);
  await h.close();
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
