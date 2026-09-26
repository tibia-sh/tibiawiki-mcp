import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { connect, connectTo, FIXTURE, tempDirs, withRealIndex } from './harness.ts';

const scratch = tempDirs('twmcp-detail-');

const get = async (h: Awaited<ReturnType<typeof connect>>, name: string, type?: string, verbosity?: string) => {
  const res = await h.client.callTool({
    name: 'tibia_get',
    arguments: { name, ...(type ? { type } : {}), ...(verbosity ? { verbosity } : {}) },
  });
  assert.notEqual(res.isError, true, `${name}: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Record<string, any>;
};

test('a creature carries its abilities with damage ranges', async () => {
  const h = await connect();
  const dragon = await get(h, 'Dragon');
  assert.equal(dragon.abilities.length, 4);
  const fireball = dragon.abilities.find((a: any) => a.name === 'Great Fireball');
  assert.ok(fireball, `got ${JSON.stringify(dragon.abilities.map((a: any) => a.name))}`);
  assert.equal(fireball.effect, '60-140');
  assert.equal(fireball.element, 'fire');
  await h.close();
});

test('a creature carries how it behaves', async () => {
  const h = await connect();
  const dragon = await get(h, 'Dragon');
  assert.equal(dragon.runsAt, 300);
  assert.equal(dragon.seesInvisible, true);
  assert.equal(dragon.paralysable, true);
  assert.equal(dragon.pushable, false);
  assert.equal(dragon.pushObjects, true);
  assert.equal(dragon.illusionable, true);
  assert.equal(dragon.summonCost, 0);
  assert.equal(dragon.convinceCost, 0);
  assert.equal(dragon.bestiaryLevel, 'Medium');
  const rotworm = await get(h, 'Rotworm');
  assert.equal(rotworm.convinceCost, 305);
  assert.equal(rotworm.summonCost, 0);
  // The wiki records no flee threshold for Rotworm.
  assert.equal(rotworm.runsAt, null);
  await h.close();
});

// (creature_id, name) is NOT unique - The Plasmother has three rows all named
// 'Poison Ball'. A join keyed on name alone would collapse them.
test('duplicate ability names are all returned, not collapsed', async () => {
  const h = await connect();
  const c = await get(h, 'The Plasmother');
  const poison = c.abilities.filter((a: any) => a.name === 'Poison Ball');
  assert.equal(poison.length, 3, `got ${JSON.stringify(c.abilities.map((a: any) => a.name))}`);
  // The ordering must be total, or the set is non-deterministic across VACUUM.
  const keys = poison.map((a: any) => `${a.effect}|${a.element}`);
  assert.equal(new Set(keys).size, 3, 'the three rows should be distinguishable');
  await h.close();
});

test('a creature carries its max damage per element and total', async () => {
  const h = await connect();
  const dragon = await get(h, 'Dragon');
  assert.equal(dragon.maxDamage.fire, 310);
  assert.equal(dragon.maxDamage.physical, 120);
  assert.equal(dragon.maxDamage.total, 430);
  // creature_max_damage has no healing column; emitting one invented a field.
  assert.ok(!('healing' in dragon.maxDamage), 'no phantom healing key');
  // Sounds are part of the contract and were previously unasserted, so a mutation
  // replacing them with [] went unnoticed.
  assert.ok(Array.isArray(dragon.sounds));
  await h.close();
});

// Upstream stores -1 for "unknown", not negative damage.
test('unknown max damage is reported as null, not as -1', async () => {
  const h = await connect();
  // Sweep every creature the fixture holds rather than naming one, so this keeps
  // working if the fixture's sentinel-carrying creature changes.
  const search = await h.client.callTool({
    name: 'tibia_search', arguments: { query: 'a', types: ['creature'], limit: 100 },
  });
  const titles = (search.structuredContent as any).results.map((r: any) => r.title);
  assert.ok(titles.length > 0, 'guard: the fixture must hold creatures');
  let checked = 0;
  for (const title of titles) {
    const c = await get(h, title, 'creature');
    if (!c.maxDamage) continue;
    checked += 1;
    for (const [k, v] of Object.entries(c.maxDamage)) {
      assert.notEqual(v, -1, `${title}.${k} leaked the unknown sentinel`);
    }
  }
  assert.ok(checked > 0, 'guard: at least one creature must have a maxDamage row');
  // Cave Parrot is the fixture's sentinel carrier: without it the sweep proves nothing.
  const parrot = await get(h, 'Cave Parrot', 'creature');
  assert.equal(parrot.maxDamage.total, null, 'the -1 sentinel must surface as null');
  await h.close();
});

test('a creature with no max damage row returns null, not an error', async () => {
  const h = await connect();
  // Rotworm HAS a max-damage row, so the original subject never exercised this
  // path — and `x === null || typeof x === 'object'` is true of every value here,
  // making the assertion a tautology on top of that.
  const c = await get(h, 'Dragon Wrath');
  assert.equal(c.maxDamage, null, 'this creature has no creature_max_damage row');
  await h.close();
});

// item_key is one-to-many: Silver Key has 61 rows. A singular field read with
// .get() would silently drop all but one.
test('an item returns every key article that uses it', async () => {
  const h = await connect();
  const key = await get(h, 'Golden Key', 'item');
  // EXACT count: "> 1" passed while a mutation truncated every key list to two of
  // seven. A loose assertion on a one-to-many join hides exactly the loss it guards.
  assert.equal(key.keys.length, 7, 'Golden Key has seven key articles');
  assert.ok(key.keys.every((k: any) => typeof k.number === 'number'));
  await h.close();
});

test('an item returns its store offers and proficiency perks', async () => {
  const h = await connect();
  const potion = await get(h, 'Strong Mana Potion', 'item');
  assert.ok(potion.storeOffers.length > 0);
  assert.ok(potion.storeOffers.every((o: any) => typeof o.price === 'number' && o.currency));
  const bile = await get(h, 'Crypt Bile', 'item');
  assert.equal(bile.proficiencyPerks.length, 18, 'Crypt Bile has 18 proficiency perks');
  assert.ok(bile.proficiencyPerks.every((p: any) => typeof p.level === 'number'));
  await h.close();
});

test('an NPC returns its travel destinations with fares', async () => {
  const h = await connect();
  const captain = await get(h, 'Captain Bluebear', 'npc');
  assert.ok(captain.destinations.length > 0);
  assert.ok(captain.destinations.every((d: any) => typeof d.name === 'string'));
  // An OR lets a regression that empties npc_job alone slip through; both are known.
  assert.equal(captain.jobs.length, 1);
  assert.equal(captain.races.length, 1);
  await h.close();
});

// Harlow sails from Farmine and from Yalahar, so one recorded position and one city cannot say
// where each leg starts.
test('an NPC lists every recorded position and where each leg starts', async () => {
  const h = await connect();
  const harlow = await get(h, 'Harlow', 'npc');
  assert.deepEqual(harlow.positions, [
    { city: 'Farmine', subarea: 'Vengoth', geolabel: null, position: { x: 32856, y: 31548, z: 7 } },
    { city: 'Yalahar', subarea: 'Yalahar Trade Quarter', geolabel: null, position: { x: 32837, y: 31365, z: 7 } },
  ]);
  assert.deepEqual(harlow.position, harlow.positions[0]!.position);
  const notes = 'After mission 4 of the Blood Brothers Quest';
  assert.deepEqual(harlow.destinations, [
    { name: 'Vengoth', price: 100, origin: null, notes },
    { name: 'Yalahar', price: 50, origin: 'Farmine', notes },
  ]);
  await h.close();
});

// The schedule says which day Rashid is where, and positions are the wiki's coordinates for
// the places he stands, so he carries both.
test('Rashid keeps his schedule and also lists his seven positions', async () => {
  const h = await connect();
  const rashid = await get(h, 'Rashid', 'npc');
  assert.equal(rashid.rashidSchedule.length, 7);
  assert.deepEqual(rashid.positions.map((p: any) => p.city), [
    'Svargrond', 'Liberty Bay', 'Port Hope', 'Ankrahmun', 'Darashia', 'Edron', 'Carlin',
  ]);
  assert.deepEqual(rashid.positions[3]!, {
    city: 'Ankrahmun', subarea: null, geolabel: 'Ankrahmun', position: { x: 33069, y: 32886, z: 6 },
  });
  await h.close();
});

// rashid_position.day is an integer 0-6, useless to an agent without names.
test('Rashid returns a seven-day schedule with weekday names', async () => {
  const h = await connect();
  const rashid = await get(h, 'Rashid', 'npc');
  assert.equal(rashid.rashidSchedule.length, 7);
  const days = rashid.rashidSchedule.map((d: any) => d.day);
  // Asserting only that 'Monday' appears somewhere let a one-day shift through:
  // tibiawiki-sql documents day 0 as MONDAY, and starting the week at Sunday moved
  // every entry. Pin the order and a known city instead.
  assert.deepEqual(days, [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  ]);
  const monday = rashid.rashidSchedule.find((d: any) => d.day === 'Monday');
  assert.equal(monday.city, 'Svargrond', 'day 0 is Monday, and Rashid is in Svargrond');
  assert.ok(rashid.rashidSchedule.every((d: any) => typeof d.city === 'string'));
  await h.close();
});

test('a non-Rashid NPC has no schedule field rather than an empty one', async () => {
  const h = await connect();
  const other = await get(h, 'Captain Bluebear', 'npc');
  assert.equal(other.rashidSchedule, undefined);
  await h.close();
});

const getInactive = async (h: Awaited<ReturnType<typeof connect>>, name: string, type: string) => {
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name, type, include_inactive: true },
  });
  assert.notEqual(res.isError, true, `${name}: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Record<string, any>;
};

// npc_offer_buy is the player selling to the NPC. No other tool reads it.
test('an item lists the NPCs that buy it, highest price first, with where they stand', async () => {
  const h = await connect();
  const shield = await get(h, 'Dragon Shield', 'item');
  assert.deepEqual(shield.boughtBy, [
    {
      npc: "Nah'Bob", price: 4000, currency: 'Gold Coin',
      city: 'Darashia', position: { x: 33104, y: 32520, z: 2 },
    },
    {
      npc: 'Shanar', price: 360, currency: 'Gold Coin',
      city: "Ab'Dendriel", position: { x: 32659, y: 31657, z: 8 },
    },
    {
      npc: 'H.L.', price: 115, currency: 'Gold Coin',
      city: 'Venore', position: { x: 32643, y: 32212, z: 7 },
    },
  ]);
  await h.close();
});

// Rashid's recorded city is Svargrond, where he stands one day a week. Reporting him
// there would send a player to the wrong city on the other six.
test('Rashid buys with no city or position, since he travels', async () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  let item: string | undefined;
  try {
    const row = db.prepare(
      `select i.title from npc_offer_buy o
         join npc n on n.article_id = o.npc_id
         join item i on i.article_id = o.item_id
        where n.title = 'Rashid' and i.status = 'active'
        order by i.title limit 1`,
    ).get();
    item = row === undefined ? undefined : String(row.title);
  } finally {
    db.close();
  }
  assert.ok(item, 'the fixture holds an active item Rashid buys');
  const h = await connect();
  const rashid = (await get(h, item, 'item')).boughtBy.find((o: any) => o.npc === 'Rashid');
  assert.ok(rashid, `Rashid is among ${item}'s buyers`);
  assert.equal(rashid.city, null);
  assert.deepEqual(rashid.position, { x: null, y: null, z: null });
  await h.close();
});

