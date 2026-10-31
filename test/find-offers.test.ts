import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { connect, connectTo, FIXTURE, tempDirs } from './harness.ts';

type Offer = {
  npc: string; npcArticleId: number; item: string; itemArticleId: number;
  price: number; currency: string; direction: 'buy' | 'sell';
};
type Page = { results: Offer[]; totalMatches: number; nextCursor?: string; indexGeneratedAt: string };

const scratch = tempDirs('twmcp-offers-');

async function find(client: Client, args: Record<string, unknown>): Promise<Page> {
  const res = await client.callTool({ name: 'tibia_find_offers', arguments: args });
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Page;
}

/** Every page of a query, walked through nextCursor, each page's total checked. */
async function findAll(client: Client, args: Record<string, unknown>): Promise<{ rows: Offer[]; pages: number }> {
  const rows: Offer[] = [];
  let pages = 0;
  let total: number | undefined;
  let cursor: string | undefined;
  do {
    const page = await find(client, { ...args, ...(cursor ? { cursor } : {}) });
    total ??= page.totalMatches;
    assert.equal(page.totalMatches, total, 'every page reports the same total');
    rows.push(...page.results);
    pages += 1;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  assert.equal(rows.length, total, 'the pages hold exactly the total');
  return { rows, pages };
}

/** The distinct offers of `where`, both directions, in the tool's order, from the index at `path`. */
function expectedOffers(path: string, where: string, ...params: string[]): Offer[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const side = (table: string, direction: string) =>
      `select distinct n.title as npc, n.article_id as npc_id, i.title as item, i.article_id as item_id,
              o.value as price, c.title as currency, '${direction}' as direction
         from ${table} o join npc n on n.article_id = o.npc_id
         join item i on i.article_id = o.item_id join item c on c.article_id = o.currency_id
        where ${where}`;
    return db.prepare(
      `select * from (${side('npc_offer_buy', 'buy')} union all ${side('npc_offer_sell', 'sell')})
        order by npc collate nocase, direction, item collate nocase, price, currency collate nocase,
                 npc_id, item_id`,
    ).all(...params, ...params).map((r) => ({
      npc: String(r.npc), npcArticleId: Number(r.npc_id), item: String(r.item),
      itemArticleId: Number(r.item_id), price: Number(r.price), currency: String(r.currency),
      direction: r.direction as 'buy' | 'sell',
    }));
  } finally {
    db.close();
  }
}

// Eighteen NPCs buy Small Amethyst at 200 gold in the fixture, so price breaks no tie and
// the NPC's title orders them. Its sellers come after each NPC's buy offer.
test('offers of one item tied on price are ordered by NPC, then direction', async () => {
  const expected = expectedOffers(FIXTURE, "i.title = 'Small Amethyst' and i.status = 'active'");
  const buyers = expected.filter((o) => o.direction === 'buy');
  assert.ok(buyers.length > 10 && buyers.every((o) => o.price === 200),
    'guard: many NPCs buy Small Amethyst at one price');
  assert.ok(expected.some((o) => o.direction === 'sell'), 'guard: NPCs sell Small Amethyst too');
  const h = await connect();
  try {
    const { rows, pages } = await findAll(h.client, { item: 'small amethyst', limit: 7 });
    assert.ok(pages > 1, 'guard: the offers span several pages of 7');
    assert.deepEqual(rows, expected);
  } finally {
    await h.close();
  }
});

