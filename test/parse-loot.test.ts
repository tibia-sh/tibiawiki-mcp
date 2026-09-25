import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { connect, connectTo, FIXTURE, tempDirs, withRealIndex } from './harness.ts';

const scratch = tempDirs('twmcp-loot-');

type Entry = {
  text: string; count: number | null; item: string | null; candidates: string[];
  clientId: number | null; unitPrice: number | null; value: number | null;
};
type Line = {
  creature: { text: string; title: string | null; candidates: string[] };
  note: string | null;
  items: Entry[];
};
type Answer = {
  lines: Line[];
  totals: {
    items: Array<{ item: string; count: number; value: number | null }>;
    gold: number; unresolved: number; unpriced: number;
  };
  unparsed: string[];
  indexGeneratedAt: string;
};

async function askParseLoot(client: Client, text: string): Promise<Answer> {
  const res = await client.callTool({ name: 'tibia_parse_loot', arguments: { text } });
  // The server checks structuredContent against the output schema, so a success is
  // also a schema check.
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Answer;
}

async function parseLoot(text: string): Promise<Answer> {
  const h = await connect();
  try {
    return await askParseLoot(h.client, text);
  } finally {
    await h.close();
  }
}

function rows(path: string, sql: string, ...params: Array<string | number>): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** The highest gold price an active NPC pays for each title, written apart from BEST_GOLD_PRICE. */
function goldPrices(path: string, titles: string[]): Map<string, number> {
  const found = rows(path,
    `select i.title, max(o.value) as price
       from npc_offer_buy o
       join npc n on n.article_id = o.npc_id
       join item c on c.article_id = o.currency_id
       join item i on i.article_id = o.item_id
      where n.status = 'active' and c.title = 'Gold Coin'
        and i.title in (select value from json_each(?))
      group by i.title`, JSON.stringify(titles));
  return new Map(found.map((r) => [String(r.title), Number(r.price)]));
}

const ENTRY_DEFAULTS = { candidates: [], clientId: null, unitPrice: null, value: null };

// The plan's acceptance line, with Review Focus 4's timestamp, note, full stop and two stacks.
test('a loot line gives its creature, note, items, client IDs, prices and totals', async () => {
  const answer = await parseLoot(
    '12:34 Loot of a dragon: 2 small diamonds, a steel shield, 3 green dragon scales, ' +
    'dragon ham, 26 gold coins, 100 gold coins (active prey bonus).');

  const prices = goldPrices(FIXTURE,
    ['Small Diamond', 'Steel Shield', 'Green Dragon Scale', 'Dragon Ham']);
  assert.equal(prices.size, 3, 'guard: three of the items have a gold buyer');
  assert.equal(prices.has('Dragon Ham'), false, 'guard: no NPC buys Dragon Ham for gold');
  const clientIds = new Map(rows(FIXTURE,
    `select title, client_id from item where title in
       ('Small Diamond', 'Steel Shield', 'Green Dragon Scale', 'Dragon Ham', 'Gold Coin')`)
    .map((r) => [String(r.title), Number(r.client_id)]));
  const priced = (text: string, count: number, item: string) => ({
    text, count, item, candidates: [], clientId: clientIds.get(item)!,
    unitPrice: prices.get(item)!, value: count * prices.get(item)!,
  });
  const coins = (text: string, count: number) => ({
    text, count, item: 'Gold Coin', candidates: [], clientId: clientIds.get('Gold Coin')!,
    unitPrice: 1, value: count,
  });

  assert.deepEqual(answer.lines, [{
    creature: { text: 'a dragon', title: 'Dragon', candidates: [] },
    note: 'active prey bonus',
    items: [
      priced('2 small diamonds', 2, 'Small Diamond'),
      priced('a steel shield', 1, 'Steel Shield'),
      priced('3 green dragon scales', 3, 'Green Dragon Scale'),
      { ...ENTRY_DEFAULTS, text: 'dragon ham', count: 1, item: 'Dragon Ham', clientId: clientIds.get('Dragon Ham')! },
      coins('26 gold coins', 26),
      coins('100 gold coins', 100),
    ],
  }]);
  const gold = 126 + 2 * prices.get('Small Diamond')! + prices.get('Steel Shield')! +
    3 * prices.get('Green Dragon Scale')!;
  assert.deepEqual(answer.totals, {
    items: [
      { item: 'Dragon Ham', count: 1, value: null },
      { item: 'Gold Coin', count: 126, value: 126 },
      { item: 'Green Dragon Scale', count: 3, value: 3 * prices.get('Green Dragon Scale')! },
      { item: 'Small Diamond', count: 2, value: 2 * prices.get('Small Diamond')! },
      { item: 'Steel Shield', count: 1, value: prices.get('Steel Shield')! },
    ],
    gold, unresolved: 0, unpriced: 1,
  });
  assert.deepEqual(answer.unparsed, []);
  assert.match(answer.indexGeneratedAt, /\S/);
});

