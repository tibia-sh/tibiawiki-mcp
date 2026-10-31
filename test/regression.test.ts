import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { connect, connectTo, suffixedDefenseFixture, tempDirs, withRealIndex } from './harness.ts';
import { coerceAttribute } from '../src/domain.ts';

const scratch = tempDirs('twmcp-regression-');

// Regression: item_attribute is TEXT and the "numeric" attributes are not always
// integers. Through data 3.4.0 three active items carried a bonus suffix (Moonsilver Axe
// defense "33 +3"). Number() made those NaN, which the SDK-enforced outputSchema rejects,
// turning a legitimate lookup - and an entire page of find_items - into an error.
// From data 3.5.0 no index holds a suffixed value, so the tests below put one back on a
// copy of the fixture (see suffixedDefenseFixture).
test('coerceAttribute keeps a non-integer stat as its raw string', () => {
  assert.equal(coerceAttribute('defense', '40'), 40);
  assert.equal(coerceAttribute('defense', '33 +3'), '33 +3');
  assert.equal(coerceAttribute('weapon_type', 'Sword'), 'Sword');
  assert.ok(!Number.isNaN(coerceAttribute('defense', '33 +3') as number));
});

test('coerceAttribute reads a signed resistance or skill bonus as a number', () => {
  assert.equal(coerceAttribute('resistance_fire', '-8'), -8);
  assert.equal(coerceAttribute('resistance_life_drain', '20'), 20);
  assert.equal(coerceAttribute('magic_level', '+2'), 2);
  assert.equal(coerceAttribute('shielding', '-10'), -10);
});

test('tibia_get survives an item whose defense has a bonus suffix', async () => {
  const h = await connectTo(suffixedDefenseFixture(scratch()));
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'Moonsilver Axe' },
  });
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  assert.equal((res.structuredContent as any).attributes.defense, '33 +3');
  await h.close();
});

test('tibia_find_items returns a page containing a suffixed stat', async () => {
  const h = await connectTo(suffixedDefenseFixture(scratch()));
  const res = await h.client.callTool({
    name: 'tibia_find_items', arguments: { weapon_type: 'Axe', limit: 100 },
  });
  assert.notEqual(res.isError, true, `one bad row must not destroy the page: ${JSON.stringify(res.content)}`);
  const titles = (res.structuredContent as any).results.map((r: any) => r.title);
  assert.ok(titles.includes('Moonsilver Axe'), 'the suffixed item should still be returned');
  await h.close();
});

test('SQL filtering still matches a suffixed stat numerically', async () => {
  // SQLite casts '33 +3' to 33, so the filter stays consistent with the raw display.
  const h = await connectTo(suffixedDefenseFixture(scratch()));
  const res = await h.client.callTool({
    name: 'tibia_find_items', arguments: { defense_min: 33, weapon_type: 'Axe', limit: 100 },
  });
  const titles = (res.structuredContent as any).results.map((r: any) => r.title);
  assert.ok(titles.includes('Moonsilver Axe'), `defense_min 33 should match "33 +3"; got ${JSON.stringify(titles)}`);
  await h.close();
});

// Regression: how_to_obtain returns the subject item whatever its status, so the
// status must be stated - otherwise a test-server-only item with 15 active vendors
// reads as perfectly obtainable.
test('tibia_how_to_obtain flags a non-active item that still has active sources', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Arrow (Weak)' },
  });
  const data = res.structuredContent as any;
  assert.equal(data.status, 'ts-only', 'the subject item status must be echoed');
  assert.ok(data.soldByNpcs.length > 0, 'guard: this item does have active vendors');
  assert.match(data.note, /not obtainable/i, 'the note must contradict the vendor list');
  await h.close();
});

test('tibia_how_to_obtain leaves the note empty for a normal active item', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_how_to_obtain', arguments: { item_name: 'Steel Helmet' },
  });
  const data = res.structuredContent as any;
  assert.equal(data.status, 'active');
  assert.equal(data.note, '');
  await h.close();
});

// Durable guard against value-shape drift in the source wiki: sweep the whole real
// index through the tools. It opens the packaged index directly rather than through the
// read resolution, so a stale index in a developer's cache cannot turn it red. In CI,
// where nothing is built, the read resolution names this same file.
test('every item in the full index satisfies the output schema', async () => {
  const { openDb } = await import('../src/db.ts');
  const { createServer } = await import('../src/server.ts');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');

  const handle = openDb(DB_PATH);
  const server = createServer(handle);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'sweep', version: '1.0.0' });
  await client.connect(ct);

  const failures: string[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await client.callTool({
      name: 'tibia_find_items',
      arguments: { limit: 100, include_inactive: true, ...(cursor ? { cursor } : {}) },
    });
    if (res.isError) {
      failures.push(String(res.content?.[0]?.text).slice(0, 160));
      break;
    }
    cursor = res.structuredContent?.nextCursor;
  } while (cursor);

  await client.close();
  await server.close();
  handle.close();
  assert.deepEqual(failures, [], 'paging the full item catalogue must not hit a schema violation');
});