test('one NPC\'s offers tied on price are ordered by currency', async () => {
  // Sam sells Mace for 90 Gold Coin in the fixture. Two more offers at the same
  // price, inserted out of order, leave the currency as the only difference.
  const path = join(scratch(), 'index.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  const insert = db.prepare(
    `insert into npc_offer_sell (npc_id, item_id, value, currency_id)
       select n.article_id, i.article_id, 90, c.article_id
         from npc n, item i, item c
        where n.title = 'Sam' and i.title = 'Mace' and c.title = ?`,
  );
  insert.run('Scarab Coin');
  insert.run('Crystal Coin');
  db.close();
  const h = await connectTo(path);
  try {
    const page = await find(h.client, { npc: 'Sam', item: 'Mace', direction: 'sell' });
    assert.deepEqual(
      page.results.map((o) => [o.price, o.currency]),
      [[90, 'Crystal Coin'], [90, 'Gold Coin'], [90, 'Scarab Coin']],
    );
    assert.deepEqual(page.results, expectedOffers(
      path, "n.title = 'Sam' and i.title = 'Mace' and i.status = 'active'",
    ).filter((o) => o.direction === 'sell'));
  } finally {
    await h.close();
  }
});

test('paging an NPC\'s offers ends without a cursor, losing and repeating none', async () => {
  const expected = expectedOffers(FIXTURE, "n.title = 'H.L.' and i.status = 'active'");
  const h = await connect();
  try {
    const whole = await find(h.client, { npc: 'H.L.' });
    assert.equal(whole.nextCursor, undefined, 'guard: one page of 100 holds every offer');
    assert.equal(whole.totalMatches, expected.length);
    assert.deepEqual(whole.results, expected);
    const { rows, pages } = await findAll(h.client, { npc: 'h.l.', limit: 5 });
    assert.equal(pages, Math.ceil(expected.length / 5));
    assert.deepEqual(rows, expected);
  } finally {
    await h.close();
  }
});

// The fixture's NPCs sell Arrow (Weak), a ts-only item, and Yasir, an event NPC, buys
// active items. include_inactive reads the item's status, as tibia_get's trade lists do.
test('include_inactive filters on the offered item\'s status, not the NPC\'s', async () => {
  const h = await connect();
  try {
    const arrow = await find(h.client, { item: 'Arrow (Weak)' });
    assert.equal(arrow.totalMatches, 0);
    const arrowAll = await find(h.client, { item: 'Arrow (Weak)', include_inactive: true });
    assert.ok(arrowAll.totalMatches > 0, 'guard: NPCs sell Arrow (Weak)');
    assert.deepEqual(arrowAll.results, expectedOffers(FIXTURE, "i.title = 'Arrow (Weak)'"));

    const yasir = await find(h.client, { npc: 'Yasir', direction: 'buy' });
    assert.ok(yasir.totalMatches > 0, 'an event NPC\'s offers of active items are listed');
    assert.deepEqual(yasir.results,
      expectedOffers(FIXTURE, "n.title = 'Yasir' and i.status = 'active'"));
  } finally {
    await h.close();
  }
});

test('direction and currency narrow the offers, and sell matches tibia_get\'s sells', async () => {
  const h = await connect();
  try {
    const sells = await find(h.client, { npc: 'Sam', direction: 'sell', currency: 'gold coin' });
    assert.ok(sells.results.length > 0, 'guard: Sam sells for gold');
    for (const o of sells.results) {
      assert.equal(o.direction, 'sell');
      assert.equal(o.currency, 'Gold Coin');
    }
    const sam = await h.client.callTool({ name: 'tibia_get', arguments: { name: 'Sam', type: 'npc' } });
    const npc = sam.structuredContent as {
      articleId: number; sells: Array<{ item: string; price: number; currency: string }>;
      buys: unknown[];
    };
    assert.deepEqual(sells.results.map(({ item, price, currency }) => ({ item, price, currency })), npc.sells);
    for (const o of sells.results) assert.equal(o.npcArticleId, npc.articleId);

    const buys = await find(h.client, { npc: 'Sam', direction: 'buy' });
    assert.equal(npc.buys.length, buys.totalMatches);
    assert.ok(buys.results.every((o) => o.direction === 'buy'));
    assert.equal((await find(h.client, { npc: 'Sam', currency: 'Scarab Coin' })).totalMatches, 0);
  } finally {
    await h.close();
  }
});