test('coins count at face value', async () => {
  const answer = await parseLoot('Loot of a dragon: 3 platinum coins, a crystal coin, 5 gold coins');
  assert.deepEqual(answer.lines[0]!.items.map((e) => [e.item, e.unitPrice, e.value]), [
    ['Platinum Coin', 100, 300], ['Crystal Coin', 10000, 10000], ['Gold Coin', 1, 5],
  ]);
  assert.equal(answer.totals.gold, 10305);
});

// Review Focus 4.
test('a boss without an article, "nothing" and a note parse, with or without seconds', async () => {
  const [boss] = rows(FIXTURE, `select article from creature where title = 'Dragonking Zyrtarch'`);
  assert.equal(boss?.article, null, 'guard: Dragonking Zyrtarch prints no article');
  const answer = await parseLoot(
    '12:34:56 Loot of Dragonking Zyrtarch: nothing (due to low stamina).\n' +
    'Loot of a dragon: nothing');
  assert.deepEqual(answer.lines, [
    {
      creature: { text: 'Dragonking Zyrtarch', title: 'Dragonking Zyrtarch', candidates: [] },
      note: 'due to low stamina', items: [],
    },
    { creature: { text: 'a dragon', title: 'Dragon', candidates: [] }, note: null, items: [] },
  ]);
  assert.deepEqual(answer.totals, { items: [], gold: 0, unresolved: 0, unpriced: 0 });
  assert.deepEqual(answer.unparsed, []);
});

test('several lines sum by item, blank lines are skipped and chat lands in unparsed', async () => {
  const answer = await parseLoot(
    '12:00 Loot of a dragon: 3 gold coins\r\n\n' +
    '12:00 Knight [123]: anyone selling loot?\n' +
    '12:01 Loot of a dragon: a steel shield, 2 gold coins.\n  \n' +
    'Loot of a dragon 3 gold coins\n');
  assert.equal(answer.lines.length, 2);
  assert.deepEqual(answer.totals.items.map((i) => [i.item, i.count]),
    [['Gold Coin', 5], ['Steel Shield', 1]]);
  assert.deepEqual(answer.unparsed,
    ['12:00 Knight [123]: anyone selling loot?', 'Loot of a dragon 3 gold coins']);
});

test('a count of 0, over 1,000,000 or not an integer is unresolved, and the rest parses', async () => {
  const answer = await parseLoot(
    'Loot of a dragon: 0 gold coins, 1000001 gold coins, 2.5 gold coins, -3 gold coins, ' +
    '1000000 gold coins');
  const entries = answer.lines[0]!.items;
  assert.deepEqual(entries.slice(0, 4), [
    { ...ENTRY_DEFAULTS, text: '0 gold coins', count: null, item: null },
    { ...ENTRY_DEFAULTS, text: '1000001 gold coins', count: null, item: null },
    { ...ENTRY_DEFAULTS, text: '2.5 gold coins', count: null, item: null },
    { ...ENTRY_DEFAULTS, text: '-3 gold coins', count: null, item: null },
  ]);
  assert.deepEqual([entries[4]!.count, entries[4]!.item, entries[4]!.value],
    [1000000, 'Gold Coin', 1000000]);
  assert.deepEqual(answer.totals, {
    items: [{ item: 'Gold Coin', count: 1000000, value: 1000000 }],
    gold: 1000000, unresolved: 4, unpriced: 0,
  });
});

// Review Focus 2: what the creature does not settle stays out of the totals.
test('an ambiguous item the creature does not settle and an unknown item stay unresolved', async () => {
  const drops = rows(FIXTURE,
    `select i.title from creature_drop d join item i on i.article_id = d.item_id
       join creature c on c.article_id = d.creature_id
      where c.title = 'Dragon' and i.actual_name = 'book'`);
  assert.deepEqual(drops, [], 'guard: a Dragon drops no book');
  const answer = await parseLoot('Loot of a dragon: a book, a blorb, 2 gold coins');
  assert.deepEqual(answer.lines[0]!.items.slice(0, 2), [
    { ...ENTRY_DEFAULTS, text: 'a book', count: 1, item: null, candidates: ['Book (Brown)', 'Book (Gemmed)'] },
    { ...ENTRY_DEFAULTS, text: 'a blorb', count: 1, item: null },
  ]);
  assert.deepEqual(answer.totals, {
    items: [{ item: 'Gold Coin', count: 2, value: 2 }], gold: 2, unresolved: 2, unpriced: 0,
  });
});

