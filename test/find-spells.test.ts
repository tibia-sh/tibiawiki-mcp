import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from '@modelcontextprotocol/client';
import { SPELL_ELEMENTS } from '../src/domain.ts';
import { connect, FIXTURE } from './harness.ts';

type Spell = {
  title: string; words: string | null; spellType: string | null; group: string | null;
  element: string | null; level: number | null; mana: number | null; vocations: string[];
  isPremium: boolean | null; isPromotion: boolean | null;
};
type Page = { results: Spell[]; totalMatches: number; nextCursor?: string; indexGeneratedAt: string };

async function find(client: Client, args: Record<string, unknown>): Promise<Page> {
  const res = await client.callTool({ name: 'tibia_find_spells', arguments: args });
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  return res.structuredContent as Page;
}

/** Every page of a query, walked through nextCursor with a small limit. */
async function findAll(client: Client, args: Record<string, unknown>): Promise<Spell[]> {
  const all: Spell[] = [];
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

test('healing spells a level 30 druid can cast include Light Healing', async () => {
  const h = await connect();
  try {
    const data = await find(h.client, {
      vocation: 'druid', group: 'healing', level_max: 30, limit: 100,
    });
    // Non-empty first: a universal assertion over an empty array passes vacuously.
    assert.ok(data.results.length >= 2, `expected >=2 matches, got ${data.results.length}`);
    const light = data.results.find((r) => r.title === 'Light Healing');
    assert.ok(light, 'Light Healing is a level 8 druid healing spell');
    assert.equal(light.level, 8);
    for (const r of data.results) {
      assert.ok(r.vocations.includes('druid'), `${r.title} vocations=${r.vocations}`);
      assert.ok(r.level !== null && r.level <= 30, `${r.title} level=${r.level}`);
      assert.equal(r.group, 'Healing', `${r.title}: the output keeps the wiki's capitals`);
    }
    assert.equal(data.totalMatches, data.results.length);
  } finally {
    await h.close();
  }
});

test('an element filter matches the capitalised column case-insensitively', async () => {
  const h = await connect();
  try {
    const found = await findAll(h.client, { element: 'fire', limit: 5 });
    assert.ok(found.length >= 2, `expected >=2 fire spells, got ${found.length}`);
    for (const r of found) assert.equal(r.element, 'Fire', r.title);
    const expected = fixtureTitles(
      "select title from spell where element = 'Fire' and status = 'active'",
    );
    assert.deepEqual(found.map((r) => r.title).sort(), expected.sort());
  } finally {
    await h.close();
  }
});

test('spell_type and is_premium filter the results', async () => {
  const h = await connect();
  try {
    const runes = await findAll(h.client, { spell_type: 'rune', limit: 100 });
    assert.ok(runes.length > 0);
    for (const r of runes) assert.equal(r.spellType, 'Rune', r.title);
    const free = await findAll(h.client, { is_premium: false, limit: 100 });
    assert.ok(free.length > 0);
    for (const r of free) assert.equal(r.isPremium, false, r.title);
  } finally {
    await h.close();
  }
});

test('the spell elements are exactly the ones the spell table holds', () => {
  const db = new DatabaseSync(FIXTURE, { readOnly: true });
  try {
    const held = (db.prepare(
      'select distinct lower(element) e from spell where element is not null order by e',
    ).all() as Array<{ e: string }>).map((r) => r.e);
    assert.deepEqual([...SPELL_ELEMENTS].sort(), held);
  } finally {
    db.close();
  }
});

test('the level sort is the default and ascends, with ties by title', async () => {
  const h = await connect();
  try {
    const byDefault = await findAll(h.client, { limit: 100 });
    const byLevel = await findAll(h.client, { sort: 'level', limit: 100 });
    assert.deepEqual(byDefault.map((r) => r.title), byLevel.map((r) => r.title));
    let ties = 0;
    for (let i = 1; i < byLevel.length; i++) {
      const [a, b] = [byLevel[i - 1]!, byLevel[i]!];
      assert.ok(a.level! <= b.level!, `${a.title} (${a.level}) before ${b.title} (${b.level})`);
      if (a.level === b.level) {
        ties++;
        assert.ok(a.title < b.title, `tie at level ${a.level}: ${a.title} before ${b.title}`);
      }
    }
    assert.ok(ties > 0, 'guard: the fixture must hold level ties for the tie-break to be tested');
  } finally {
    await h.close();
  }
});

test('the mana sort ascends, with ties by title', async () => {
  const h = await connect();
  try {
    const found = await findAll(h.client, { sort: 'mana', limit: 100 });
    let ties = 0;
    for (let i = 1; i < found.length; i++) {
      const [a, b] = [found[i - 1]!, found[i]!];
      assert.ok(a.mana! <= b.mana!, `${a.title} (${a.mana}) before ${b.title} (${b.mana})`);
      if (a.mana === b.mana) {
        ties++;
        assert.ok(a.title < b.title, `tie at mana ${a.mana}: ${a.title} before ${b.title}`);
      }
    }
    assert.ok(ties > 0, 'guard: the fixture must hold mana ties for the tie-break to be tested');
  } finally {
    await h.close();
  }
});

test('the title sort ascends', async () => {
  const h = await connect();
  try {
    const found = await findAll(h.client, { sort: 'title', limit: 100 });
    for (let i = 1; i < found.length; i++) {
      assert.ok(found[i - 1]!.title < found[i]!.title, `${found[i - 1]!.title} before ${found[i]!.title}`);
    }
  } finally {
    await h.close();
  }
});

test('paging to the end gives every match once, with no gaps', async () => {
  const h = await connect();
  try {
    const first = await find(h.client, { limit: 7 });
    assert.equal(first.results.length, 7);
    assert.ok(first.nextCursor, 'expected a nextCursor with more than one page');
    const found = await findAll(h.client, { limit: 7 });
    const titles = found.map((r) => r.title);
    assert.equal(new Set(titles).size, titles.length, 'no spell appears twice');
    assert.equal(titles.length, first.totalMatches);
    const expected = fixtureTitles("select title from spell where status = 'active'");
    assert.deepEqual([...titles].sort(), expected.sort());
  } finally {
    await h.close();
  }
});

test('non-active spells are excluded by default', async () => {
  const h = await connect();
  try {
    const off = await find(h.client, {});
    const on = await find(h.client, { include_inactive: true });
    assert.ok(on.totalMatches > off.totalMatches, `${off.totalMatches} -> ${on.totalMatches}`);
  } finally {
    await h.close();
  }
});

test('an input outside its enum is a schema error', async () => {
  const h = await connect();
  try {
    for (const bad of [
      { vocation: 'mage' }, { group: 'summon' }, { group: 'Healing' }, { element: 'lava' },
      { spell_type: 'wand' }, { spell_type: 'Rune' }, { sort: 'rowid' }, { level_max: -1 },
    ]) {
      const res = await h.client.callTool({ name: 'tibia_find_spells', arguments: bad });
      assert.equal(res.isError, true, `${JSON.stringify(bad)} must be rejected`);
      assert.match(JSON.stringify(res.content), /validation/i, JSON.stringify(res.content));
    }
  } finally {
    await h.close();
  }
});

test('healing is not a spell element, and the error names the valid ones', async () => {
  const h = await connect();
  try {
    const res = await h.client.callTool({ name: 'tibia_find_spells', arguments: { element: 'healing' } });
    assert.equal(res.isError, true);
    const text = JSON.stringify(res.content);
    for (const e of SPELL_ELEMENTS) assert.ok(text.includes(e), `${e} is named in ${text}`);
  } finally {
    await h.close();
  }
});