test('an item carries its client ID, and null where the wiki records none', async () => {
  const h = await connect();
  assert.equal((await get(h, 'Dragon Shield', 'item')).clientId, 3416);
  // Mud is a liquid, and the wiki gives it no client ID.
  assert.equal((await get(h, 'Mud', 'item')).clientId, null);
  await h.close();
});

test('a creature carries the name, plural and article the game prints', async () => {
  const h = await connect();
  const dragon = await get(h, 'Dragon');
  assert.equal(dragon.name, 'dragon');
  assert.equal(dragon.plural, 'dragons');
  assert.equal(dragon.article, 'a');
  await h.close();
});

test('an item carries its in-game name and its stack and pickup flags', async () => {
  const h = await connect();
  const gold = await get(h, 'Gold Coin', 'item');
  assert.equal(gold.actualName, 'gold coin');
  // The wiki records no plural for Gold Coin.
  assert.equal(gold.plural, null);
  assert.equal(gold.isStackable, true);
  assert.equal(gold.isPickupable, true);
  assert.equal(gold.isImmobile, false);
  const ruby = await get(h, 'Small Ruby', 'item');
  assert.equal(ruby.plural, 'small rubies');
  assert.equal((await get(h, 'Dragon Shield', 'item')).isStackable, false);
  await h.close();
});

