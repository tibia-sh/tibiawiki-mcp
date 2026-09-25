import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect, connectTo, FIXTURE, tempDirs, withRealIndex } from './harness.ts';

const scratch = tempDirs('twmcp-obtain-');

type ObtainOut = {
  item: string;
  droppedBy: Array<{ creature: string; chance: number | null; min: number | null; max: number | null }>;
  soldByNpcs: Array<{ npc: string; city: string | null; price: number; currency: string }>;
  questRewards: string[];
  note: string;
};

test('reports which creatures drop an item', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Steel Helmet' },
  });
  const data = res.structuredContent as ObtainOut;
  assert.ok(data.droppedBy.length > 0, 'Steel Helmet should have droppers');
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