test('an unknown creature is reported, and its items resolve without it', async () => {
  const answer = await parseLoot('Loot of a blorb: 3 gold coins');
  assert.deepEqual(answer.lines[0]!.creature, { text: 'a blorb', title: null, candidates: [] });
  assert.equal(answer.lines[0]!.items[0]!.item, 'Gold Coin');
});

test('a creature name several creatures share settles items by what any of them drops', async () => {
  const path = join(scratch(), 'shared-name.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`insert into creature (article_id, title, name, plural, article, status, timestamp) values
               (900001, 'Twin Beast (Brown)', 'twin beast', 'twin beasts', 'a', 'active', ''),
               (900002, 'Twin Beast (Grey)', 'twin beast', 'twin beasts', 'a', 'active', '');
             insert into creature_drop (creature_id, item_id, min, max)
               select 900001, article_id, 0, 1 from item where title = 'Book (Brown)';`);
  } finally {
    db.close();
  }
  const h = await connectTo(path);
  try {
    const answer = await askParseLoot(h.client, 'Loot of a twin beast: a book\nLoot of twin beasts: nothing');
    const candidates = ['Twin Beast (Brown)', 'Twin Beast (Grey)'];
    assert.deepEqual(answer.lines[0]!.creature, { text: 'a twin beast', title: null, candidates });
    assert.equal(answer.lines[0]!.items[0]!.item, 'Book (Brown)');
    assert.deepEqual(answer.lines[1]!.creature, { text: 'twin beasts', title: null, candidates });
  } finally {
    await h.close();
  }
});

test('a creature resolves by its name the game prints, article and all', async () => {
  await withRealIndex(async (client) => {
    const [eye] = rows(DB_PATH, `select name from creature where title = 'A Greedy Eye'`);
    assert.equal(eye?.name, 'a greedy eye', 'guard: A Greedy Eye prints its article in its name');
    const answer = await askParseLoot(client, 'Loot of a greedy eye: nothing');
    assert.equal(answer.lines[0]!.creature.title, 'A Greedy Eye');
    const beasts = rows(DB_PATH,
      `select title from creature where name = 'primal pack beast' and status = 'active' order by title`);
    assert.ok(beasts.length > 1, 'guard: several creatures print as "primal pack beast"');
    const shared = await askParseLoot(client, 'Loot of a primal pack beast: nothing');
    assert.deepEqual(shared.lines[0]!.creature,
      { text: 'a primal pack beast', title: null, candidates: beasts.map((r) => String(r.title)) });
  });
});

// Review Focus 2: the creature settles a name several items print.
test('a creature settles an item name several items print', async () => {
  await withRealIndex(async (client) => {
    const answer = await askParseLoot(client, 'Loot of a pirate cutthroat: a treasure map');
    assert.equal(answer.lines[0]!.creature.title, 'Pirate Cutthroat');
    assert.equal(answer.lines[0]!.items[0]!.item, 'Treasure Map (Pirate)');
    assert.equal(answer.totals.unresolved, 0);
  });
});

// Review Focus 1: a counted plural that is also another item's title.
test('a counted plural resolves to the item the creature drops', async () => {
  await withRealIndex(async (client) => {
    const [found] = rows(DB_PATH,
      `select c.title, c.name from creature c
         join creature_drop d on d.creature_id = c.article_id
         join item i on i.article_id = d.item_id and i.title = 'Gold Nugget'
        where c.status = 'active' and c.article = 'a' and c.title = c.name
          and not exists (select 1 from creature_drop e join item j on j.article_id = e.item_id
                           where e.creature_id = c.article_id and j.title = 'Gold Nuggets')
        order by c.title limit 1`);
    assert.ok(found, 'guard: an active creature drops Gold Nugget and not Gold Nuggets');
    const answer = await askParseLoot(client, `Loot of a ${String(found.name)}: 3 gold nuggets`);
    assert.equal(answer.lines[0]!.creature.title, String(found.title));
    assert.equal(answer.lines[0]!.items[0]!.item, 'Gold Nugget');
  });
});

test('text over 20,000 characters is refused', async () => {
  const h = await connect();
  try {
    const res = await h.client.callTool({
      name: 'tibia_parse_loot', arguments: { text: 'x'.repeat(20_001) },
    });
    assert.equal(res.isError, true);
    await askParseLoot(h.client, 'x'.repeat(20_000));
  } finally {
    await h.close();
  }
});