test('an in-game name differs from the title where the game prints another', () => withRealIndex(async (client) => {
  const res = await client.callTool({ name: 'tibia_get', arguments: { name: 'Lifefluid', type: 'item' } });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const lifefluid = res.structuredContent as Record<string, unknown>;
  assert.equal(lifefluid.actualName, 'vial of lifefluid');
  assert.equal(lifefluid.plural, 'vials of lifefluid');
}));

test('tibia_get takes page names only, and points to tibia_search for in-game names', () => withRealIndex(async (client) => {
  const res = await client.callTool({ name: 'tibia_get', arguments: { name: 'vial of lifefluid' } });
  assert.equal(res.isError, true);
  assert.match((res.content as Array<{ text: string }>)[0]!.text, /tibia_search/);
  const { tools } = await client.listTools();
  assert.match(tools.find((t) => t.name === 'tibia_get')?.description ?? '', /tibia_search[^.]*in-game name/);
}));

test('an immobile item that cannot be picked up says so', () => withRealIndex(async (client) => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let title: string | undefined;
  try {
    const row = db.prepare(
      `select title from item
        where is_immobile = 1 and is_pickupable = 0 and status = 'active'
        order by title limit 1`,
    ).get();
    title = row === undefined ? undefined : String(row.title);
  } finally {
    db.close();
  }
  assert.ok(title, 'the index holds an active immobile item');
  const res = await client.callTool({ name: 'tibia_get', arguments: { name: title, type: 'item' } });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const item = res.structuredContent as Record<string, unknown>;
  assert.equal(item.isImmobile, true);
  assert.equal(item.isPickupable, false);
}));