// Regression: through data 3.4.0 the generator stored an unrecorded `hitpoints` as 0, so
// the server read 0 as "unrecorded". From data 3.5.0 an unrecorded value is NULL and a 0
// is what the wiki gives, so both are reported as stored. The Rootkraken's hitpoints are
// unrecorded beside 700,000 experience.
test('unrecorded hitpoints are reported as null', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'The Rootkraken' },
  });
  const data = res.structuredContent as any;
  assert.equal(data.hitpoints, null, 'unrecorded hp must not be presented as a real value');
  assert.equal(data.experience, 700000, 'experience is real data and must survive');
  await h.close();
});

test('a hitpoints range filter excludes creatures whose hitpoints are unrecorded', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { hitpoints_max: 100000, limit: 100 },
  });
  const data = res.structuredContent as any;
  assert.ok(data.results.length > 0, 'guard: the filter must match something');
  const titles = data.results.map((r: any) => r.title);
  assert.ok(
    !titles.includes('The Rootkraken'),
    'a creature with unrecorded hitpoints must not satisfy hitpoints_max',
  );
  await h.close();
});

// Data 3.5.0 holds four creatures whose wiki pages give 0 hitpoints. The fixture keeps
// none, so this reads the full index.
test('a creature the wiki gives 0 hitpoints reports 0', () => withRealIndex(async (client) => {
  const res = await client.callTool({
    name: 'tibia_find_creatures', arguments: { hitpoints_max: 0, limit: 100 },
  });
  const results = (res.structuredContent as any).results as { title: string; hitpoints: number }[];
  for (const title of ['An Eye', 'Bone Bear', 'Destroyed Pillar', 'The Source of Corruption']) {
    const row = results.find((r) => r.title === title);
    assert.ok(row, `${title} must satisfy hitpoints_max 0`);
    assert.equal(row.hitpoints, 0, title);
  }
  const pillar = await client.callTool({ name: 'tibia_get', arguments: { name: 'Destroyed Pillar' } });
  assert.equal((pillar.structuredContent as any).hitpoints, 0);
}));

test('experience 0 is still treated as real data', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { experience_max: 0, limit: 5 },
  });
  // Not asserting non-empty: the point is that an experience of 0 is data, so a
  // zero-experience creature remains reachable by an experience filter.
  const data = res.structuredContent as any;
  assert.ok(Array.isArray(data.results));
  for (const r of data.results) assert.equal(r.experience, 0);
  await h.close();
});

