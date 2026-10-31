import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect, connectTo, FIXTURE, tempDirs, withRealIndex } from './harness.ts';

const scratch = tempDirs('twmcp-obtain-');

type ObtainOut = {
  item: string;
  articleId: number;
  clientId: number | null;
  clientIds: number[];
  droppedBy: Array<{
    creature: string; articleId: number; chance: number | null; min: number | null; max: number | null;
  }>;
  soldByNpcs: Array<{ npc: string; city: string | null; price: number; currency: string }>;
  questRewards: string[];
  droppedByTotal: number;
  nextCursor?: string;
  note: string;
};

/** Every page of an item's droppedBy, following nextCursor until it is absent. */
async function dropPages(
  client: Awaited<ReturnType<typeof connect>>['client'],
  args: { item_name: string; include_inactive?: boolean; limit?: number },
): Promise<ObtainOut[]> {
  const pages: ObtainOut[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.callTool({
      name: 'tibia_how_to_obtain', arguments: { ...args, ...(cursor ? { cursor } : {}) },
    });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    const page = res.structuredContent as ObtainOut;
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return pages;
}

test('reports which creatures drop an item', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Steel Helmet' },
  });
  const data = res.structuredContent as ObtainOut;
  assert.ok(data.droppedBy.length > 0, 'Steel Helmet should have droppers');
  await h.close();
});

test('the item carries its articleId, and each drop the creature\'s, as tibia_get gives it', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Dragon Shield' },
  });
  const data = res.structuredContent as ObtainOut;
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  try {
    const row = db.prepare("select article_id from item where title = 'Dragon Shield'").get()!;
    assert.equal(data.articleId, Number(row.article_id));
  } finally {
    db.close();
  }
  assert.ok(data.droppedBy.length > 0, 'guard: Dragon Shield has droppers');
  for (const drop of data.droppedBy) {
    const creature = await h.client.callTool({
      name: 'tibia_get', arguments: { name: drop.creature, type: 'creature' },
    });
    assert.notEqual(creature.isError, true, drop.creature);
    assert.equal(drop.articleId, (creature.structuredContent as { articleId: number }).articleId, drop.creature);
  }
  await h.close();
});

// Shallow Water's itemid lists 629-634, and no creature drops it.
test('the item carries its first client ID and every one, in order', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Shallow Water' },
  });
  const data = res.structuredContent as ObtainOut;
  assert.equal(data.clientId, 629);
  assert.deepEqual(data.clientIds, [629, 630, 631, 632, 633, 634]);
  await h.close();
});

test('an item with no source still carries its IDs', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Magic Longsword' },
  });
  const data = res.structuredContent as ObtainOut;
  assert.deepEqual(data.droppedBy, [], 'guard: no creature drops Magic Longsword');
  assert.equal(data.articleId, 1464);
  assert.equal(data.clientId, 3278);
  assert.deepEqual(data.clientIds, [3278]);
  await h.close();
});

test('vendor prices are the SELL side — what the player pays', async () => {
  // npc_offer_sell = the NPC sells to the player (580g). npc_offer_buy = the NPC
  // buys from the player (293g). Reading the wrong table is the defect this guards.
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Steel Helmet' },
  });
  const data = res.structuredContent as ObtainOut;
  assert.ok(data.soldByNpcs.length > 0, 'expected vendors');
  for (const v of data.soldByNpcs) {
    assert.ok(v.price >= 580, `${v.npc} quoted ${v.price}; the buy side is 293, so this read the wrong table`);
    assert.equal(v.currency, 'Gold Coin');
  }
  await h.close();
});

test('drops are ordered by chance descending with nulls last', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Steel Helmet' },
  });
  const drops = (res.structuredContent as ObtainOut).droppedBy;
  const firstNull = drops.findIndex((d) => d.chance === null);
  assert.notEqual(firstNull, -1, 'fixture must contain null-chance drops for this to be meaningful');
  assert.ok(
    drops.slice(firstNull).every((d) => d.chance === null),
    'a non-null chance must never follow a null one',
  );
  const nonNull = drops.slice(0, firstNull).map((d) => d.chance as number);
  assert.deepEqual(nonNull, [...nonNull].sort((a, b) => b - a), 'descending');
  await h.close();
});

