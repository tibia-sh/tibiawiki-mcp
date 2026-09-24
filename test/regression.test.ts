import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB_PATH } from '@tibia.sh/tibiawiki-data';
import { connect } from './harness.ts';
import { coerceAttribute } from '../src/domain.ts';

// Regression: item_attribute is TEXT and the "numeric" attributes are not always
// integers. Three active items carry a bonus suffix (Moonsilver Axe defense "33 +3").
// Number() made those NaN, which the SDK-enforced outputSchema rejects, turning a
// legitimate lookup - and an entire page of find_items - into an error.
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
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'Moonsilver Axe' },
  });
  assert.notEqual(res.isError, true, `expected success, got: ${JSON.stringify(res.content)}`);
  assert.equal((res.structuredContent as any).attributes.defense, '33 +3');
  await h.close();
});

test('tibia_find_items returns a page containing a suffixed stat', async () => {
  const h = await connect();
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
  const h = await connect();
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

// Regression: `hitpoints = 0` in the source data means "unrecorded", not "no health".
// 34 creatures carry 0 hp beside a real experience value - Phosphorus (Final) has
// 16,000,000 exp - so a range filter that takes 0 literally buries real answers under
// unknowns: hitpoints_max 100 matched 637 creatures where only 204 are real.
// experience = 0 is deliberately NOT treated this way: 295 creatures genuinely award none.
test('unrecorded hitpoints are reported as null, not as zero', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_get', arguments: { name: 'The Rootkraken' },
  });
  const data = res.structuredContent as any;
  assert.equal(data.hitpoints, null, '0 hp must not be presented as a real value');
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
  for (const r of data.results) {
    assert.notEqual(r.hitpoints, 0, `${r.title} reported hitpoints 0`);
  }
  await h.close();
});

test('experience 0 is still treated as real data', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { experience_max: 0, limit: 5 },
  });
  // Not asserting non-empty: the point is that experience is not nullif'd away,
  // so a zero-experience creature remains reachable by an experience filter.
  const data = res.structuredContent as any;
  assert.ok(Array.isArray(data.results));
  for (const r of data.results) assert.equal(r.experience, 0);
  await h.close();
});