// Yasir is an event NPC. Fiona buys Demon Horn at the same price, so the tie also
// shows the NPC title breaking it.
test('an inactive buyer appears only with include_inactive', async () => {
  const h = await connect();
  const fiona = {
    npc: 'Fiona', price: 1000, currency: 'Gold Coin',
    city: 'Edron', position: { x: 33281, y: 31846, z: 5 },
  };
  assert.deepEqual((await get(h, 'Demon Horn', 'item')).boughtBy, [fiona]);
  assert.deepEqual((await getInactive(h, 'Demon Horn', 'item')).boughtBy, [
    fiona,
    {
      npc: 'Yasir', price: 1000, currency: 'Gold Coin',
      city: 'Carlin', position: { x: 32398, y: 31815, z: 6 },
    },
  ]);
  await h.close();
});

test('an NPC lists what it buys, by item title', async () => {
  const h = await connect();
  const nahBob = await get(h, "Nah'Bob", 'npc');
  assert.deepEqual(nahBob.buys, [
    { item: 'Broadsword', price: 500, currency: 'Gold Coin' },
    { item: 'Dragon Shield', price: 4000, currency: 'Gold Coin' },
    { item: 'Fire Axe', price: 8000, currency: 'Gold Coin' },
    { item: 'Fire Sword', price: 4000, currency: 'Gold Coin' },
    { item: 'Ice Rapier', price: 1000, currency: 'Gold Coin' },
    { item: 'Royal Helmet', price: 30000, currency: 'Gold Coin' },
  ]);
  assert.deepEqual(nahBob.sells, []);
  await h.close();
});

// Arrow (Weak) is a ts-only item that Xed, an active NPC, sells.
test('an NPC leaves out inactive items unless include_inactive is set', async () => {
  const h = await connect();
  const xed = await get(h, 'Xed', 'npc');
  assert.deepEqual(xed.sells, [{ item: 'Crossbow', price: 500, currency: 'Gold Coin' }]);
  assert.deepEqual(xed.buys, []);
  assert.deepEqual((await getInactive(h, 'Xed', 'npc')).sells, [
    { item: 'Arrow (Weak)', price: 3, currency: 'Gold Coin' },
    { item: 'Crossbow', price: 500, currency: 'Gold Coin' },
  ]);
  await h.close();
});

// quest_danger stores creature_id, not a name - it must be joined to be useful.
test('a quest returns its dangers as creature names and its rewards', async () => {
  const h = await connect();
  const q = await get(h, 'Forgotten Knowledge Quest', 'quest');
  assert.ok(q.dangers.length > 0);
  assert.ok(q.dangers.every((d: string) => typeof d === 'string' && d.length > 0),
    'dangers must be names, not ids');
  assert.equal(q.dangers.length, 60, 'Forgotten Knowledge Quest has 60 dangers');
  // This quest genuinely has no rewards upstream, so assert rewards on one that
  // does. `Array.isArray` passed while a mutation replaced rewards wholesale with
  // [] — assert content, not shape.
  const lightbearer = await get(h, 'The Lightbearer', 'quest');
  // quest_reward holds its Ring of Healing twice, but it is one reward.
  assert.equal(lightbearer.rewards.length, 7, 'The Lightbearer has 7 distinct rewards');
  assert.equal(lightbearer.rewards.filter((r: string) => r === 'Ring of Healing').length, 1);
  assert.ok(lightbearer.rewards.every((r: string) => typeof r === 'string' && r.length > 0));
  const found = await h.client.callTool({
    name: 'tibia_find_quests', arguments: { location_contains: lightbearer.location },
  });
  const listed = (found.structuredContent as { results: Array<{ title: string; rewards: string[] }> })
    .results.find((r) => r.title === 'The Lightbearer')!;
  assert.deepEqual(lightbearer.rewards, listed.rewards, 'both tools list the same rewards');
  await h.close();
});

