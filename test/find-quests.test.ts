import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { asciiLower } from '../src/domain.ts';
import { connect, connectTo, FIXTURE, tempDirs } from './harness.ts';

type Quest = {
  title: string; location: string | null; levelRequired: number | null;
  levelRecommended: number | null; isPremium: boolean | null; estimatedTime: string | null;
  rewards: string[];
};
type Page = { results: Quest[]; totalMatches: number; nextCursor?: string; indexGeneratedAt: string };

const scratch = tempDirs('twmcp-fq-');

async function find(client: Client, args: Record<string, unknown>): Promise<Page> {
  const res = await client.callTool({ name: 'tibia_find_quests', arguments: args });
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Page;
}

/** Every page of a query, walked through nextCursor. */
async function findAll(client: Client, args: Record<string, unknown>): Promise<Quest[]> {
  const all: Quest[] = [];
  let cursor: string | undefined;
  do {
    const page = await find(client, { ...args, ...(cursor ? { cursor } : {}) });
    all.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

function fixtureTitles(sql: string): string[] {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  try {
    return (db.prepare(sql).all() as Array<{ title: string }>).map((r) => r.title);
  } finally {
    db.close();
  }
}

const titlesOf = (quests: Quest[]): string[] => quests.map((q) => q.title).sort();

/** A scratch copy of the fixture with `sql` applied, for rows the fixture does not hold. */
function fixtureWith(sql: string): string {
  const path = join(scratch(), 'quests.db');
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  return path;
}

/**
 * Asserts `key` ascends with nulls in one tail, and ties by title as the nocase
 * collation orders it. Returns how many nulls and ties it saw, for the callers' guards.
 */
function assertAscendingNullsLast(
  found: Quest[], key: 'levelRequired' | 'levelRecommended',
): { nulls: number; ties: number } {
  const firstNull = found.findIndex((q) => q[key] === null);
  const tail = firstNull === -1 ? [] : found.slice(firstNull);
  for (const q of tail) assert.equal(q[key], null, `${q.title} (${q[key]}) after a null ${key}`);
  const head = firstNull === -1 ? found : found.slice(0, firstNull);
  let ties = 0;
  for (let i = 1; i < head.length; i++) {
    const [a, b] = [head[i - 1]!, head[i]!];
    assert.ok(a[key]! <= b[key]!, `${a.title} (${a[key]}) before ${b.title} (${b[key]})`);
    if (a[key] === b[key]) {
      ties++;
      assert.ok(asciiLower(a.title) < asciiLower(b.title), `tie at ${a[key]}: ${a.title} before ${b.title}`);
    }
  }
  for (let i = 1; i < tail.length; i++) {
    assert.ok(asciiLower(tail[i - 1]!.title) < asciiLower(tail[i]!.title), 'null ties by title');
  }
  return { nulls: tail.length, ties };
}

test('quests up to level 20 include Edron Goblin Quest with its Steel Shield', async () => {
  const h = await connect();
  try {
    const found = await findAll(h.client, { level_max: 20, limit: 100 });
    const edron = found.find((q) => q.title === 'Edron Goblin Quest');
    assert.ok(edron, 'Edron Goblin Quest requires no level');
    assert.equal(edron.levelRequired, 0);
    assert.equal(edron.levelRecommended, 15);
    assert.equal(edron.location, 'Edron Goblin Cave, west of town');
    assert.equal(edron.isPremium, true);
    assert.equal(edron.estimatedTime, '15 minutes');
    assert.ok(edron.rewards.includes('Steel Shield'), `rewards: ${edron.rewards}`);
    for (const q of found) {
      assert.ok(q.levelRequired === null || q.levelRequired <= 20, `${q.title} requires ${q.levelRequired}`);
    }
    // Exclusion: quests that need more than level 20 are left out.
    const expected = fixtureTitles(
      "select title from quest where coalesce(level_required, 0) <= 20 and status = 'active'",
    );
    assert.deepEqual(titlesOf(found), expected.sort());
    const harder = fixtureTitles('select title from quest where level_required > 20');
    assert.ok(harder.length > 0, 'guard: the fixture holds quests above level 20');
    for (const title of harder) assert.ok(!found.some((q) => q.title === title), `${title} is left out`);
  } finally {
    await h.close();
  }
});

test('a quest with no recorded level requirement matches any level_max', async () => {
  const h = await connectTo(fixtureWith(
    "update quest set level_required = null where title = 'The Lightbearer'",
  ));
  try {
    const found = await findAll(h.client, { level_max: 0, limit: 100 });
    for (const q of found) {
      assert.ok(q.levelRequired === null || q.levelRequired === 0, `${q.title} requires ${q.levelRequired}`);
    }
    assert.ok(found.some((q) => q.title === 'The Lightbearer'), 'a null requirement counts as none');
    assert.ok(found.some((q) => q.levelRequired === 0), 'a zero requirement counts as none');
  } finally {
    await h.close();
  }
});

test('rewards are item titles, each listed once, in title order', async () => {
  const h = await connect();
  try {
    const found = await findAll(h.client, { limit: 100 });
    // The Lightbearer holds Ring of Healing twice in quest_reward.
    const lightbearer = found.find((q) => q.title === 'The Lightbearer');
    assert.ok(lightbearer);
    assert.equal(lightbearer.rewards.filter((r) => r === 'Ring of Healing').length, 1);
    const db = new DatabaseSync(FIXTURE, { readOnly: true });
    try {
      const expected = (db.prepare(
        `select distinct i.title from quest_reward r join item i on i.article_id = r.item_id
         join quest q on q.article_id = r.quest_id where q.title = 'The Lightbearer'`,
      ).all() as Array<{ title: string }>).map((r) => r.title);
      assert.ok(expected.length >= 2, 'guard: The Lightbearer has several rewards');
      assert.deepEqual([...lightbearer.rewards].sort(), expected.sort());
    } finally {
      db.close();
    }
    for (const q of found) {
      for (let i = 1; i < q.rewards.length; i++) {
        assert.ok(asciiLower(q.rewards[i - 1]!) < asciiLower(q.rewards[i]!), `${q.title}: ${q.rewards}`);
      }
    }
  } finally {
    await h.close();
  }
});

test('location_contains matches a literal substring, case-insensitively', async () => {
  const h = await connect();
  try {
    const found = await findAll(h.client, { location_contains: 'EDRON', limit: 100 });
    assert.ok(found.some((q) => q.title === 'Edron Goblin Quest'));
    for (const q of found) assert.ok(asciiLower(q.location!).includes('edron'), `${q.title}: ${q.location}`);
    const expected = fixtureTitles(
      "select title from quest where lower(location) like '%edron%' and status = 'active'",
    );
    assert.deepEqual(titlesOf(found), expected.sort());
    assert.ok(expected.length < fixtureTitles('select title from quest').length, 'guard: some quests are elsewhere');
    // No fixture location holds % or _, so as wildcards they would match every quest.
    for (const wildcard of ['%', '_', '\\']) {
      const page = await find(h.client, { location_contains: wildcard });
      assert.equal(page.totalMatches, 0, `${wildcard} is literal`);
    }
  } finally {
    await h.close();
  }
});

test('is_premium and is_rookgaard filter both ways', async () => {
  const h = await connect();
  try {
    for (const [args, sql] of [
      [{ is_premium: true }, 'is_premium = 1'],
      [{ is_premium: false }, 'is_premium = 0'],
      [{ is_rookgaard: true }, 'is_rookgaard_quest = 1'],
      [{ is_rookgaard: false }, 'is_rookgaard_quest = 0'],
    ] as const) {
      const found = await findAll(h.client, { ...args, limit: 100 });
      const expected = fixtureTitles(`select title from quest where ${sql} and status = 'active'`);
      assert.ok(expected.length > 0, `guard: the fixture holds quests with ${sql}`);
      assert.deepEqual(titlesOf(found), expected.sort(), JSON.stringify(args));
    }
    for (const q of await findAll(h.client, { is_premium: false, limit: 100 })) {
      assert.equal(q.isPremium, false, q.title);
    }
  } finally {
    await h.close();
  }
});

test('the recommended level sort is the default, ascends, and puts unknown levels last', async () => {
  const h = await connect();
  try {
    const byDefault = await findAll(h.client, { limit: 7 });
    const byRecommended = await findAll(h.client, { sort: 'level_recommended', limit: 100 });
    assert.deepEqual(byDefault.map((q) => q.title), byRecommended.map((q) => q.title));
    const { nulls, ties } = assertAscendingNullsLast(byRecommended, 'levelRecommended');
    assert.ok(nulls >= 1, 'guard: the fixture holds quests with no recommended level');
    assert.ok(ties > 0, 'guard: the fixture holds recommended level ties');
    assert.equal(byRecommended.at(-1)!.levelRecommended, null, 'the last quest has no recommended level');
  } finally {
    await h.close();
  }
});

test('the required level sort ascends and puts unknown levels last', async () => {
  // The fixture has no quest without a required level, so this copy gains one.
  const h = await connectTo(fixtureWith(
    "update quest set level_required = null where title = 'Edron Goblin Quest'",
  ));
  try {
    const found = await findAll(h.client, { sort: 'level_required', limit: 100 });
    const { nulls, ties } = assertAscendingNullsLast(found, 'levelRequired');
    assert.equal(nulls, 1);
    assert.ok(ties > 0, 'guard: the fixture holds required level ties');
    assert.equal(found.at(-1)!.title, 'Edron Goblin Quest');
  } finally {
    await h.close();
  }
});

test('the title sort ascends', async () => {
  const h = await connect();
  try {
    const found = await findAll(h.client, { sort: 'title', limit: 100 });
    assert.ok(found.length > 1);
    for (let i = 1; i < found.length; i++) {
      const [a, b] = [found[i - 1]!.title, found[i]!.title];
      assert.ok(asciiLower(a) < asciiLower(b), `${a} before ${b}`);
    }
  } finally {
    await h.close();
  }
});

test('paging to the end gives every quest once, with no gaps', async () => {
  const h = await connect();
  try {
    const first = await find(h.client, { limit: 7 });
    assert.equal(first.results.length, 7);
    assert.ok(first.nextCursor, 'expected a nextCursor with more than one page');
    const found = await findAll(h.client, { limit: 7 });
    const titles = found.map((q) => q.title);
    assert.equal(new Set(titles).size, titles.length, 'no quest appears twice');
    assert.equal(titles.length, first.totalMatches);
    assert.deepEqual([...titles].sort(), fixtureTitles("select title from quest where status = 'active'").sort());
    assert.equal(typeof first.indexGeneratedAt, 'string');
  } finally {
    await h.close();
  }
});

test('non-active quests are excluded by default', async () => {
  const h = await connectTo(fixtureWith(
    "update quest set status = 'deprecated' where title = 'Edron Goblin Quest'",
  ));
  try {
    const off = await findAll(h.client, { limit: 100 });
    const on = await findAll(h.client, { include_inactive: true, limit: 100 });
    assert.ok(!off.some((q) => q.title === 'Edron Goblin Quest'));
    assert.ok(on.some((q) => q.title === 'Edron Goblin Quest'));
    assert.equal(on.length, off.length + 1);
  } finally {
    await h.close();
  }
});

test('an input outside its schema is a schema error', async () => {
  const h = await connect();
  try {
    for (const bad of [{ sort: 'rowid' }, { sort: 'level' }, { location_contains: '' }, { limit: 101 }]) {
      const res = await h.client.callTool({ name: 'tibia_find_quests', arguments: bad });
      assert.equal(res.isError, true, `${JSON.stringify(bad)} must be rejected`);
      assert.match(JSON.stringify(res.content), /validation/i, JSON.stringify(res.content));
    }
  } finally {
    await h.close();
  }
});
