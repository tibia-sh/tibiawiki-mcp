import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { connect, FIXTURE } from './harness.ts';
import { ENTITY_TYPES, entityTable, entityHasStatus, type EntityType } from '../src/domain.ts';

type Page = Record<string, any>;

/** A page's article_id, read from the fixture itself. */
function articleId(type: EntityType, title: string): number {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  try {
    const row = db.prepare(`select article_id from "${entityTable(type)}" where title = ?`).get(title);
    assert.ok(row, `guard: the fixture holds the ${type} ${title}`);
    return Number(row.article_id);
  } finally {
    db.close();
  }
}

async function get(client: Client, args: Record<string, unknown>): Promise<Page> {
  const res = await client.callTool({ name: 'tibia_get', arguments: args });
  assert.notEqual(res.isError, true, `${JSON.stringify(args)}: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Page;
}

async function refused(client: Client, args: Record<string, unknown>): Promise<string> {
  const res = await client.callTool({ name: 'tibia_get', arguments: args });
  assert.equal(res.isError, true, `${JSON.stringify(args)} must be refused`);
  return (res.content as Array<{ text: string }>)[0]!.text;
}

test('tibia_get finds a page by its article_id', async () => {
  const h = await connect();
  const dragon = await get(h.client, { article_id: articleId('creature', 'Dragon') });
  assert.equal(dragon.type, 'creature');
  assert.equal(dragon.title, 'Dragon');
  assert.equal(dragon.articleId, articleId('creature', 'Dragon'));
  // Mud is both an item and an NPC by name, but each page has its own article_id.
  assert.notEqual(articleId('npc', 'Mud'), articleId('item', 'Mud'));
  const mud = await get(h.client, { article_id: articleId('npc', 'Mud') });
  assert.equal(mud.type, 'npc');
  assert.equal(mud.articleId, articleId('npc', 'Mud'));
  // A type that does not hold the page finds nothing.
  await refused(h.client, { article_id: articleId('creature', 'Dragon'), type: 'item' });
  await h.close();
});

test('tibia_get refuses a name and an article_id together', async () => {
  const h = await connect();
  const text = await refused(h.client, { name: 'Dragon', article_id: articleId('creature', 'Dragon') });
  assert.match(text, /name/);
  assert.match(text, /article_id/);
  await h.close();
});

test('tibia_get refuses a call with neither a name nor an article_id', async () => {
  const h = await connect();
  const text = await refused(h.client, { type: 'creature' });
  assert.match(text, /name/);
  assert.match(text, /article_id/);
  await h.close();
});

test('an unknown or inactive article_id is a model-recoverable error', async () => {
  const h = await connect();
  assert.match(await refused(h.client, { article_id: 999_999_999 }), /999999999/);
  // Infernatil's status is "ts-only", so it is found only with include_inactive.
  const infernatil = articleId('creature', 'Infernatil');
  assert.match(await refused(h.client, { article_id: infernatil }), /include_inactive/);
  assert.equal((await get(h.client, { article_id: infernatil, include_inactive: true })).title, 'Infernatil');
  await h.close();
});

test('every tibia_get output carries its articleId, and the id finds it again', async () => {
  const h = await connect();
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  try {
    for (const type of ENTITY_TYPES) {
      const status = entityHasStatus(type) ? "where status = 'active'" : '';
      const row = db.prepare(
        `select article_id, title from "${entityTable(type)}" ${status} order by title limit 1`,
      ).get();
      assert.ok(row, `guard: the fixture holds an active ${type}`);
      const byName = await get(h.client, { name: row.title, type });
      assert.equal(byName.articleId, Number(row.article_id), `${type} ${String(row.title)}`);
      const byId = await get(h.client, { article_id: Number(row.article_id) });
      assert.equal(byId.type, type);
      assert.equal(byId.title, row.title);
    }
  } finally {
    db.close();
  }
  await h.close();
});

test('every finder row carries the articleId of its page', async () => {
  const h = await connect();
  const finders: Array<[string, Record<string, unknown>, (row: Page) => [EntityType, string]]> = [
    ['tibia_search', { query: 'Dragon' }, (r) => [r.type, r.title]],
    ['tibia_find_creatures', {}, (r) => ['creature', r.title]],
    ['tibia_find_items', {}, (r) => ['item', r.title]],
    ['tibia_find_spells', {}, (r) => ['spell', r.title]],
    ['tibia_find_quests', {}, (r) => ['quest', r.title]],
    ['tibia_find_houses', {}, (r) => ['house', r.title]],
    ['tibia_find_updates', {}, (r) => ['update', r.title]],
    // A travel row is a leg of the NPC's route, so its id is the NPC's.
    ['tibia_find_travel', { to: 'Carlin' }, (r) => ['npc', r.npc]],
    ['tibia_find_npcs', {}, (r) => ['npc', r.title]],
  ];
  for (const [name, args, page] of finders) {
    const res = await h.client.callTool({ name, arguments: args });
    assert.notEqual(res.isError, true, `${name}: ${JSON.stringify(res.content)}`);
    const { results } = res.structuredContent as { results: Page[] };
    assert.ok(results.length > 0, `guard: ${name} returns rows`);
    for (const row of results) {
      const [type, title] = page(row);
      assert.equal(row.articleId, articleId(type, title), `${name}: ${title}`);
    }
  }
  await h.close();
});