// A race ID is not unique: boss phases share one (data 3.5.0 has nine races shared by
// active creatures, such as The Spellstealer's three phases). race_ids returns every
// creature holding a listed race, so the rows equal the database's own match.
test('race_ids returns every creature that shares a listed race', () => withRealIndex(async (client) => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let races: number[];
  let expected: string[];
  try {
    races = db.prepare(
      `select race_id from creature where race_id is not null and status = 'active'
        group by race_id having count(*) > 1`,
    ).all().map((r) => Number(r.race_id));
    assert.ok(races.length > 0, 'guard: some active creatures share a race');
    expected = db.prepare(
      `select title from creature where status = 'active'
          and race_id in (select value from json_each(?)) order by title`,
    ).all(JSON.stringify(races)).map((r) => String(r.title));
  } finally {
    db.close();
  }
  const res = await client.callTool({
    name: 'tibia_find_creatures', arguments: { race_ids: races, sort: 'title', limit: 100 },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as { results: Array<{ title: string }>; totalMatches: number };
  assert.ok(expected.length > races.length, 'guard: more creatures than races');
  assert.equal(data.totalMatches, expected.length);
  assert.deepEqual(data.results.map((r) => r.title), expected);
}));

// Census on data 3.5.0, as on 3.4.1: Gold Coin has 754 droppers by default and 809 with
// include_inactive: true, so droppedBy pages. Those counts are noted, not asserted: the
// invariant is that paging reaches every row the database holds for the filter, none lost
// and none repeated. Rootthing Nutshell drops Ruthless Axe twice in identical rows, and at
// a limit of 1 each lands on its own page, so both must come back.
test('paging droppedBy returns every drop row once, with and without inactive creatures', () =>
  withRealIndex(async (client) => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      for (const [item, limit] of [['Gold Coin', 100], ['Ruthless Axe', 1]] as const) {
        for (const include_inactive of [false, true]) {
          const expected = db.prepare(
            `select c.article_id, d.chance, d.min, d.max
               from creature_drop d join creature c on c.article_id = d.creature_id
              where d.item_id = (select article_id from item where title = ?)` +
              (include_inactive ? '' : " and c.status = 'active'"),
          ).all(item).map((r) => JSON.stringify([r.article_id, r.chance, r.min, r.max])).sort();
          const paged: string[] = [];
          let pages = 0;
          let cursor: string | undefined;
          do {
            const res = await client.callTool({
              name: 'tibia_how_to_obtain',
              arguments: { item_name: item, include_inactive, limit, ...(cursor ? { cursor } : {}) },
            });
            assert.notEqual(res.isError, true, JSON.stringify(res.content));
            const data = res.structuredContent as {
              droppedBy: Array<{ articleId: number; chance: number | null; min: number; max: number }>;
              droppedByTotal: number; nextCursor?: string;
            };
            assert.equal(data.droppedByTotal, expected.length, `${item} ${include_inactive}`);
            for (const d of data.droppedBy) paged.push(JSON.stringify([d.articleId, d.chance, d.min, d.max]));
            pages += 1;
            cursor = data.nextCursor;
          } while (cursor !== undefined);
          assert.ok(pages > 1, `guard: ${item} spans several pages of ${limit}`);
          assert.deepEqual(paged.sort(), expected, `${item} include_inactive: ${include_inactive}`);
        }
      }
      assert.ok(
        db.prepare(
          `select 1 from creature_drop d join creature c on c.article_id = d.creature_id
             join item i on i.article_id = d.item_id
            where i.title = 'Ruthless Axe' and c.title = 'Rootthing Nutshell'
            group by d.chance, d.min, d.max having count(*) > 1`,
        ).get(),
        'guard: Rootthing Nutshell drops Ruthless Axe in two identical rows',
      );
    } finally {
      db.close();
    }
  }));

// soldByNpcs and questRewards come whole on every page of droppedBy, so they must stay
// short. Their raw rows bound what the tool returns, which applies distinct and a status
// filter: on data 3.5.0 the most are 61 offers and 24 quests for one item.
test('no item has more than 100 vendor offers or quest rewards', () => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    for (const table of ['npc_offer_sell', 'quest_reward']) {
      const { most } = db.prepare(
        `select max(n) as most from (select count(*) as n from ${table} group by item_id)`,
      ).get() as { most: number };
      assert.ok(most > 0, `guard: ${table} holds rows`);
      assert.ok(most <= 100, `an item has ${most} rows in ${table}`);
    }
  } finally {
    db.close();
  }
});

// Census on data 3.5.0, from S0: Rashid buys 157 items by default and 197 with
// include_inactive: true, more than one page of 100. Those counts are noted, not asserted:
// the invariant is that paging reaches every distinct offer the database holds, none lost
// and none repeated. Offer rows are distinct, unlike droppers, so the expected multiset is
// the database's distinct rows.
test('paging Rashid\'s buy offers returns every distinct offer once', () =>
  withRealIndex(async (client) => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    let expected: string[];
    try {
      expected = db.prepare(
        `select distinct n.article_id as npc_id, i.article_id as item_id, o.value, c.title as currency
           from npc_offer_buy o join npc n on n.article_id = o.npc_id
           join item i on i.article_id = o.item_id join item c on c.article_id = o.currency_id
          where n.title = 'Rashid'`,
      ).all().map((r) => JSON.stringify([r.npc_id, r.item_id, r.value, r.currency])).sort();
    } finally {
      db.close();
    }
    const paged: string[] = [];
    let pages = 0;
    let cursor: string | undefined;
    do {
      const res = await client.callTool({
        name: 'tibia_find_offers',
        arguments: { npc: 'Rashid', direction: 'buy', include_inactive: true, ...(cursor ? { cursor } : {}) },
      });
      assert.notEqual(res.isError, true, JSON.stringify(res.content));
      const data = res.structuredContent as {
        results: Array<{ npcArticleId: number; itemArticleId: number; price: number; currency: string }>;
        totalMatches: number; nextCursor?: string;
      };
      assert.equal(data.totalMatches, expected.length);
      for (const o of data.results) {
        paged.push(JSON.stringify([o.npcArticleId, o.itemArticleId, o.price, o.currency]));
      }
      pages += 1;
      cursor = data.nextCursor;
    } while (cursor !== undefined);
    assert.ok(pages > 1, 'guard: Rashid\'s buy offers span several pages of 100');
    assert.deepEqual(paged.sort(), expected);
  }));
