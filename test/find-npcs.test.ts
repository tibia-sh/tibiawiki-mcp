import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { connect, FIXTURE } from './harness.ts';

type Npc = {
  title: string; articleId: number; city: string | null; jobs: string[];
  position: { x: number | null; y: number | null; z: number | null };
};
type Page = { results: Npc[]; totalMatches: number; nextCursor?: string; indexGeneratedAt: string };

async function find(client: Client, args: Record<string, unknown>): Promise<Page> {
  const res = await client.callTool({ name: 'tibia_find_npcs', arguments: args });
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Page;
}

/** Every page of a query, walked through nextCursor, each page's total checked. */
async function findAll(client: Client, args: Record<string, unknown>): Promise<{ rows: Npc[]; pages: number }> {
  const rows: Npc[] = [];
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

/** The titles of the fixture's NPCs matching `where`, alias `n`, in title order. */
function titles(where: string): string[] {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  try {
    return db.prepare(`select n.title from npc n where ${where} order by n.title collate nocase`)
      .all().map((r) => String(r.title));
  } finally {
    db.close();
  }
}

// Eighteen NPCs in eighteen places buy Small Amethyst in the fixture, two of them in
// Liberty Bay.
test('the NPCs in a city that buy an item', async () => {
  const h = await connect();
  try {
    const page = await find(h.client, { city: 'liberty bay', buys: 'Small Amethyst' });
    assert.deepEqual(page.results.map((n) => n.title), ['Augustin', 'Chantalle']);
    assert.equal(page.totalMatches, 2);
    for (const n of page.results) {
      assert.equal(n.city, 'Liberty Bay');
      assert.ok(n.position.x !== null, `${n.title} has a position`);
    }
    const all = await find(h.client, { buys: 'small amethyst' });
    assert.ok(all.totalMatches > 10, 'guard: buyers elsewhere too');
    assert.deepEqual(all.results.find((n) => n.title === 'Augustin')?.jobs, ['Jewelry Shopkeeper']);
    const sellers = await find(h.client, { city: 'Liberty Bay', sells: 'Small Amethyst' });
    assert.deepEqual(sellers.results.map((n) => n.title), titles(
      `n.city = 'Liberty Bay' and exists (select 1 from npc_offer_sell o join item i
         on i.article_id = o.item_id where o.npc_id = n.article_id and i.title = 'Small Amethyst')`,
    ));
  } finally {
    await h.close();
  }
});

test('paging NPCs by title ends without a cursor, losing and repeating none', async () => {
  const expected = titles("n.status = 'active'");
  const h = await connect();
  try {
    const { rows, pages } = await findAll(h.client, { limit: 40 });
    assert.equal(pages, Math.ceil(expected.length / 40));
    assert.ok(pages > 1, 'guard: the fixture\'s NPCs span several pages of 40');
    assert.deepEqual(rows.map((n) => n.title), expected);
  } finally {
    await h.close();
  }
});

// The wiki records Svargrond for Rashid, who moves city every day, so a city filter that
// read the column would list him there with a null city. He matches no city instead.
test('Rashid matches no city, and his row has no city or position', async () => {
  const h = await connect();
  try {
    const svargrond = await find(h.client, { city: 'Svargrond', limit: 100 });
    assert.ok(svargrond.totalMatches > 0, 'guard: other NPCs live in Svargrond');
    assert.ok(!svargrond.results.some((n) => n.title === 'Rashid'));
    for (const n of svargrond.results) assert.equal(n.city, 'Svargrond', n.title);
    assert.equal((await find(h.client, { city: 'Svargrond', buys: 'Berserker' })).totalMatches, 0);

    const buyers = await find(h.client, { buys: 'Berserker' });
    assert.deepEqual(buyers.results.map((n) => n.title), ['Rashid']);
    assert.equal(buyers.results[0]!.city, null);
    assert.deepEqual(buyers.results[0]!.position, { x: null, y: null, z: null });
  } finally {
    await h.close();
  }
});

// Yasir is an event NPC who buys active items. Arrow (Weak) is a ts-only item NPCs sell.
test('include_inactive reads the NPC\'s status, and the item\'s for buys and sells', async () => {
  const h = await connect();
  try {
    const merchants = await find(h.client, { job: 'merchant', limit: 100 });
    assert.ok(merchants.totalMatches > 0, 'guard: active merchants');
    assert.ok(!merchants.results.some((n) => n.title === 'Yasir'));
    for (const n of merchants.results) assert.ok(n.jobs.includes('Merchant'), n.title);
    const everyMerchant = await find(h.client, { job: 'Merchant', include_inactive: true, limit: 100 });
    assert.ok(everyMerchant.results.some((n) => n.title === 'Yasir'));

    assert.equal((await find(h.client, { sells: 'Arrow (Weak)' })).totalMatches, 0);
    const arrowSellers = await find(h.client, { sells: 'Arrow (Weak)', include_inactive: true });
    assert.deepEqual(arrowSellers.results.map((n) => n.title), titles(
      `exists (select 1 from npc_offer_sell o join item i on i.article_id = o.item_id
         where o.npc_id = n.article_id and i.title = 'Arrow (Weak)')`,
    ));
  } finally {
    await h.close();
  }
});