test('an item with no in-game source returns empty lists and a note, not an error', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Magic Longsword' },
  });
  assert.notEqual(res.isError, true);
  const data = res.structuredContent as ObtainOut;
  assert.deepEqual(data.droppedBy, []);
  assert.deepEqual(data.soldByNpcs, []);
  assert.deepEqual(data.questRewards, []);
  assert.ok(data.note.length > 0, 'should explain that the item has no recorded source');
  await h.close();
});

test('an unknown item name is a model-recoverable error', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Nonexistent Trinket' },
  });
  assert.equal(res.isError, true);
  assert.match((res.content as Array<{ text: string }>)[0]!.text, /tibia_search/);
  await h.close();
});

test('the item name resolves case-insensitively and echoes the canonical title', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'steel helmet' },
  });
  assert.equal((res.structuredContent as ObtainOut).item, 'Steel Helmet');
  await h.close();
});

test('the name the game prints answers for its item', async () => {
  const h = await connect();
  try {
    const res = await h.client.callTool({ name: 'tibia_how_to_obtain', arguments: { item_name: 'amber' } });
    assert.equal((res.structuredContent as ObtainOut).item, 'Amber (Item)');
  } finally {
    await h.close();
  }
  await withRealIndex(async (client) => {
    const res = await client.callTool({
      name: 'tibia_how_to_obtain', arguments: { item_name: 'Vial of Lifefluid' },
    });
    assert.equal((res.structuredContent as ObtainOut).item, 'Lifefluid');
  });
});

test('a plural the index does not record answers for its item', async () => {
  const h = await connect();
  try {
    for (const [name, title] of [['gold coins', 'Gold Coin'], ['scarab coins', 'Scarab Coin']]) {
      const res = await h.client.callTool({ name: 'tibia_how_to_obtain', arguments: { item_name: name } });
      assert.notEqual(res.isError, true, JSON.stringify(res.content));
      assert.equal((res.structuredContent as ObtainOut).item, title);
    }
    const res = await h.client.callTool({ name: 'tibia_how_to_obtain', arguments: { item_name: 'blorbs' } });
    assert.equal(res.isError, true);
  } finally {
    await h.close();
  }
});

test('a name two items print is an error naming both', async () => {
  const h = await connect();
  try {
    const res = await h.client.callTool({ name: 'tibia_how_to_obtain', arguments: { item_name: 'book' } });
    assert.equal(res.isError, true);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /Book \(Brown\)/);
    assert.match(text, /Book \(Gemmed\)/);
  } finally {
    await h.close();
  }
});

test('one NPC selling at one price in several currencies is ordered by currency', async () => {
  // Asima sells Health Potion for 50 Gold Coin in the fixture. Two more offers at the
  // same price, inserted out of order, leave the currency as the only difference.
  const path = join(scratch(), 'index.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  const insert = db.prepare(
    `insert into npc_offer_sell (npc_id, item_id, value, currency_id)
       select n.article_id, i.article_id, 50, c.article_id
         from npc n, item i, item c
        where n.title = 'Asima' and i.title = 'Health Potion' and c.title = ?`,
  );
  insert.run('Scarab Coin');
  insert.run('Crystal Coin');
  db.close();
  const h = await connectTo(path);
  try {
    const res = await h.client.callTool({
      name: 'tibia_how_to_obtain', arguments: { item_name: 'Health Potion' },
    });
    const data = res.structuredContent as ObtainOut;
    const asima = data.soldByNpcs.filter((v) => v.npc === 'Asima').map((v) => v.currency);
    assert.deepEqual(asima, ['Crystal Coin', 'Gold Coin', 'Scarab Coin']);
  } finally {
    await h.close();
  }
});

