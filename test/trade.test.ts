import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { openDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';

// The fixture keeps 12 of Rashid's buy offers and none of the offer tables' duplicate
// rows, so these tests open the real packaged index. They compare against the index
// itself rather than a count, which later data releases change.
async function withRealIndex<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const handle = openDb(DB_PATH);
  const server = createServer(handle);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'trade', version: '1.0.0' });
  await client.connect(ct);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
    handle.close();
  }
}

type Offer = { item: string; price: number; currency: string };

async function get(client: Client, args: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await client.callTool({ name: 'tibia_get', arguments: args });
  // The server validates structuredContent against the output schema and reports a
  // mismatch as an error, so a success here is also a schema check.
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Record<string, any>;
}

/** Rashid's buy offers straight from the index, one per item, price and currency. */
function rashidBuys(activeOnly: boolean): Offer[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const rows = db.prepare(
      `select i.title as item, o.value as price, c.title as currency
         from npc_offer_buy o
         join npc n on n.article_id = o.npc_id
         join item i on i.article_id = o.item_id
         join item c on c.article_id = o.currency_id
        where n.title = 'Rashid'` + (activeOnly ? ` and i.status = 'active'` : '') + `
        group by i.title, o.value, c.title`,
    ).all();
    return rows.map((r) => ({ item: String(r.item), price: Number(r.price), currency: String(r.currency) }));
  } finally {
    db.close();
  }
}

const key = (o: Offer) => `${o.item}\u0000${o.price}\u0000${o.currency}`;

function assertTradeList(actual: Offer[], expected: Offer[]) {
  const keys = actual.map(key);
  assert.equal(new Set(keys).size, keys.length, 'no offer is listed twice');
  for (let i = 1; i < actual.length; i++) {
    const [a, b] = [actual[i - 1]!, actual[i]!];
    assert.ok(a.item < b.item || (a.item === b.item && a.price <= b.price),
      `${key(a)} must come before ${key(b)}`);
  }
  assert.deepEqual([...keys].sort(), expected.map(key).sort());
}

test('Rashid lists every item he buys, once each, by title', () => withRealIndex(async (client) => {
  const all = rashidBuys(false);
  const active = rashidBuys(true);
  assert.ok(active.length < all.length, 'Rashid buys some inactive items');

  const rashid = await get(client, { name: 'Rashid', type: 'npc', include_inactive: true });
  assertTradeList(rashid.buys, all);
  assert.ok(rashid.buys.some((o: Offer) => o.item === 'Magic Plate Armor' && o.currency === 'Gold Coin'));

  const rashidActive = await get(client, { name: 'Rashid', type: 'npc' });
  assertTradeList(rashidActive.buys, active);
}));

// npc_offer_buy holds Alesar's offer for Earth Knight Axe twice, and npc_offer_sell
// holds Satsu's Cocktail Glass nine times.
test('a duplicated offer row is listed once', () => withRealIndex(async (client) => {
  const axe = await get(client, { name: 'Earth Knight Axe', type: 'item', include_inactive: true });
  assert.equal(axe.boughtBy.filter((o: { npc: string }) => o.npc === 'Alesar').length, 1);

  const satsu = await get(client, { name: 'Satsu', type: 'npc' });
  assert.equal(satsu.sells.filter((o: Offer) => o.item === 'Cocktail Glass').length, 1);
}));
