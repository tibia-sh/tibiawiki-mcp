import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { connect, FIXTURE } from './harness.ts';
import { asciiLower } from '../src/domain.ts';

type Item = { item: string; price: number };
type Buyer = { npc: string; position: unknown; rashidSchedule?: Array<{ day: string }>; items: Item[] };
type City = { city: string | null; buyers: Buyer[] };
type Answer = { cities: City[]; noGoldBuyer: string[]; unknownItems: string[]; indexGeneratedAt: string };

async function whereToSell(items: string[]): Promise<Answer> {
  const h = await connect();
  try {
    const res = await h.client.callTool({ name: 'tibia_where_to_sell', arguments: { items } });
    // The server checks structuredContent against the output schema, so a success is
    // also a schema check.
    assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
    return res.structuredContent as Answer;
  } finally {
    await h.close();
  }
}

function fixtureRows(sql: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

const byFold = (a: string, b: string): number =>
  asciiLower(a) < asciiLower(b) ? -1 : asciiLower(a) > asciiLower(b) ? 1 : 0;

test('an item sells to its best buyer, under his city, with his position', async () => {
  const answer = await whereToSell(['Dragon Shield']);
  assert.deepEqual(answer.cities, [{
    city: 'Darashia',
    buyers: [{
      npc: "Nah'Bob",
      position: { x: 33104, y: 32520, z: 2 },
      items: [{ item: 'Dragon Shield', price: 4000 }],
    }],
  }]);
  assert.deepEqual(answer.noGoldBuyer, []);
  assert.deepEqual(answer.unknownItems, []);
  assert.match(answer.indexGeneratedAt, /\S/);
});

test('a name in any case counts once, and a name that is no item does not fail the call', async () => {
  const answer = await whereToSell(['dragon shield', 'Not An Item', 'Dragon Shield', 'not an item', 'Also Missing']);
  assert.deepEqual(answer.cities, [{
    city: 'Darashia',
    buyers: [{
      npc: "Nah'Bob",
      position: { x: 33104, y: 32520, z: 2 },
      items: [{ item: 'Dragon Shield', price: 4000 }],
    }],
  }]);
  assert.deepEqual(answer.unknownItems, ['Not An Item', 'Also Missing']);
});

// Yasir is an event NPC, so an item only he buys has no active buyer.
test('an item no active NPC buys for gold is listed apart', async () => {
  const yasirOnly = fixtureRows(
    `select i.title from item i
      where exists (select 1 from npc_offer_buy o join npc n on n.article_id = o.npc_id
                     where o.item_id = i.article_id and n.title = 'Yasir')
        and not exists (select 1 from npc_offer_buy o join npc n on n.article_id = o.npc_id
                         where o.item_id = i.article_id and n.title <> 'Yasir')
      order by i.title limit 1`,
  );
  assert.equal(yasirOnly.length, 1, 'the fixture holds an item only Yasir buys');
  const item = String(yasirOnly[0]!.title);

  const answer = await whereToSell(['gold coin', item]);
  assert.deepEqual(answer.cities, []);
  assert.deepEqual(answer.noGoldBuyer, ['Gold Coin', item].sort(byFold));
  assert.deepEqual(answer.unknownItems, []);
});

test('an item of any status counts', async () => {
  const [row] = fixtureRows(`select status from item where title = 'Arrow (Weak)'`);
  assert.notEqual(row?.status, 'active', 'guard: Arrow (Weak) is not active');
  const answer = await whereToSell(['Arrow (Weak)']);
  assert.deepEqual(answer.unknownItems, []);
  assert.equal(
    answer.noGoldBuyer.length + answer.cities.flatMap((c) => c.buyers.flatMap((b) => b.items)).length,
    1,
  );
});

// Rashid's recorded city is Svargrond, where he stands one day a week.
test('Rashid sits under no city, with his week', async () => {
  const rashidBest = fixtureRows(
    `select i.title from item i
       join npc_offer_buy o on o.item_id = i.article_id
       join npc n on n.article_id = o.npc_id
       join item c on c.article_id = o.currency_id
      where n.title = 'Rashid' and c.title = 'Gold Coin'
        and o.value > (select coalesce(max(o2.value), 0) from npc_offer_buy o2
                         join npc n2 on n2.article_id = o2.npc_id
                         join item c2 on c2.article_id = o2.currency_id
                        where o2.item_id = i.article_id and n2.title <> 'Rashid'
                          and n2.status = 'active' and c2.title = 'Gold Coin')
      order by i.title limit 1`,
  );
  assert.equal(rashidBest.length, 1, 'the fixture holds an item Rashid pays the most for');
  const item = String(rashidBest[0]!.title);

  const answer = await whereToSell([item, 'Dragon Shield']);
  assert.deepEqual(answer.cities.map((c) => c.city), ['Darashia', null]);
  const [rashid] = answer.cities[1]!.buyers;
  assert.equal(rashid?.npc, 'Rashid');
  assert.deepEqual(rashid.position, { x: null, y: null, z: null });
  assert.deepEqual(rashid.items.map((i) => i.item), [item]);
  assert.deepEqual(rashid.rashidSchedule?.map((d) => d.day), [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  ]);
  assert.equal(answer.cities[0]!.buyers[0]!.rashidSchedule, undefined);
});

// The best price by an independent SQL: the most any active NPC pays in Gold Coin, and
// the NPC first by title among those paying it.
test('a bag of items sells each to its best buyer, in order', async () => {
  const offers = fixtureRows(
    `select distinct i.title as item, n.title as npc, o.value as price
       from npc_offer_buy o
       join npc n on n.article_id = o.npc_id
       join item i on i.article_id = o.item_id
       join item c on c.article_id = o.currency_id
      where n.status = 'active' and c.title = 'Gold Coin'`,
  );
  const best = new Map<string, { npc: string; price: number }>();
  for (const o of offers) {
    const item = String(o.item);
    const offer = { npc: String(o.npc), price: Number(o.price) };
    const held = best.get(item);
    if (!held || offer.price > held.price || (offer.price === held.price && byFold(offer.npc, held.npc) < 0)) {
      best.set(item, offer);
    }
  }
  const items = [...best.keys()].sort(byFold).slice(0, 100);
  assert.equal(items.length, 100, 'the fixture holds 100 items an active NPC buys for gold');

  const answer = await whereToSell(items);
  assert.deepEqual(answer.noGoldBuyer, []);
  assert.deepEqual(answer.unknownItems, []);
  const sold = answer.cities.flatMap((c) =>
    c.buyers.flatMap((b) => b.items.map((i) => ({ item: i.item, npc: b.npc, price: i.price }))));
  assert.deepEqual(
    sold.map((s) => s.item).sort(byFold),
    items,
    'every item once',
  );
  for (const s of sold) assert.deepEqual({ npc: s.npc, price: s.price }, best.get(s.item), s.item);

  const cities = answer.cities.map((c) => c.city);
  assert.ok(cities.length > 1, 'the bag spans several cities');
  assert.equal(new Set(cities).size, cities.length, 'each city once');
  const npcs = answer.cities.flatMap((c) => c.buyers.map((b) => b.npc));
  assert.equal(new Set(npcs).size, npcs.length, 'each buyer once');
  const named = cities.filter((c): c is string => c !== null);
  assert.deepEqual(cities.slice(0, named.length), [...named].sort(byFold), 'cities by name, null last');
  for (const c of answer.cities) {
    const npcs = c.buyers.map((b) => b.npc);
    assert.deepEqual(npcs, [...npcs].sort(byFold), `buyers in ${c.city} by title`);
    for (const b of c.buyers) {
      const titles = b.items.map((i) => i.item);
      assert.deepEqual(titles, [...titles].sort(byFold), `${b.npc}'s items by title`);
    }
  }
});

test('the item list holds 1 to 100 names', async () => {
  const h = await connect();
  try {
    for (const items of [[], Array.from({ length: 101 }, (_, i) => `Item ${i}`)]) {
      const res = await h.client.callTool({ name: 'tibia_where_to_sell', arguments: { items } });
      assert.equal(res.isError, true, `${items.length} names must be refused`);
    }
  } finally {
    await h.close();
  }
});