// The fixture keeps 73 Gold Coin drops, 70 of them from active creatures, and two of them
// share a chance, so a page of 10 crosses pages and ties.
test('paged drops follow the total order: chance, creature, min, max, articleId', async () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  let expected: Array<[number, number | null, number, number]>;
  try {
    expected = db.prepare(
      `select c.article_id, d.chance, d.min, d.max
         from creature_drop d join creature c on c.article_id = d.creature_id
        where d.item_id = (select article_id from item where title = 'Gold Coin')
          and c.status = 'active'
        order by (d.chance is null), d.chance desc, c.title asc, d.min asc, d.max asc,
                 c.article_id asc`,
    ).all().map((r) => [Number(r.article_id), r.chance as number | null, Number(r.min), Number(r.max)]);
    const tied = db.prepare(
      `select 1 from creature_drop
        where item_id = (select article_id from item where title = 'Gold Coin')
        group by chance having count(*) > 1`,
    ).get();
    assert.ok(tied, 'guard: two Gold Coin drops share a chance');
  } finally {
    db.close();
  }
  const h = await connect();
  try {
    const pages = await dropPages(h.client, { item_name: 'Gold Coin', limit: 10 });
    assert.ok(pages.length > 1, 'guard: Gold Coin spans several pages of 10');
    const paged = pages.flatMap((p) => p.droppedBy)
      .map((d) => [d.articleId, d.chance, d.min, d.max]);
    assert.deepEqual(paged, expected);
  } finally {
    await h.close();
  }
});

test('paging drops ends without a cursor, keeping vendors and quests whole on every page', async () => {
  const h = await connect();
  try {
    const whole = (await h.client.callTool({
      name: 'tibia_how_to_obtain', arguments: { item_name: 'Gold Coin' },
    })).structuredContent as ObtainOut;
    assert.equal(whole.nextCursor, undefined, 'guard: one page of 100 holds every fixture drop');
    assert.ok(whole.questRewards.length > 0, 'guard: quests reward Gold Coin');

    const pages = await dropPages(h.client, { item_name: 'Gold Coin', limit: 10 });
    assert.equal(pages.length, Math.ceil(whole.droppedByTotal / 10));
    for (const [i, page] of pages.entries()) {
      const last = i === pages.length - 1;
      assert.equal(page.droppedBy.length, last ? whole.droppedByTotal - 10 * i : 10);
      assert.deepEqual(page.soldByNpcs, whole.soldByNpcs);
      assert.deepEqual(page.questRewards, whole.questRewards);
      // Review Focus 5: a capped list names its total and the call that returns the rest.
      if (last) {
        assert.equal(page.note, '');
      } else {
        assert.match(page.note, new RegExp(`10 of ${whole.droppedByTotal}`));
        assert.match(page.note, /tibia_how_to_obtain/);
        assert.match(page.note, /cursor/);
      }
    }
  } finally {
    await h.close();
  }
});

test('droppedByTotal counts every drop paged, with and without inactive creatures', async () => {
  const h = await connect();
  try {
    const totals: number[] = [];
    for (const include_inactive of [false, true]) {
      const pages = await dropPages(h.client, { item_name: 'Gold Coin', include_inactive, limit: 10 });
      const rows = pages.flatMap((p) => p.droppedBy);
      for (const page of pages) assert.equal(page.droppedByTotal, rows.length);
      totals.push(rows.length);
    }
    assert.deepEqual(totals, [70, 73]);
  } finally {
    await h.close();
  }
});

test('a malformed drops cursor is a model-recoverable error', async () => {
  const h = await connect();
  try {
    const res = await h.client.callTool({
      name: 'tibia_how_to_obtain', arguments: { item_name: 'Gold Coin', cursor: 'nope' },
    });
    assert.equal(res.isError, true);
    assert.match((res.content as Array<{ text: string }>)[0]!.text, /Invalid cursor: nope/);
  } finally {
    await h.close();
  }
});