// imbuement_material stores item_id + amount; the name needs a join.
test('an imbuement returns its materials with names and amounts', async () => {
  const h = await connect();
  const imb = await get(h, 'Powerful Reap', 'imbuement');
  assert.ok(imb.materials.length > 0);
  assert.ok(imb.materials.every((m: any) => typeof m.item === 'string' && typeof m.amount === 'number'));
  await h.close();
});

test('an outfit returns its unlocking quests', async () => {
  const h = await connect();
  const o = await get(h, 'Assassin Outfits', 'outfit');
  assert.ok(o.quests.length > 0);
  assert.ok(o.quests.every((q: any) => typeof q.quest === 'string'));
  await h.close();
});

test('an outfit carries its male and female client IDs, and a mount its client ID', async () => {
  const h = await connect();
  for (const [outfit, male, female] of [
    ['Assassin Outfits', 152, 156], ['Beggar Outfits', 153, 157],
  ] as const) {
    const o = await get(h, outfit, 'outfit');
    assert.deepEqual([o.maleClientId, o.femaleClientId], [male, female], outfit);
  }
  for (const [mount, clientId] of [['Donkey', 387], ['Racing Bird', 369]] as const) {
    assert.equal((await get(h, mount, 'mount')).clientId, clientId, mount);
  }
  await h.close();
});

test('a client ID the wiki does not record is null', async () => {
  // Every fixture outfit and mount has its client IDs, so this copy clears two.
  const path = join(scratch(), 'client-ids.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`update mount set client_id = null where title = 'Donkey';
      update outfit set male_client_id = null where title = 'Assassin Outfits'`);
  } finally {
    db.close();
  }
  const h = await connectTo(path);
  try {
    assert.equal((await get(h, 'Donkey', 'mount')).clientId, null);
    const assassin = await get(h, 'Assassin Outfits', 'outfit');
    assert.deepEqual([assassin.maleClientId, assassin.femaleClientId], [null, 156]);
  } finally {
    await h.close();
  }
});

test('quest.legend stays top-level at concise verbosity', async () => {
  const h = await connect();
  const q = await get(h, 'Forgotten Knowledge Quest', 'quest');
  assert.ok('legend' in q, 'legend is a shipped top-level field and must not move');
  await h.close();
});

test('book text is gated behind detailed verbosity', async () => {
  const h = await connect();
  assert.equal((await get(h, 'Goldfinger (Book)', 'book')).text, undefined);
  assert.ok(typeof (await get(h, 'Goldfinger (Book)', 'book', 'detailed')).text === 'string');
  await h.close();
});

/**
 * Durable guard for a class this project has hit three times: a BOOLEAN column
 * mapped with str() returns "0"/"1", which passes a string schema and is truthy,
 * so a client checking the flag gets the wrong answer. world.battleye and
 * quest.questLog both shipped that way. This sweeps every boolean-ish output field
 * rather than naming them one at a time.
 */
test('no boolean field is returned as a string', async () => {
  const h = await connect();
  const samples: ReadonlyArray<readonly [string, string]> = [
    ['Dragon', 'creature'], ['Magic Longsword', 'item'], ['Rashid', 'npc'],
    ['Forgotten Knowledge Quest', 'quest'], ['Light Healing', 'spell'],
    ['Backpack Tourist', 'achievement'], ["Warriors' Guildhall", 'house'],
    ['Powerful Reap', 'imbuement'], ['Adrenaline Burst', 'charm'],
    ['Donkey', 'mount'], ['Assassin Outfits', 'outfit'],
    ['Goldfinger (Book)', 'book'], ['Antica', 'world'], ['Updates/7.9', 'update'],
  ];
  const offenders: string[] = [];
  for (const [name, type] of samples) {
    const data = await get(h, name, type);
    for (const [key, value] of Object.entries(data)) {
      // A yes/no field must never arrive as the string "0" or "1".
      if (value === '0' || value === '1') offenders.push(`${type}.${key} = ${JSON.stringify(value)}`);
      if (/^(is|has)[A-Z]/.test(key) && typeof value === 'string') {
        offenders.push(`${type}.${key} is a string`);
      }
    }
  }
  await h.close();
  assert.deepEqual(offenders, [], 'these look like booleans returned as strings');
});
